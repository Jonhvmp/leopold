// Observability: the decision trail (DECISIONS.md), the event stream
// (events.jsonl), and plan bookkeeping (PLAN.md checkboxes).

import fs from "node:fs";
import path from "node:path";
import type { WorkerStatus, ConductorVerdict } from "./types.js";

export function logEvent(leoDir: string, event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(path.join(leoDir, "events.jsonl"), line + "\n");
}

let decisionCounter = 0;

/** The width the trail's field names are padded to (`Fork:` + 8 spaces). */
const FIELD_WIDTH = 13;

/** Append one block to DECISIONS.md. ONE WRITER for that file: the conductor's calls
 *  and a `@feedback` node's plan amendments both land here, so the audit trail cannot
 *  end up with two shapes depending on who wrote the entry. */
export function appendDecisionBlock(
  leoDir: string,
  heading: string,
  fields: Array<[string, string]>,
): void {
  const block =
    ["", `## ${heading}`, ...fields.map(([k, v]) => `${`${k}:`.padEnd(FIELD_WIDTH)}${v}`), ""].join("\n") + "\n";
  fs.appendFileSync(path.join(leoDir, "DECISIONS.md"), block);
}

export function logDecision(
  leoDir: string,
  iteration: number,
  status: WorkerStatus,
  v: ConductorVerdict,
): void {
  if (!v.logTitle) return; // mechanical calls are not logged as blocks
  decisionCounter += 1;
  appendDecisionBlock(
    leoDir,
    `D${decisionCounter} — ${v.logTitle}   (turn ${iteration}, ${new Date().toISOString()})`,
    [
      ["Fork", status.decisionNeeded ?? status.summary],
      ["Class", v.classification],
      ["Charter", v.charterBasis],
      ["Decision", v.reply ?? "(finish item)"],
      ["Why", v.logWhy ?? ""],
      ["Reversal", v.reversal ?? ""],
    ],
  );
}

export function openItems(planPath: string): number {
  const text = fs.readFileSync(planPath, "utf8");
  return (text.match(/^[ \t]*- \[ \]/gm) ?? []).length;
}

export function nextOpenItem(planPath: string): string | null {
  const text = fs.readFileSync(planPath, "utf8");
  const m = text.match(/^[ \t]*- \[ \] (.*)$/m);
  return m ? m[1].trim() : null;
}

/** Mark the open item whose text matches `itemText` as done; fall back to the
 *  first open item. Returns the number of open items remaining. */
export function markItemDone(planPath: string, itemText: string): number {
  const lines = fs.readFileSync(planPath, "utf8").split("\n");
  const needle = itemText.trim().slice(0, 40);
  let marked = false;
  for (let i = 0; i < lines.length && !marked; i++) {
    if (/^[ \t]*- \[ \]/.test(lines[i]) && (needle === "" || lines[i].includes(needle))) {
      lines[i] = lines[i].replace("- [ ]", "- [x]");
      marked = true;
    }
  }
  if (!marked) {
    for (let i = 0; i < lines.length && !marked; i++) {
      if (/^[ \t]*- \[ \]/.test(lines[i])) {
        lines[i] = lines[i].replace("- [ ]", "- [x]");
        marked = true;
      }
    }
  }
  fs.writeFileSync(planPath, lines.join("\n"));
  return openItems(planPath);
}
