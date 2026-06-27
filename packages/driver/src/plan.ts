// PLAN.md as a dependency-aware work list for the parallel scheduler.
//
// Each markdown checkbox is one item. An item may declare dependencies on earlier
// items by 1-based position: `- [ ] (after: 1, 3) Do the thing` (or `(deps: ...)`).
// Items with no declared deps are independent and may run concurrently. The serial
// loop ignores all of this; only the --parallel scheduler reads the graph.

import fs from "node:fs";

export interface PlanItem {
  /** 1-based position among ALL checkboxes (open + done), stable for dep refs. */
  index: number;
  /** Display text, with any (after:/deps:) marker stripped. */
  text: string;
  done: boolean;
  /** 1-based indices this item must wait for. */
  deps: number[];
}

const CHECKBOX = /^[ \t]*- \[( |x|X)\]\s?(.*)$/;
const DEP_MARKER = /^\((?:after|deps)\s*:\s*([0-9,\s]+)\)\s*/i;

/** Parse a leading `(after: 1, 3)` marker off an item's text → {deps, text}. */
function splitDeps(raw: string): { deps: number[]; text: string } {
  const m = raw.match(DEP_MARKER);
  if (!m) return { deps: [], text: raw.trim() };
  const deps = m[1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 1);
  return { deps: [...new Set(deps)], text: raw.slice(m[0].length).trim() };
}

export function parsePlan(text: string): PlanItem[] {
  const items: PlanItem[] = [];
  let index = 0;
  for (const line of text.split("\n")) {
    const m = line.match(CHECKBOX);
    if (!m) continue;
    index += 1;
    const done = m[1].toLowerCase() === "x";
    const { deps, text: itemText } = splitDeps(m[2] ?? "");
    items.push({ index, text: itemText, done, deps: deps.filter((d) => d < index) });
  }
  return items;
}

export function parsePlanFile(planPath: string): PlanItem[] {
  return parsePlan(fs.readFileSync(planPath, "utf8"));
}

/** Mark the Nth checkbox (1-based, matching PlanItem.index) done. Returns the
 *  number of open items left. Index-based so the parallel scheduler can close a
 *  specific item without text matching. */
export function setItemDone(planPath: string, index: number): number {
  const lines = fs.readFileSync(planPath, "utf8").split("\n");
  let n = 0, open = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX);
    if (!m) continue;
    n += 1;
    if (n === index && m[1] === " ") lines[i] = lines[i].replace("- [ ]", "- [x]");
  }
  fs.writeFileSync(planPath, lines.join("\n"));
  for (const line of lines) { const m = line.match(CHECKBOX); if (m && m[1] === " ") open += 1; }
  return open;
}

/** Open items whose every dependency is already done — the dispatchable set,
 *  minus anything already in flight. */
export function readyItems(items: PlanItem[], inFlight: Set<number>): PlanItem[] {
  const doneIdx = new Set(items.filter((i) => i.done).map((i) => i.index));
  return items.filter(
    (i) => !i.done && !inFlight.has(i.index) && i.deps.every((d) => doneIdx.has(d)),
  );
}

/** True when no open item remains. */
export function allDone(items: PlanItem[]): boolean {
  return items.every((i) => i.done);
}

/** Open items that can never run because a dependency is missing or items form a
 *  cycle (deadlock) — used to stop the scheduler instead of spinning forever. */
export function deadlocked(items: PlanItem[], inFlight: Set<number>): boolean {
  const open = items.filter((i) => !i.done && !inFlight.has(i.index));
  return open.length > 0 && readyItems(items, inFlight).length === 0 && inFlight.size === 0;
}
