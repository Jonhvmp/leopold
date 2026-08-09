// Graph repair: a malformed plan is a decision, not a dead end.
//
// A route that points at an item nobody wrote, two items that point at each other — the
// validator names the defect and the run refuses to start. That refusal is correct about
// the graph and wrong about the situation: "item 2 routes to item 99, which does not
// exist" in a 10-item plan is a typo, and a typo is not a reason to hand the work back to
// a person who is not there. So Leopold SYNTHESIZES the role that fixes it — a plan
// engineer — lets that role propose the narrowest repair, and runs the proposal through
// the bounds amend.ts already enforces.
//
// WHAT THIS MAY DO, and it is deliberately almost nothing:
//
//   ROUTE <item> <cond> -> <n>   point a route the plan ALREADY declares at an item that
//                                exists. Never a new edge, never a new condition, never
//                                on an item marked done
//   ADD <text>                   append a plain work item, exactly the verb a @feedback
//                                node has
//
// and at most MAX_ADDED_ITEMS changes in total, judged by judgeAmendments — the ONE
// writer for those bounds. There is no second, looser repair path: a repair that wants a
// fourth change gets the same `add-budget` refusal a feedback node gets, logged with the
// bound that refused it.
//
// IT EITHER PRODUCES A VALID GRAPH OR IT NEVER TOUCHED THE PLAN. The repaired text is
// validated IN MEMORY and PLAN.md is opened for writing only once it validates. A repair
// that does not fix the graph leaves the file byte-identical, the run still refuses to
// start, and the refusal prints BOTH the original diagnostics and what the repair
// attempted — because "it tried and could not" is information, and a silent revert is
// the degrade-quietly failure this project does not ship.
//
// AND IT COSTS NOTHING ON A VALID PLAN. Nothing in this module runs unless validateGraph
// already produced a diagnostic: no persona, no model call, no read of PLAN.md beyond the
// one the pre-flight does anyway.

import fs from "node:fs";
import { query } from "./sdk.js";
import { parsePlan, type PlanItem } from "./plan.js";
import { buildGraph, validateGraph, type GraphDiagnostic } from "./graph.js";
import { preflightPlan, renderDiagnostics, type Preflight } from "./graph-cmd.js";
import {
  parseAmendments, judgeAmendments, MAX_ADDED_ITEMS,
  type AmendAccepted, type AmendProposal, type AmendRefused,
} from "./amend.js";
import {
  synthesizePersona, personaAppend, parseDecisionBlock, DECISION_BLOCK_INSTRUCTION,
  type Persona, type PersonaDecision,
} from "./persona.js";
import { logEvent, logPersonaDecision } from "./log.js";
import { writeState, readAmendmentsAdded } from "./config.js";
import { dispatchPlan, type RunRouting } from "./dispatch.js";
import { readSignals, emitSignal, BusContractError } from "./bus.js";
import type { Brief, DriverConfig, RunState } from "./types.js";

/** What the repair did, whether or not it worked. Everything a caller needs to print the
 *  attempt, log it, or hand it to a test — no console, no exceptions. */
export interface RepairAttempt {
  /** The role that took it. Undefined when synthesis failed; the repair is still tried,
   *  under the charter alone, exactly as an escalation is. */
  persona?: Persona;
  /** The diagnostics the repair was asked to fix. */
  before: GraphDiagnostic[];
  /** Everything the role proposed, as written. */
  proposals: AmendProposal[];
  /** The proposals that cleared every bound. Applied to PLAN.md only when `ok`. */
  accepted: AmendAccepted[];
  /** The proposals a bound refused, each carrying the bound that refused it. */
  refused: AmendRefused[];
  /** What the graph still says after the repair. Empty when the repair worked. */
  after: GraphDiagnostic[];
  /** The call the role made, for DECISIONS.md. Undefined when it stated none. */
  decision?: PersonaDecision;
  /** True only when the repair was applied AND the graph now validates. */
  ok: boolean;
}

/** How much room the model gets to read the plan it is repairing. A plan longer than
 *  this is a plan whose defect is not a typo. */
const MAX_PLAN_CHARS = 12000;

/** The system prompt the repair call runs under. Pure, so the framing is inspectable in
 *  a test — and it carries the synthesized role through `personaAppend`, the same one
 *  writer every other persona path uses. */
export function repairSystemPrompt(brief: Brief, persona?: Persona): string {
  return `You are Leopold, an autonomous orchestrator. The plan you were handed declares a graph that does not validate, so no agent has been dispatched. No human is coming to fix it: you repair it, now, with the smallest change that makes the graph sound.

You may propose ONLY these two things, and at most ${MAX_ADDED_ITEMS} of them in total:

  ROUTE <item> <condition> -> <target>   Point a route the plan ALREADY declares at an
                                         item that exists. <condition> must match the
                                         \`@on\` line as written; you are changing where it
                                         goes, never what it tests.
  ADD <text>                             Append one plain work item at the end of the plan.

You may NOT delete an item, edit an item's text, touch an item already marked [x], add a
node kind, or edit GUARDRAILS.md. Those are refused in code and the refusal is logged.

Repair the DEFECT the validator names, and nothing else. A route to an item that does not
exist is almost always a typo for an item that does — read the plan and work out which
item that route was meant to reach. A cycle is broken by pointing ONE of its routes
somewhere that ends the loop. If a diagnostic cannot be fixed within those two verbs, say
so and propose nothing for it: refusing to start is better than a plan that runs the wrong
way.

Respond with your proposals in ONE fenced block (exactly this shape, one per line):

\`\`\`leopold-amend
ROUTE 2 fail -> 7
ADD Write the rollback runbook
\`\`\`

${DECISION_BLOCK_INSTRUCTION}

=== MISSION ===
${brief.mission}

=== CHARTER (this is how this project decides; you are bound by it) ===
${brief.charter}${personaAppend(persona)}`;
}

/** The user turn of the repair call: the plan as written and every diagnostic. Pure. */
export function repairUserPrompt(planText: string, diagnostics: GraphDiagnostic[]): string {
  const plan = planText.length > MAX_PLAN_CHARS ? `${planText.slice(0, MAX_PLAN_CHARS)}\n…(truncated)` : planText;
  return `The plan's graph does not validate, so the run has not started.

=== WHAT THE VALIDATOR SAYS ===
${diagnostics.map((d) => `- [${d.code}] ${d.message}`).join("\n")}

=== PLAN.md, AS WRITTEN (items are numbered by their checkbox order, starting at 1) ===
${plan}

Propose the repair now.`;
}

/** The block printed when a repair did NOT produce a valid graph: the original
 *  diagnostics, what the role tried, what a bound refused, and what is still wrong. Pure.
 *
 *  This is the whole difference between "the run refuses" and "the run refuses and you
 *  can see why it could not help itself" — the second is what lets a human fix the plan
 *  in one pass instead of guessing at what the machine would have accepted. */
export function renderRepairAttempt(attempt: RepairAttempt): string {
  const out: string[] = [renderDiagnostics(attempt.before), ""];
  const who = attempt.persona
    ? `${attempt.persona.name}, ${attempt.persona.role}`
    : "Leopold (no role could be synthesized)";
  out.push(`Leopold tried to repair it first — ${who} — and could not:`);
  if (attempt.proposals.length === 0) {
    out.push("  · it proposed no repair at all.");
  }
  for (const a of attempt.accepted) out.push(`  · would apply: ${a.line.trim()}  (item ${a.index})`);
  for (const r of attempt.refused) out.push(`  ✗ refused [${r.bound}]: ${r.proposal.raw.trim()} — ${r.reason}`);
  if (attempt.after.length) {
    out.push("");
    out.push("After that repair the graph is still invalid:");
    for (const d of attempt.after) out.push(`  ✗ ${d.message}`);
  }
  out.push("");
  out.push("PLAN.md was not modified. Fix it yourself, then `leopold graph` to confirm.");
  return out.join("\n");
}

/** Ask the synthesized role for a repair. ONE model call through the sdk.ts seam, no
 *  tools, one turn — and it never throws: any failure returns "" and the repair then has
 *  nothing to apply, which is the same outcome as a role that proposed nothing. */
async function askForRepair(
  cfg: DriverConfig, brief: Brief, planText: string, diagnostics: GraphDiagnostic[], persona?: Persona,
): Promise<string> {
  let text = "";
  try {
    const q = query({
      prompt: repairUserPrompt(planText, diagnostics),
      options: {
        ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
        leopoldRole: "conductor",
        systemPrompt: repairSystemPrompt(brief, persona),
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        permissionMode: "default",
      } as never,
    });
    for await (const msg of q as AsyncIterable<{
      type: string;
      message?: { content?: Array<{ type: string; text?: string }> };
      result?: string;
    }>) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
      } else if (msg.type === "result") {
        if (!text && typeof msg.result === "string") text = msg.result;
      }
    }
  } catch {
    return "";
  }
  return text;
}

/** Repair a malformed plan graph under a synthesized role.
 *
 *  PLAN.md is written exactly once, and only when the repaired text validates. Every
 *  half of the attempt — the role, each accepted change, each refusal with its bound, and
 *  the diagnostics that survived — is on events.jsonl either way, and a successful repair
 *  also lands in DECISIONS.md with the role that made it and a Reversal line naming the
 *  exact line to put back. */
export async function attemptGraphRepair(
  brief: Brief, cfg: DriverConfig, diagnostics: GraphDiagnostic[], iteration = 0,
): Promise<RepairAttempt> {
  const planText = fs.readFileSync(brief.planPath, "utf8");
  const persona = await synthesizePersona(cfg, brief, {
    fork: "repair",
    item: `PLAN.md declares a graph the validator rejects (${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"})`,
    detail: diagnostics.map((d) => `[${d.code}] ${d.message}`).join("\n"),
  });
  logEvent(brief.leoDir, {
    event: "persona", fork: "repair", item: "invalid plan graph", synthesized: persona !== undefined,
    name: persona?.name ?? null, role: persona?.role ?? null, role_key: persona?.roleKey ?? null,
    constraints: persona?.constraints.length ?? 0,
  });

  const answer = await askForRepair(cfg, brief, planText, diagnostics, persona);
  const proposals = parseAmendments(answer);
  // The SAME bounds a @feedback node's amendments clear, plus the one verb a repair adds —
  // and the SAME purse. Handing this path a full `MAX_ADDED_ITEMS` made it a second, looser
  // repair path: it spent up to three changes without charging them, `repairDeadlock` then
  // computed its own budget from an `amendments_added` still reading zero, and one run could
  // make six plan changes under a contract that says three. Read what the run has already
  // spent (state.json survives across runs of the same brief) and judge against the rest.
  const remaining = Math.max(0, MAX_ADDED_ITEMS - readAmendmentsAdded(brief.leoDir));
  const judged = judgeAmendments(planText, proposals, remaining, { allowRoute: true });
  const after = judged.accepted.length
    ? validateGraph(buildGraph(parsePlan(judged.planText)))
    : diagnostics;
  const ok = judged.accepted.length > 0 && after.length === 0;
  const decision = parseDecisionBlock(
    answer,
    ok ? judged.accepted.map((a) => a.line.trim()).join(" · ") : "",
  );

  const attempt: RepairAttempt = {
    ...(persona ? { persona } : {}),
    before: diagnostics,
    proposals,
    accepted: judged.accepted,
    refused: judged.refused,
    after,
    ...(decision ? { decision } : {}),
    ok,
  };

  for (const r of judged.refused) {
    logEvent(brief.leoDir, {
      event: "repair_refused", op: r.proposal.op, bound: r.bound,
      reason: r.reason, proposal: r.proposal.raw.slice(0, 200),
    });
  }

  if (!ok) {
    // Nothing is written. The plan the human wrote is the plan on disk.
    logEvent(brief.leoDir, {
      event: "repair_failed",
      persona: persona?.name ?? null,
      proposed: proposals.length,
      would_apply: judged.accepted.length,
      refused: judged.refused.length,
      remaining: after.map((d) => ({ code: d.code, item: d.index, message: d.message })),
    });
    return attempt;
  }

  fs.writeFileSync(brief.planPath, judged.planText);
  for (const a of judged.accepted) {
    logEvent(brief.leoDir, {
      event: "repair_applied", item: a.index, op: a.proposal.op,
      line: a.line.trim(), previous: a.previous?.trim() ?? null,
    });
  }
  logPersonaDecision(
    brief.leoDir, iteration, persona,
    {
      decision: decision?.decision || judged.accepted.map((a) => a.line.trim()).join(" · "),
      why: decision?.why || `the graph was invalid (${diagnostics.map((d) => d.code).join(", ")}) and the run would otherwise not have started`,
      reversal: decision?.reversal || reversalFor(brief.planPath, judged.accepted),
    },
    { fork: "repair", item: `the plan graph did not validate (${diagnostics.map((d) => d.code).join(", ")})` },
  );
  logEvent(brief.leoDir, {
    event: "persona_decision", fork: "repair",
    persona: persona?.name ?? null, role: persona?.role ?? null,
    applied: judged.accepted.length, refused: judged.refused.length,
  });
  return attempt;
}

/** The concrete undo for a repair: every line to put back, named. A repair only ever
 *  retargets a route or appends an item, so this is always a one-or-three-line edit. */
function reversalFor(planPath: string, accepted: AmendAccepted[]): string {
  const parts = accepted.map((a) =>
    a.previous !== undefined
      ? `restore item ${a.index}'s route line to "${a.previous.trim()}"`
      : `delete the appended line "${a.line}"`,
  );
  return `in ${planPath}: ${parts.join("; ")}. No item's index moved.`;
}

/** The pre-flight BOTH engines run: validate the plan's graph and, when it is malformed
 *  and the run is autonomous, repair it under a synthesized role before refusing.
 *
 *  ONE writer, so `/leopold-run` (the driver loop) and `/leopold-workflow` (the compile
 *  path) resolve a broken graph the same way — a plan that repairs itself on one engine
 *  and halts on the other teaches the user a lie.
 *
 *  A VALID PLAN NEVER REACHES THE REPAIR: no persona is synthesized, no model call is
 *  spent, and the returned value is byte-for-byte what `preflightPlan` returned. Under
 *  `autonomy: ask` the repair is skipped entirely and the refusal is exactly what it was
 *  before this existed. */
export async function preflightOrRepair(
  brief: Brief, cfg: DriverConfig,
): Promise<Preflight & { repair?: RepairAttempt }> {
  const first = preflightPlan(brief.planPath);
  if (first.ok || cfg.autonomy === "ask") return first;

  const repair = await attemptGraphRepair(brief, cfg, first.diagnostics);
  if (!repair.ok) {
    return { ok: false, diagnostics: first.diagnostics, report: renderRepairAttempt(repair), repair };
  }
  // Re-read from disk rather than trusting the in-memory text: what the run dispatches
  // must be what PLAN.md now says, and this is the same function the human's
  // `leopold graph` runs.
  const second = preflightPlan(brief.planPath);
  return { ...second, repair };
}

// --- the deadlock: open items, nothing dispatchable ----------------------------------
//
// The graph validated, the run started, and now the scheduler asks "what runs next?" and
// gets nothing back while items are still open. That is not a defect in the plan's TEXT —
// it is a decision nobody made. The canonical shape: item 2 declares `@needs approved`,
// item 1 declares `@emit approved=yes` and `@emit approved=no`, and item 1 ended without
// saying which. The plan is legal, the graph is sound, and the run is parked forever
// waiting on a call a person would have made in four seconds.
//
// So Leopold makes it. A role is synthesized for the strand, handed the plan, the channel
// and WHY each open item cannot run, and it may do exactly three things — the two the
// graph repair already has, plus the one this fork is actually about:
//
//   SIGNAL <key>=<value>   decide a signal the plan ALREADY declares with `@emit`, taking
//                          a value that `@emit` declares, when the channel does not carry
//                          the key. The plan's vocabulary IS the vocabulary
//   ROUTE <item> <cond> -> <n>   retarget a route the plan already declares
//   ADD <text>             append a plain work item
//
// judged by the SAME judgeAmendments, drawing on the SAME run-wide purse of 3 changes.
// There is no looser second path: a fourth change gets the `add-budget` refusal a
// @feedback node gets, and a key the plan never declared gets `undeclared-signal`.
//
// ONCE PER RUN, AND ONLY WHEN IT ACTUALLY UNSTICKS THE RUN. The proposal is tested
// against the real scheduler — `dispatchPlan` with the proposed signals layered over the
// channel — BEFORE anything is written. If the run would still be stuck, PLAN.md and the
// channel are untouched and the run stops with `deadlock` naming the stranded items,
// exactly as it did before. `state.deadlock_repair_used` is set before the model call, so
// a crash mid-call cannot hand a resumed run a second one, and a SECOND deadlock stops
// the run: this buys one recovery, never a loop.

/** Why one open item cannot be dispatched, in the words the prompt and the log use. */
export interface Strand {
  index: number;
  text: string;
  why: string;
}

/** What the deadlock repair did, whether or not it worked. Pure data, no console. */
export interface DeadlockRepair {
  persona?: Persona;
  /** The stranded items, and why each one is stuck. */
  strands: Strand[];
  proposals: AmendProposal[];
  accepted: AmendAccepted[];
  refused: AmendRefused[];
  /** Signals the repair decided (empty unless it decided any). */
  signals: Record<string, string>;
  decision?: PersonaDecision;
  /** True only when the repair was applied AND the scheduler now has something to run. */
  ok: boolean;
}

/** Why each open item is stuck. PURE — the same three reasons the scheduler itself has,
 *  named per item so the role diagnoses from evidence instead of from the plan text
 *  alone, and so the stop message can say what is stranded when the repair fails. */
export function strandsOf(
  items: PlanItem[], routing: RunRouting, signals: Record<string, string>,
): Strand[] {
  const done = new Set(items.filter((i) => i.done).map((i) => i.index));
  const out: Strand[] = [];
  for (const item of items) {
    if (item.done || routing.settled.has(item.index)) continue;
    const openDeps = item.deps.filter((d) => !done.has(d));
    const unmet = item.needs.filter((k) => !Object.prototype.hasOwnProperty.call(signals, k));
    // Both halves when both apply: an item can be waiting on a signal AND on an item
    // that is itself stranded, and naming only the first sends the role up the wrong tree.
    const reasons: string[] = [];
    if (unmet.length) reasons.push(`waits on signal ${unmet.map((k) => `"${k}"`).join(", ")}, which nothing has put on the channel`);
    if (openDeps.length) reasons.push(`waits on item ${openDeps.join(", ")}, which is not done`);
    const why = reasons.join(", and ") || "no wave and no route reaches it";
    out.push({ index: item.index, text: item.text, why });
  }
  return out;
}

/** The system prompt the deadlock repair runs under. Pure, so the framing — above all
 *  what it may NOT do — is inspectable in a test. */
export function deadlockSystemPrompt(brief: Brief, persona?: Persona): string {
  return `You are Leopold, an autonomous orchestrator. The run has stalled: plan items are still open and NOTHING is dispatchable. No human is coming to unstick it — you decide, now.

This is almost never a broken plan. It is a decision nobody made: an item waits on a signal the plan declares but no node ever put on the channel, or a route points somewhere control can no longer reach.

You may propose ONLY these three things, and at most ${MAX_ADDED_ITEMS} of them in total:

  SIGNAL <key>=<value>                   DECIDE a signal. The key must be one the plan
                                         already declares with \`@emit\`, and the value must
                                         be one of the values it declares for that key.
                                         You may not invent either, and you may not
                                         overwrite a signal a node already decided.
  ROUTE <item> <condition> -> <target>   Point a route the plan ALREADY declares at an
                                         item that exists. The condition must match the
                                         \`@on\` line as written.
  ADD <text>                             Append one plain work item at the end of the plan.

You may NOT delete an item, edit an item's text, touch an item already marked [x], add a
node kind, raise a budget, or edit GUARDRAILS.md. Those are refused in code and logged.

Prefer the SMALLEST decision that makes a STRANDED item runnable. Deciding a signal is
usually it: read what the stranded item needs, read what the plan says that signal means,
and make the call the charter would make. Adding an item does not unstick anything on its
own — propose it only when the work genuinely is missing.

Respond with your proposals in ONE fenced block (exactly this shape, one per line):

\`\`\`leopold-amend
SIGNAL approved=yes
\`\`\`

${DECISION_BLOCK_INSTRUCTION}

=== MISSION ===
${brief.mission}

=== CHARTER (this is how this project decides; you are bound by it) ===
${brief.charter}${personaAppend(persona)}`;
}

/** The user turn: the plan, the channel, and why each open item cannot run. Pure. */
export function deadlockUserPrompt(
  planText: string, strands: Strand[], signals: Record<string, string>,
): string {
  const plan = planText.length > MAX_PLAN_CHARS ? `${planText.slice(0, MAX_PLAN_CHARS)}\n…(truncated)` : planText;
  const channel = Object.entries(signals);
  return `The scheduler has nothing to dispatch and the plan is not finished.

=== WHAT IS STRANDED, AND WHY ===
${strands.map((s) => `- item ${s.index} ("${s.text.slice(0, 120)}") ${s.why}`).join("\n")}

=== THE STATE CHANNEL RIGHT NOW ===
${channel.length ? channel.map(([k, v]) => `- ${k} = ${v}`).join("\n") : "(empty — no node has decided a signal this run)"}

=== PLAN.md, AS WRITTEN (items are numbered by their checkbox order, starting at 1) ===
${plan}

Decide the smallest thing that gets the run moving again.`;
}

/** Ask the synthesized role to unstick the run. ONE model call through the sdk.ts seam,
 *  no tools, one turn — and it never throws: any failure returns "", which is the same
 *  outcome as a role that proposed nothing. */
async function askForDeadlockRepair(
  cfg: DriverConfig, brief: Brief, planText: string, strands: Strand[],
  signals: Record<string, string>, persona?: Persona,
): Promise<string> {
  let text = "";
  try {
    const q = query({
      prompt: deadlockUserPrompt(planText, strands, signals),
      options: {
        ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
        leopoldRole: "conductor",
        systemPrompt: deadlockSystemPrompt(brief, persona),
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        permissionMode: "default",
      } as never,
    });
    for await (const msg of q as AsyncIterable<{
      type: string;
      message?: { content?: Array<{ type: string; text?: string }> };
      result?: string;
    }>) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
      } else if (msg.type === "result") {
        if (!text && typeof msg.result === "string") text = msg.result;
      }
    }
  } catch {
    return "";
  }
  return text;
}

/** The concrete undo for a deadlock repair: every line to put back and every signal to
 *  take off the channel, named. */
function deadlockReversal(brief: Brief, accepted: AmendAccepted[]): string {
  const plan = accepted.filter((a) => a.proposal.op !== "signal").map((a) =>
    a.previous !== undefined
      ? `restore item ${a.index}'s route line to "${a.previous.trim()}"`
      : `delete the appended line "${a.line}"`,
  );
  const signals = accepted.filter((a) => a.proposal.op === "signal")
    .map((a) => `remove "${a.text.split("=")[0]}" from the signals in ${brief.leoDir}/bus.json`);
  const parts = [...(plan.length ? [`in ${brief.planPath}: ${plan.join("; ")}`] : []), ...signals];
  return `${parts.join(". ")}. No item's index moved and nothing was committed.`;
}

/** ONE WRITER for the deadlock repair, used by BOTH schedulers: spend the run's single
 *  repair, synthesize the role, decide, PROVE the run is unstuck, and only then write.
 *
 *  Returns `null` when no repair was even attempted — `autonomy: ask`, or the repair
 *  already spent this run — so the caller stops with `deadlock` exactly as it always did.
 *  The caller persists `state`; this only sets the flag on it, so a scheduler's own
 *  `writeState` sequencing is not second-guessed. */
export async function repairDeadlock(
  brief: Brief, cfg: DriverConfig, state: RunState, routing: RunRouting,
  items: PlanItem[], iteration = 0,
): Promise<DeadlockRepair | null> {
  if (cfg.autonomy === "ask" || state.deadlock_repair_used) return null;

  const planText = fs.readFileSync(brief.planPath, "utf8");
  const signals = readSignals(brief.leoDir);
  const strands = strandsOf(items, routing, signals);
  // Nothing is stranded, so nothing was attempted: no persona, no model call, no cost.
  // Spending the run's one repair here burned it on a question that was never asked —
  // the flag belongs BELOW this guard, not above it.
  if (strands.length === 0) return null;

  // Spent before the model call, and PERSISTED before it: the flag lives on `state`, and
  // the caller only writes state after this function returns, so a crash mid-call used to
  // lose it entirely and hand a resumed run a second repair — the exact thing the comment
  // above promises it cannot. Write it through now so the promise is real.
  state.deadlock_repair_used = true;
  writeState(brief.leoDir, state);

  const persona = await synthesizePersona(cfg, brief, {
    fork: "deadlock",
    item: `the run is stranded: item(s) ${strands.map((s) => s.index).join(", ")} are open and nothing is dispatchable`,
    detail: strands.map((s) => `item ${s.index} ("${s.text.slice(0, 120)}") ${s.why}`).join("\n"),
  });
  logEvent(brief.leoDir, {
    event: "persona", fork: "deadlock", item: `stranded: ${strands.map((s) => s.index).join(", ")}`,
    synthesized: persona !== undefined,
    name: persona?.name ?? null, role: persona?.role ?? null, role_key: persona?.roleKey ?? null,
    constraints: persona?.constraints.length ?? 0,
  });

  const answer = await askForDeadlockRepair(cfg, brief, planText, strands, signals, persona);
  const proposals = parseAmendments(answer);
  // The SAME purse the whole run shares: what a @feedback node already spent is gone.
  const remaining = MAX_ADDED_ITEMS - (state.amendments_added ?? 0);
  const judged = judgeAmendments(planText, proposals, remaining, {
    allowRoute: true, allowSignal: true, channel: signals,
  });
  const decided: Record<string, string> = {};
  for (const a of judged.accepted) {
    if (a.proposal.op !== "signal") continue;
    const eq = a.text.indexOf("=");
    decided[a.text.slice(0, eq)] = a.text.slice(eq + 1);
  }

  // Would the run actually move? Asked of the REAL scheduler, against the plan the
  // repair proposes and the channel it proposes, before a byte is written anywhere.
  const itemsAfter = judged.accepted.length ? parsePlan(judged.planText) : items;
  const stillInvalid = validateGraph(buildGraph(itemsAfter)).length > 0;
  const order = judged.accepted.length
    ? dispatchPlan(brief.leoDir, itemsAfter, routing, new Set(), { signals: decided }).order
    : [];
  const ok = judged.accepted.length > 0 && !stillInvalid && order.length > 0;

  const decision = parseDecisionBlock(
    answer, ok ? judged.accepted.map((a) => a.line.trim()).join(" · ") : "",
  );
  const repair: DeadlockRepair = {
    ...(persona ? { persona } : {}),
    strands,
    proposals,
    accepted: judged.accepted,
    refused: judged.refused,
    signals: decided,
    ...(decision ? { decision } : {}),
    ok,
  };

  for (const r of judged.refused) {
    logEvent(brief.leoDir, {
      event: "repair_refused", fork: "deadlock", op: r.proposal.op, bound: r.bound,
      reason: r.reason, proposal: r.proposal.raw.slice(0, 200),
    });
  }

  if (!ok) {
    // Nothing is written: not PLAN.md, not the channel. The run stops with `deadlock`.
    logEvent(brief.leoDir, {
      event: "deadlock_repair_failed",
      persona: persona?.name ?? null,
      stranded: strands.map((s) => s.index),
      proposed: proposals.length,
      would_apply: judged.accepted.length,
      refused: judged.refused.length,
      reason: judged.accepted.length === 0
        ? "no proposal cleared the bounds"
        : stillInvalid ? "the repair broke the graph" : "the repair left the run with nothing to dispatch",
    });
    return { ...repair, ok: false };
  }

  // Applied in one direction only: the channel first (its ceilings are the bus's), then
  // the plan. A signal the bus refuses fails the whole repair — the run stops with
  // `deadlock` and says so, rather than half-unsticking itself.
  try {
    for (const [key, value] of Object.entries(decided)) {
      const by = judged.accepted.find((a) => a.proposal.op === "signal" && a.text.startsWith(`${key}=`))?.index;
      emitSignal(brief.leoDir, key, value, by !== undefined ? { by } : {});
    }
  } catch (err) {
    if (!(err instanceof BusContractError)) throw err;
    logEvent(brief.leoDir, {
      event: "deadlock_repair_failed", persona: persona?.name ?? null,
      stranded: strands.map((s) => s.index), reason: err.message,
    });
    return { ...repair, ok: false };
  }
  const touchesPlan = judged.accepted.some((a) => a.proposal.op !== "signal");
  if (touchesPlan) fs.writeFileSync(brief.planPath, judged.planText);
  state.amendments_added = (state.amendments_added ?? 0) + judged.accepted.length;

  for (const a of judged.accepted) {
    logEvent(brief.leoDir, {
      event: "deadlock_repair_applied", item: a.index, op: a.proposal.op,
      line: a.line.trim(), previous: a.previous?.trim() ?? null,
    });
  }
  logPersonaDecision(
    brief.leoDir, iteration, persona,
    {
      decision: decision?.decision || judged.accepted.map((a) => a.line.trim()).join(" · "),
      why: decision?.why
        || `item(s) ${strands.map((s) => s.index).join(", ")} were open with nothing dispatchable, and the run would otherwise have stopped with deadlock`,
      reversal: decision?.reversal || deadlockReversal(brief, judged.accepted),
    },
    { fork: "deadlock", item: `item(s) ${strands.map((s) => s.index).join(", ")} were open with nothing dispatchable` },
  );
  logEvent(brief.leoDir, {
    event: "persona_decision", fork: "deadlock",
    persona: persona?.name ?? null, role: persona?.role ?? null,
    stranded: strands.map((s) => s.index),
    applied: judged.accepted.length, refused: judged.refused.length,
    signals: decided, dispatchable: order.map((i) => i.index),
  });
  return repair;
}

/** The block printed when a deadlock repair did NOT unstick the run: what is stranded,
 *  who tried, what a bound refused. Pure — the same "it tried and could not" honesty the
 *  graph repair prints, in the place a stop message goes. */
export function renderDeadlockAttempt(repair: DeadlockRepair | null, strands: Strand[]): string {
  const out: string[] = [
    `Nothing can run: ${strands.map((s) => `item ${s.index} ${s.why}`).join("; ")}.`,
  ];
  if (repair) {
    const who = repair.persona ? `${repair.persona.name}, ${repair.persona.role}` : "Leopold (no role could be synthesized)";
    out.push(`Leopold tried to decide it first — ${who} — and could not:`);
    if (repair.proposals.length === 0) out.push("  · it proposed nothing at all.");
    for (const a of repair.accepted) out.push(`  · would apply: ${a.line.trim()}`);
    for (const r of repair.refused) out.push(`  ✗ refused [${r.bound}]: ${r.proposal.raw.trim()} — ${r.reason}`);
  }
  out.push("Work so far is staged.");
  return out.join("\n");
}
