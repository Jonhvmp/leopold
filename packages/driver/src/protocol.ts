// Parser for the worker's end-of-cycle STATUS contract.
//
// The worker closes each turn with a fenced block:
//
//   ```leopold-status
//   STATUS: done | needs-decision | blocked | working
//   ITEM: <plan item>
//   SUMMARY: <what happened>
//   DECISION-NEEDED: <question + options, or empty>
//   NEXT: <what it thinks comes next>
//   EVIDENCE: <tests/build result>
//   ```
//
// Parsing is deterministic; the conductor then reasons over the parsed result.

import type { WorkerStatus, WorkerStatusKind } from "./types.js";

const KINDS: WorkerStatusKind[] = ["done", "needs-decision", "blocked", "working"];

function field(body: string, name: string): string {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

/** Extract the last STATUS block from accumulated assistant text, if any. */
export function parseStatus(text: string): WorkerStatus | null {
  // Prefer a fenced ```leopold-status block; fall back to a bare STATUS: line.
  const fenceRe = /```leopold-status\s*([\s\S]*?)```/gi;
  let body: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) body = m[1]; // keep the last one
  if (body === null) {
    const idx = text.toUpperCase().lastIndexOf("STATUS:");
    if (idx === -1) return null;
    body = text.slice(idx);
  }

  const rawKind = field(body, "STATUS").toLowerCase();
  const kind = (KINDS.find((k) => rawKind.startsWith(k)) ?? "working") as WorkerStatusKind;

  return {
    kind,
    item: field(body, "ITEM"),
    summary: field(body, "SUMMARY"),
    decisionNeeded: field(body, "DECISION-NEEDED") || undefined,
    next: field(body, "NEXT") || undefined,
    evidence: field(body, "EVIDENCE") || undefined,
    raw: body.trim(),
  };
}

/** True when a turn looks complete (it emitted a terminal status). */
export function isTurnComplete(status: WorkerStatus | null): boolean {
  return !!status && status.kind !== "working";
}
