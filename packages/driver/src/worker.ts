// Runs one plan item as a back-and-forth with a FRESH Claude Code worker.
//
// Fresh context per item (the good idea Ralph has). Within an item, the worker
// and the conductor exchange real messages through the input channel (the part
// Ralph lacks): the worker closes a turn with a status block, the conductor
// reads and judges it, and either pushes the next instruction or ends the item.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { InputChannel } from "./channel.js";
import { parseStatus, isTurnComplete } from "./protocol.js";
import { makeGuard } from "./guard.js";
import type { Brief, WorkerStatus, DriverConfig } from "./types.js";

const WORKER_APPEND = `You are a Leopold worker, conducted by an autonomous orchestrator. No human is watching live. Rules for this session:
- Do NOT ask the human anything. Decide reversible or charter-clear calls yourself and keep going.
- Spawned mode: if you invoke gstack skills, auto-pick the recommended option; never prompt.
- git commit/push/publish are LOCKED by a guard. Never attempt them. Stage with "git add" and report instead.
- Close EVERY turn with a fenced status block, then stop and wait for the conductor's reply:

\`\`\`leopold-status
STATUS: done | needs-decision | blocked
ITEM: <the item you are on>
SUMMARY: <what you did this turn, 1-3 lines>
DECISION-NEEDED: <if needs-decision: the exact question + options A/B + the tradeoff; else empty>
NEXT: <what you think comes next>
EVIDENCE: <build/lint/test result if relevant>
\`\`\`

Use needs-decision only for a fork you genuinely cannot resolve from the task and your own judgment. Use done only when the item is fully complete and verified.`;

export interface RunItemOpts {
  brief: Brief;
  cfg: DriverConfig;
  item: string;
  workerPrompt: string;
  onBlock: (tool: string, reason: string) => void;
  /** Called when the worker completes a turn. Return the next instruction to
   *  push, or null to end the item. */
  onTurn: (status: WorkerStatus, text: string) => Promise<string | null>;
}

export async function runItem(opts: RunItemOpts): Promise<void> {
  const { brief, cfg, item, workerPrompt, onBlock, onTurn } = opts;
  const channel = new InputChannel();
  channel.push(workerPrompt);
  const guard = makeGuard(brief.leoDir, onBlock);

  const q = query({
    prompt: channel,
    options: {
      cwd: brief.root,
      maxTurns: cfg.maxTurnsPerItem,
      permissionMode: "default",
      canUseTool: guard as never,
      settingSources: ["user", "project"] as never,
      ...(cfg.workerModel ? { model: cfg.workerModel } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: WORKER_APPEND } as never,
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
        if (next === null) { channel.close(); break; }
        channel.push(next);
      }
    } else if (msg.type === "result") {
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
}
