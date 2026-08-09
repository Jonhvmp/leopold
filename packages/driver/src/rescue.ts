// Repeated failure is a change of approach before it is a dead end.
//
// Three failures of the same kind used to end the run: `consecutive_failures >=
// max_failures` → `repeated_failure`, the item still open, the work handed back to a
// person who is not there. But a run that failed three times the same way did not run out
// of budget — it ran out of IDEAS, and "try the same thing a fourth time" is not what a
// person would have done with it either. What a person would have done is look at the
// evidence, decide the previous framing was wrong, and take a different path.
//
// So on the LAST allowed failure Leopold synthesizes the role that failure needs, hands
// it the evidence (what the attempts reported, and the root-cause panel's surviving
// hypothesis from hypotheses.ts), and asks it for ONE genuinely different approach. The
// next attempt runs under that approach. Nothing else changes.
//
// THE EXTRA ATTEMPT IS ONE, AND IT IS NOT A BUDGET INCREASE. `max_failures` is never
// written, `max_iterations` is never written, the kill switch is never touched. The
// rescue is spent once per run (`state.failure_rescue_used`, persisted, so a resumed run
// inherits that it was spent) and the attempt it buys is charged as an iteration like
// any other. If that attempt fails too, `consecutive_failures` is now ABOVE the ceiling,
// the next top-of-loop check finds the rescue spent, and the run stops with
// `repeated_failure` exactly as it does today.
//
// AND IT IS GRANTED ONLY WHEN A ROLE ACTUALLY DECIDED SOMETHING. A synthesis that
// returned nothing, a harness error, an answer with no approach in it — every one of
// those returns `undefined`, the run stops with `repeated_failure`, and the log says the
// rescue was attempted and produced nothing. A silent extra attempt with no new idea in
// it is just a fourth try, and this module refuses to sell one as a decision.

import { query } from "./sdk.js";
import {
  synthesizePersona, personaAppend, charterHardRules, NO_EXECUTION_CLAUSE, DEFAULT_REVERSAL,
  type Persona, type PersonaDecision,
} from "./persona.js";
import { logEvent, logPersonaDecision } from "./log.js";
import type { Brief, DriverConfig, RunState } from "./types.js";

/** What the role changing the approach is told about the failure. */
export interface RescueInput {
  /** The item that keeps failing. */
  item: string;
  /** What the failed attempts reported (the worker's last summary). */
  failureContext: string;
  /** How many consecutive failures brought the run here. */
  failures: number;
  /** The root-cause panel's surviving hypothesis, already formatted (hypotheses.ts).
   *  Undefined when the panel is off or nothing survived refutation — the role then
   *  decides on the failure reports alone. */
  panelLead?: string;
}

/** A persona-led change of approach: what to do differently, why it differs, and the
 *  decision that goes on the trail. */
export interface Rescue {
  /** The role that made the call. Undefined when synthesis produced none; the change of
   *  approach is still decided, under the charter alone, exactly as an escalation is. */
  persona?: Persona;
  /** The approach the next attempt is to take — concrete, actionable, and NOT the one
   *  that failed. */
  approach: string;
  /** Why it is genuinely different from what the failed attempts did. */
  different: string;
  /** The call, for DECISIONS.md. */
  decision: PersonaDecision;
}

const MAX = 1200;
function clip(s: unknown, max = MAX): string {
  const t = String(s ?? "").replace(/\r/g, "").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** The system prompt the change-of-approach call runs under. Pure, so a test can prove
 *  the role is bound by the charter and told it may not raise a budget. */
export function rescueSystemPrompt(brief: Brief, persona?: Persona): string {
  const rules = persona?.constraints ?? charterHardRules(brief.charter);
  const who = persona
    ? `You are ${persona.name.toUpperCase()} — ${persona.role}.\nYour expertise: ${persona.expertise.join("; ")}.${persona.optimizesFor.length ? `\nYou optimize for: ${persona.optimizesFor.join("; ")}.` : ""}${persona.rationale ? `\n${persona.rationale}` : ""}`
    : `You are Leopold, sitting in the user's seat. No role could be synthesized for this failure, so you take it yourself, bound by the same charter.`;

  return `${who}

A plan item has failed the maximum number of times this run allows. The run is about to give up on it. You get ONE more attempt and you decide what it does differently.

The previous attempts are a dead end — do not refine them. Read the evidence, work out what the previous framing got wrong, and specify a GENUINELY DIFFERENT approach: a different entry point, a different mechanism, a smaller decomposition, a different file, or dropping an assumption the attempts kept making. "Try again more carefully" is not an approach and neither is "the same fix with more logging".

Decide only the APPROACH. You are not writing the code and you are not judging whether the item is worth doing.

YOU ARE BOUND BY THESE RULES. They come from the project's charter, they are not advice, and an approach that breaks one is wrong however well argued:
${rules.map((r) => `  - ${r}`).join("\n") || "  - (the charter states no binding rule; decide on the mission alone)"}

THIS IS ONE ATTEMPT, NOT MORE ROOM. You may not raise max_failures, max_iterations or any budget, you may not clear the kill switch, and you may not propose that the run keep retrying. If this attempt fails, the run stops.

${NO_EXECUTION_CLAUSE}

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"approach":"what the next attempt does, concretely — the entry point, the mechanism, the first move","different":"how this differs from what the failed attempts did, in one line","decision":"the call you made, in one line","why":"the charter/mission basis for it","reversal":"how a human undoes this, concretely — the file to revert, the flag to flip"}

=== MISSION ===
${brief.mission}

=== CHARTER (this is how this project decides; you are bound by it) ===
${brief.charter}`;
}

/** The user turn of the change-of-approach call. Pure. */
export function rescueUserPrompt(input: RescueInput): string {
  return `The item that keeps failing:
  ${clip(input.item, 600)}

It has failed ${input.failures} time(s) in a row — the ceiling this run allows.

WHAT THE FAILED ATTEMPTS REPORTED:
${clip(input.failureContext, 1500) || "(no detail recorded)"}

${input.panelLead ? `WHAT THE ROOT-CAUSE PANEL FOUND (independent investigators over disjoint evidence, refuted before it reached you):\n${clip(input.panelLead, 1500)}\n\nThe panel's lead is evidence, not an order: if it is wrong, say what to do instead.` : "The root-cause panel produced no surviving hypothesis, so decide from the failure reports."}

Decide the one different approach the last attempt takes. Return the JSON object now.`;
}

/** Parse a change-of-approach answer. PURE, and strict about the two fields that make it
 *  a decision rather than a fourth try: without an APPROACH there is nothing to hand the
 *  next attempt, and without DIFFERENT there is no evidence it changed anything. Either
 *  way the caller stops the run with `repeated_failure`, which is what it did before.
 *  The Reversal is never empty — `DEFAULT_REVERSAL` is always true of a Leopold run. */
export function parseRescue(text: string): Omit<Rescue, "persona"> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const approach = clip(obj.approach);
  const different = clip(obj.different, 400);
  if (!approach || !different) return undefined;
  return {
    approach,
    different,
    decision: {
      decision: clip(obj.decision, 400) || `Change of approach on the last attempt: ${approach}`,
      why: clip(obj.why, 400),
      reversal: clip(obj.reversal, 400) || DEFAULT_REVERSAL,
    },
  };
}

/** The instruction the rescued attempt receives, in the same place a retry lead goes —
 *  so the worker prompt is assembled exactly as it is on any other retry, with the
 *  approach on top of the evidence that produced it. Pure. */
export function formatRescueLead(r: Rescue, panelLead?: string): string {
  const who = r.persona ? `${r.persona.name}, ${r.persona.role},` : "Leopold";
  return (
    `THIS IS THE LAST ATTEMPT ON THIS ITEM. It failed the maximum number of times this run allows, and instead of giving up, ${who} looked at the evidence and changed the approach. The previous attempts are a dead end: do not refine them, take the path below.\n` +
    `NEW APPROACH: ${r.approach}\n` +
    `HOW IT DIFFERS: ${r.different}\n` +
    `WHY: ${r.decision.why || r.decision.decision}\n` +
    (panelLead ? `\nThe evidence it decided on:\n${panelLead}\n` : "") +
    `\nIf this approach is wrong too, say so plainly in your status with what you learned — do not fall back to the approach that already failed.` +
    (r.persona ? personaAppend(r.persona) : "")
  );
}

/** Decide the change of approach: ONE model call through the same sdk.ts seam, no tools,
 *  one turn — and it never throws. `undefined` means no approach was decided and the
 *  caller stops the run exactly as it did before this module existed. */
export async function decideRescue(
  cfg: DriverConfig, brief: Brief, input: RescueInput, persona?: Persona,
): Promise<Omit<Rescue, "persona"> | undefined> {
  let text = "";
  try {
    const q = query({
      prompt: rescueUserPrompt(input),
      options: {
        ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
        leopoldRole: "conductor",
        systemPrompt: rescueSystemPrompt(brief, persona),
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
    return undefined;
  }
  if (!text.trim()) return undefined;
  return parseRescue(text);
}

/** ONE WRITER for the whole rescue, used by BOTH schedulers: spend the run's single
 *  rescue, synthesize the role, decide the approach, write the trail, and return the
 *  lead the next attempt runs under. `null` means the run stops with `repeated_failure`.
 *
 *  It marks the rescue SPENT before the model call, not after: a crash mid-call must not
 *  hand a resumed run a second one, and "one extra attempt" is a ceiling, not a target.
 *  The caller persists `state` — this function only sets the flag on it, so a scheduler's
 *  own `writeState` sequencing is not second-guessed. */
export async function rescueRepeatedFailure(
  brief: Brief, cfg: DriverConfig, state: RunState, input: RescueInput,
): Promise<string | null> {
  if (state.failure_rescue_used) return null;
  state.failure_rescue_used = true;

  const persona = await synthesizePersona(cfg, brief, {
    fork: "repeated-failure",
    item: input.item,
    detail: `The item failed ${input.failures} times in a row. What the attempts reported:\n${clip(input.failureContext, 900) || "(no detail recorded)"}`,
  });
  logEvent(brief.leoDir, {
    event: "persona", fork: "repeated-failure", item: input.item, synthesized: persona !== undefined,
    name: persona?.name ?? null, role: persona?.role ?? null, role_key: persona?.roleKey ?? null,
    constraints: persona?.constraints.length ?? 0,
  });
  console.log(persona
    ? `  repeated failure -> ${persona.name}, ${persona.role} takes the last attempt — bound by ${persona.constraints.length} charter rule(s).`
    : `  repeated failure -> no role synthesized; Leopold changes the approach on the charter alone.`);

  const decided = await decideRescue(cfg, brief, input, persona);
  if (!decided) {
    // Never silent: the run is about to stop, and the log says the rescue was tried and
    // produced no new approach — not that nobody tried.
    logEvent(brief.leoDir, {
      event: "failure_rescue_declined", item: input.item, failures: input.failures,
      persona: persona?.name ?? null,
    });
    console.log(`  repeated failure -> no different approach could be decided; the run stops.`);
    return null;
  }

  const rescue: Rescue = { ...decided, persona };
  logPersonaDecision(brief.leoDir, state.iteration, persona, rescue.decision, {
    fork: "repeated-failure",
    item: `${input.item} (failed ${input.failures}×)`,
  });
  logEvent(brief.leoDir, {
    event: "failure_rescue", item: input.item, failures: input.failures,
    max_failures: state.max_failures, extra_attempts: 1,
    persona: persona?.name ?? null, role: persona?.role ?? null,
    approach: rescue.approach, different: rescue.different,
    decision: rescue.decision.decision, reversal: rescue.decision.reversal,
    panel_lead: input.panelLead ? true : false,
  });
  console.log(
    `  last attempt, new approach: ${rescue.approach}\n` +
    `  differs from what failed: ${rescue.different}\n` +
    `  reversal: ${rescue.decision.reversal}\n` +
    `  the failure ceiling is unchanged (${state.max_failures}); this is ONE extra attempt, and the run stops if it fails.`,
  );
  return formatRescueLead(rescue, input.panelLead);
}
