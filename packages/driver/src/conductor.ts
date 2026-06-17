// The conductor: the persistent "you". It reads a worker's status and decides
// what to tell it, grounded in the mission and charter.
//
// It runs through the SAME Agent SDK as the worker, so it uses your existing
// Claude Code auth (your subscription). No separate API key, no split billing.
// It is a one-shot reasoning call with NO tools that returns a JSON verdict.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Brief, WorkerStatus, ConductorVerdict, DriverConfig } from "./types.js";

function system(brief: Brief): string {
  return `You are Leopold, the conductor. You sit in the user's seat and make the calls they would make so a Claude Code worker can keep building without stopping to ask a human. You are NOT the coder; you read the worker's status and decide what to tell it.

Protocol for every worker status:
- Classify the fork: reversibility (cheap to undo = reversible) and charter clarity (does the charter/mission answer it?).
- Reversible OR charter-clear -> action "answer": give a crisp, concrete instruction, and fill logTitle/logWhy/reversal so it is auditable.
- Irreversible AND ambiguous, OR a charter contradiction, OR a sign the mission premise is wrong -> action "escalate"; do NOT guess. Set escalationReason.
- Worker STATUS done -> action "finish" (item complete, no reply). If evidence looks weak (no tests/build run), instead "answer" telling it to verify first.
- Worker STATUS blocked -> "answer" with a remediation if the charter/principles make it clear, else "escalate".

When the charter is silent, decide with these ordered principles: completeness, boil-lakes-not-oceans, pragmatic, DRY, explicit-over-clever, bias-toward-action. Keep replies short and actionable. git commit/push/publish are locked; never instruct the worker to commit or push.

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
