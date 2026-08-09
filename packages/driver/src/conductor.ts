// The conductor: the persistent "you". It reads a worker's status and decides
// what to tell it, grounded in the mission and charter.
//
// It runs through the SAME Agent SDK as the worker, so it uses your existing
// Claude Code auth (your subscription). No separate API key, no split billing.
// It is a one-shot reasoning call with NO tools that returns a JSON verdict.

import { query } from "./sdk.js";
import { charterHardRules, NO_EXECUTION_CLAUSE, MAX_FIELD, DEFAULT_REVERSAL } from "./persona.js";
import type { Persona, PersonaDecision } from "./persona.js";
import type { Brief, WorkerStatus, ConductorVerdict, DriverConfig } from "./types.js";

function system(brief: Brief): string {
  return `You are Leopold, the conductor. You sit in the user's seat and make the calls they would make so a Claude Code worker can keep building without stopping to ask a human. You are NOT the coder; you read the worker's status and decide what to tell it. Your default is ALWAYS to keep the worker moving and to drive the item to full completion — not to stop, not to ask, not to escalate.

Protocol for every worker status — bias hard toward action and completeness:
- Default to action "answer": give a crisp, concrete instruction that unblocks the worker and pushes it to finish the WHOLE item. Make the call yourself from the mission/charter and good engineering judgment; do not punt a decision the user would consider obvious. Fill logTitle/logWhy/reversal so it stays auditable.
- Worker STATUS done -> action "finish" (item complete, no reply). Only if it plainly skipped required verification (no build/lint/test when the item needed it), "answer" telling it to verify, then finish.
- Worker STATUS blocked -> "answer" with a concrete remediation. Resolve it yourself; "blocked" is your cue to think harder and decide, not to escalate.
- action "escalate" is a LAST resort, reserved for the rare fork that is BOTH genuinely irreversible AND truly unsettleable from the charter (e.g. a real charter contradiction, or evidence the mission premise itself is wrong). If you can imagine a reasonable engineer just making the call, make it. Set escalationReason only when you genuinely cannot.

Never tell the worker to "stop and ask the user", to wait, or to do a partial/placeholder job. Push for complete, finished, verified work every turn. When the charter is silent, decide with these ordered principles: bias-toward-action, completeness, boil-lakes-not-oceans, pragmatic, DRY, explicit-over-clever. Keep replies short and actionable. git commit/push are locked; never instruct the worker to commit or push (it stages and reports).

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"action":"answer|finish|escalate","classification":"reversible|irreversible|n/a","charterBasis":"...","reply":"...","logTitle":"...","logWhy":"...","reversal":"...","escalationReason":"..."}
Omit reply for finish/escalate. Omit logTitle for mechanical calls. Omit escalationReason unless escalating.

=== MISSION ===
${brief.mission}

=== CHARTER (this is how the user decides; follow it) ===
${brief.charter}`;
}

function parseVerdict(text: string): ConductorVerdict {
  let obj: Partial<ConductorVerdict> = {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    obj = JSON.parse(raw) as Partial<ConductorVerdict>;
  } catch {
    obj = {};
  }
  return {
    action: obj.action ?? "escalate",
    classification: obj.classification ?? "n/a",
    charterBasis: obj.charterBasis ?? "",
    reply: obj.reply,
    logTitle: obj.logTitle,
    logWhy: obj.logWhy,
    reversal: obj.reversal,
    escalationReason: obj.escalationReason ?? "Conductor produced no parseable decision; escalating to the human.",
  };
}

export async function decide(
  cfg: DriverConfig,
  brief: Brief,
  status: WorkerStatus,
  recentDecisions: string,
): Promise<ConductorVerdict> {
  const userText = `The worker reported this for item "${status.item}":

STATUS: ${status.kind}
SUMMARY: ${status.summary}
DECISION-NEEDED: ${status.decisionNeeded ?? "(none)"}
NEXT: ${status.next ?? "(none)"}
EVIDENCE: ${status.evidence ?? "(none)"}

Recent decisions you already made this run (do not contradict them):
${recentDecisions || "(none yet)"}

Return the JSON verdict now.`;

  const q = query({
    prompt: userText,
    options: {
      ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
      leopoldRole: "conductor",
      systemPrompt: system(brief),
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      permissionMode: "default",
    } as never,
  });

  let text = "";
  for await (const msg of q as AsyncIterable<{ type: string; message?: { content?: Array<{ type: string; text?: string }> }; result?: string }>) {
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
    } else if (msg.type === "result") {
      if (!text && typeof msg.result === "string") text = msg.result;
    }
  }
  return parseVerdict(text);
}

// ---------------------------------------------------------------------------
// Escalation, settled instead of surrendered.
//
// `decide()` above escalates as a last resort, and that used to END THE RUN: the item
// sat there with a question attached until a person came back. For the people who adopt
// an autonomous harness, that means it sat there. So an escalation is now one more fork
// a synthesized role takes: the run works out WHO should settle it, that role settles it
// against the charter, the decision goes back to the worker as an instruction, and the
// item finishes.
//
// Three properties this rests on, none of them a hope about a prompt:
//   - THE BINDING RULES COME FROM THE CHARTER, IN CODE. `charterHardRules` lifts them
//     verbatim here exactly as it does for a persona, so a role settling a fork is bound
//     whether or not synthesis produced a persona at all.
//   - THE TRUST BOUNDARY DOES NOT MOVE. A resolution may conclude "ship it"; the guard
//     still denies the push. `NO_EXECUTION_CLAUSE` is the same sentence the node prompt
//     uses — one writer, so the two cannot drift.
//   - AN UNSETTLEABLE FORK STILL ESCALATES. An unparseable or empty answer returns
//     undefined and the caller falls back to the old escalation stop. Loud, never silent.

/** A fork the worker escalated, as settled by a role. `reply` is what the worker is told;
 *  the inherited fields are what DECISIONS.md records. */
export interface EscalationResolution extends PersonaDecision {
  /** The instruction that goes back to the worker so it can finish the item. */
  reply: string;
}

function clip(s: unknown, max = MAX_FIELD): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** The system prompt the resolution call runs under. Pure, so the framing — and the fact
 *  that it never claims authority the guard denies — is inspectable in a test. */
export function escalationSystemPrompt(brief: Brief, persona?: Persona): string {
  const rules = persona?.constraints ?? charterHardRules(brief.charter);
  const who = persona
    ? `You are ${persona.name.toUpperCase()} — ${persona.role}.\nYour expertise: ${persona.expertise.join("; ")}.${persona.optimizesFor.length ? `\nYou optimize for: ${persona.optimizesFor.join("; ")}.` : ""}${persona.rationale ? `\n${persona.rationale}` : ""}`
    : `You are Leopold, sitting in the user's seat. No role could be synthesized for this fork, so you take it yourself, bound by the same charter.`;

  return `${who}

A coding worker hit a fork it could not settle and escalated it. NO HUMAN IS COMING. You have the seat: settle it now, decide it the way the charter below decides, and hand the worker a concrete instruction it can act on so the item gets FINISHED. Do not ask a question back, do not defer, do not tell the worker to wait or to leave the work partial. Prefer the reversible option when two are close, and say plainly how a human undoes what you chose.

YOU ARE BOUND BY THESE RULES. They come from the project's charter, they are not advice, and a decision that breaks one is wrong however well argued:
${rules.map((r) => `  - ${r}`).join("\n") || "  - (the charter states no binding rule; decide on the mission alone)"}

${NO_EXECUTION_CLAUSE}

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"decision":"the call you made, in one line","why":"the charter/mission basis for it","reversal":"how a human undoes this, concretely — the file to revert, the flag to flip","reply":"the instruction the worker receives: what to do now, on your decision, through to a verified finish"}

=== MISSION ===
${brief.mission}

=== CHARTER (this is how this project decides; you are bound by it) ===
${brief.charter}`;
}

/** The user turn of the resolution call. Pure. */
export function escalationUserPrompt(status: WorkerStatus, why: string): string {
  return `The worker escalated this while working on item "${status.item}".

THE FORK: ${clip(status.decisionNeeded ?? status.summary, 900)}
WORKER STATUS: ${status.kind} — ${clip(status.summary, 600)}
WHAT IT TRIED / EVIDENCE: ${clip(status.evidence ?? "", 600) || "(none)"}
WHY IT WAS ESCALATED: ${clip(why, 600) || "(the conductor could not settle it from the charter)"}

Settle it. Return the JSON object now.`;
}

/** Parse a resolution answer. PURE, and strict about the two fields that make it usable:
 *  without a decision there is nothing to record, and without a reply there is nothing to
 *  push back to the worker — either way the caller must fall back to escalating.
 *  The Reversal is never empty: `DEFAULT_REVERSAL` is always true of a Leopold run. */
export function parseResolution(text: string): EscalationResolution | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const decision = clip(obj.decision);
  const reply = clip(obj.reply, 1200);
  if (!decision || !reply) return undefined;
  return { decision, why: clip(obj.why), reversal: clip(obj.reversal) || DEFAULT_REVERSAL, reply };
}

/** Settle an escalated fork under `persona` (or under the charter alone when synthesis
 *  produced none). ONE model call through the same sdk.ts seam, no tools, one turn — and
 *  it never throws: every failure path returns undefined so the caller escalates exactly
 *  as it did before personas existed. */
export async function resolveEscalation(
  cfg: DriverConfig,
  brief: Brief,
  status: WorkerStatus,
  why: string,
  persona?: Persona,
): Promise<EscalationResolution | undefined> {
  let text = "";
  try {
    const q = query({
      prompt: escalationUserPrompt(status, why),
      options: {
        ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
        leopoldRole: "conductor",
        systemPrompt: escalationSystemPrompt(brief, persona),
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
  return parseResolution(text);
}
