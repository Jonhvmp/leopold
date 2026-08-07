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
//   SIGNALS: <key=value, key2=value2 — optional, only for an item declaring @emit>
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

  const signals = parseSignals(field(body, "SIGNALS"));

  return {
    kind,
    item: field(body, "ITEM"),
    summary: field(body, "SUMMARY"),
    decisionNeeded: field(body, "DECISION-NEEDED") || undefined,
    next: field(body, "NEXT") || undefined,
    evidence: field(body, "EVIDENCE") || undefined,
    ...(signals ? { signals } : {}),
    raw: body.trim(),
  };
}

/** Parse the optional `SIGNALS:` line into `key -> value`.
 *
 *  `migrated=false, coverage=91` — comma-separated, `key=value`, a bare `key` meaning
 *  `key=true` (the same shorthand `@emit key` uses). Returns undefined when the line is
 *  absent or carries nothing usable, so a status block without it is byte-identical to
 *  what this parser produced before signals existed. What the channel ACCEPTS is not
 *  decided here — the loop filters to the item's declared `@emit` keys and the bus
 *  enforces its ceilings. This only reads what the worker wrote. */
export function parseSignals(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    const key = (eq < 0 ? token : token.slice(0, eq)).trim();
    if (!key) continue;
    const value = eq < 0 ? "true" : token.slice(eq + 1).trim();
    out[key] = value.replace(/^"([\s\S]*)"$|^'([\s\S]*)'$/, (_m, d, s) => d ?? s ?? "");
  }
  return Object.keys(out).length ? out : undefined;
}

/** True when a turn looks complete (it emitted a terminal status). */
export function isTurnComplete(status: WorkerStatus | null): boolean {
  return !!status && status.kind !== "working";
}
