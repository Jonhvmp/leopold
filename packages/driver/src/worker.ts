// Runs one plan item as a back-and-forth with a FRESH Claude Code worker.
//
// Fresh context per item (the good idea Ralph has). Within an item, the worker
// and the conductor exchange real messages through the input channel (the part
// Ralph lacks): the worker closes a turn with a status block, the conductor
// reads and judges it, and either pushes the next instruction or ends the item.
//
// The same session shape serves a REVIEW-ONLY node (`@gate` / `@verify`): identical
// protocol, opposite authority — `readOnly` swaps the system prompt for the review
// node's and denies every editing tool twice over (session + guard).

import { query } from "./sdk.js";
import { InputChannel } from "./channel.js";
import { parseStatus, isTurnComplete } from "./protocol.js";
import { makeGuard } from "./guard.js";
import { EDIT_TOOLS } from "./kinds.js";
import { applySecretsEnv } from "./secrets.js";
import type { Brief, WorkerStatus, DriverConfig } from "./types.js";
import type { Effort } from "./classify.js";

const WORKER_APPEND = `You are a Leopold worker, conducted by an autonomous orchestrator. No human is watching live. Rules for this session:
- Do the item COMPLETELY. No placeholders, no TODOs, no "left as an exercise", no partial passes. Build it, wire it, verify it (build/lint/test), and only then close out. Bias hard toward finishing, not toward stopping.
- Frame the item as acceptance behavior FIRST. Before editing, restate it as 1-3 concrete checks in "given X → when Y → then Z" form, from the caller's or user's point of view (observable inputs and effects, never internal steps). Those checks ARE your definition of done for this item; verify every one holds before you report done.
- Test behavior, never implementation. Any test you write must exercise the observable contract (inputs → outputs / visible effects), not internal steps. Do NOT mock the very unit under test to make a test pass — a test that stubs out the hard part proves nothing and will pass forever. A test must FAIL if the change's core logic were broken; if it would not, it is worthless — fix it or delete it.
- Prefer what the model already knows. Reach for widely-used libraries and language built-ins over bespoke helpers you invent — popular APIs are far better represented than code that did not exist until now. When a library, framework, or API may have changed since your training, web-search its current usage before coding instead of guessing; your knowledge is frozen in time.
- Simplify before you close. Once it works, make it smaller: fewer lines is better, delete dead code and needless indirection, and introduce an abstraction ONLY where duplication already exists (never preemptively). Re-verify after simplifying. More code is a liability, not progress.
- Do NOT ask the human anything. Make the call yourself and keep going — you have full authority over the work; act on it.
- Spawned mode: if you invoke gstack skills, auto-pick the recommended option; never prompt.
- Only git commit and git push are locked by a guard. Everything else is yours to run. Stage with "git add" and report; never attempt commit/push.
- Secrets you may need are pre-loaded as environment variables; use them as $NAME, and never echo or print their values.
- Close EVERY turn with a fenced status block, then stop and wait for the conductor's reply:

\`\`\`leopold-status
STATUS: done | needs-decision | blocked
ITEM: <the item you are on>
SUMMARY: <what you did this turn, 1-3 lines>
DECISION-NEEDED: <if needs-decision: the exact question + options A/B + the tradeoff; else empty>
NEXT: <what you think comes next>
EVIDENCE: <build/lint/test result if relevant>
\`\`\`

Use needs-decision ONLY for a genuine fork that is both irreversible and unsettleable from the task + charter — that bar is high, and almost everything clears it on your own judgment. Use done only when the item is fully complete and verified.`;

/** The re-grounding sentence every CONTINUATION carries — a retry, a rescue: any
 *  attempt that follows earlier narration the workspace may have outrun. ONE
 *  definition for the TypeScript surface: loop.ts (retryLead) and rescue.ts
 *  (formatRescueLead) import it, never copy it. The in-session hook re-injects the
 *  SAME words on every continued turn (hooks/stop-continuity.sh, REGROUND_SENTENCE=…);
 *  test/reground.test.ts fails the build the moment the two surfaces drift.
 *  Deliberately NOT part of WORKER_APPEND: a first attempt has no earlier narration
 *  to distrust, so it does not re-ground. */
export const REGROUND_SENTENCE =
  "Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current.";

export interface RunItemOpts {
  brief: Brief;
  cfg: DriverConfig;
  item: string;
  workerPrompt: string;
  onBlock: (tool: string, reason: string) => void;
  /** Called when the worker completes a turn. Return the next instruction to
   *  push, or null to end the item. */
  onTurn: (status: WorkerStatus, text: string) => Promise<string | null>;
  /** Called once with the item's real USD cost (from the CLI's total_cost_usd). */
  onCost?: (usd: number) => void;
  /** Reasoning effort for this item (classify.ts). Omitted = inherit. */
  effort?: Effort;
  /** Override the worker's cwd (the parallel scheduler gives each item its own
   *  worktree). Defaults to the run's worktree, then the repo root. */
  cwd?: string;
  /** A review-only node (`@gate` / `@verify`): the session runs under the review-node
   *  system prompt and every editing tool is denied — by `disallowedTools` AND by the
   *  guard, so "this node does not edit" is enforced, not merely instructed. Absent
   *  (the default) is the ordinary work node, byte-for-byte as before. */
  readOnly?: boolean;
  /** System prompt append for a read-only node (kinds.ts builds it per kind). Ignored
   *  unless `readOnly` is set. */
  systemAppend?: string;
  /** The ROLE this session assumes (persona.ts), appended AFTER whichever system prompt
   *  the node kind already uses — a persona narrows who is deciding, it never replaces
   *  the rules the session runs under. Empty/absent leaves the prompt byte-identical,
   *  which is every session of every run that reaches no persona path. */
  personaAppend?: string;
}

export async function runItem(opts: RunItemOpts): Promise<void> {
  const { brief, cfg, item, workerPrompt, onBlock, onTurn } = opts;
  const channel = new InputChannel();
  channel.push(workerPrompt);
  const guard = makeGuard(brief.leoDir, onBlock, { readOnly: opts.readOnly === true });
  // Inject the run's secrets as env vars for this item: they reach the worker's Bash
  // tool as $NAME but never enter the prompt. Restored after the loop (runs are
  // sequential, so there is no env overlap between items).
  const { restore: restoreSecrets } = applySecretsEnv(brief.leoDir);

  const q = query({
    prompt: channel,
    options: {
      cwd: opts.cwd ?? brief.worktreeRoot ?? brief.root,
      env: { ...process.env },
      maxTurns: cfg.maxTurnsPerItem,
      leopoldRole: "executor",
      permissionMode: "default",
      canUseTool: guard as never,
      settingSources: ["user", "project"] as never,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(cfg.workerModel ? { model: cfg.workerModel } : {}),
      ...(opts.readOnly ? { disallowedTools: [...EDIT_TOOLS] } : {}),
      systemPrompt: {
        type: "preset", preset: "claude_code",
        append: (opts.readOnly ? (opts.systemAppend ?? WORKER_APPEND) : WORKER_APPEND) + (opts.personaAppend ?? ""),
      } as never,
    } as never,
  });

  let turnText = "";
  for await (const msg of q as AsyncIterable<{ type: string; message?: { content?: Array<{ type: string; text?: string }> } }>) {
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "text" && b.text) turnText += b.text;
      }
      const status = parseStatus(turnText);
      if (isTurnComplete(status)) {
        const captured = turnText;
        turnText = "";
        const next = await onTurn(status as WorkerStatus, captured);
        if (next === null) {
          // Close the input and keep draining. The item's real cost only arrives on
          // the `result` message, so breaking here — as this used to — meant a worker
          // that finished cleanly never reported a cent, and --budget-usd silently
          // never accumulated. The result branch below is what ends the loop.
          channel.close();
          continue;
        }
        channel.push(next);
      }
    } else if (msg.type === "result") {
      // The CLI reports the item's real cost here — accumulate it for the budget.
      const cost = (msg as { total_cost_usd?: unknown }).total_cost_usd;
      if (typeof cost === "number" && Number.isFinite(cost)) opts.onCost?.(cost);
      // Session ended (channel closed, or the worker stopped on its own). Flush
      // whatever we have so the conductor can make a final call.
      if (turnText.trim()) {
        const status = parseStatus(turnText) ?? {
          kind: "blocked" as const, item, summary: turnText.slice(-500), raw: turnText.slice(-500),
        };
        await onTurn(status, turnText);
      }
      break;
    }
  }
  restoreSecrets();
}
