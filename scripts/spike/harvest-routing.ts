// THROWAWAY SPIKE SCRIPT — item 1 of the `decisions` mission. NOT wired into `make test`,
// NOT shipped, NOT a supported entry point. Delete it, or promote it deliberately, when the
// mission closes. It exists to answer one advisory question with numbers instead of a guess:
//
//   Over the plan items this project has ACTUALLY run, what does the deterministic keyword
//   classifier say, and what did observably happen to those items?
//
// The disagreements between those two columns are the only sample worth asking a provider
// about. This script harvests both columns and reports the sample size. It makes NO network
// call and needs no API key: the provider half of the spike runs only when a key exists, and
// is a separate step by design (GUARDRAILS "Network posture": no item requires a key to close).
//
// Run: node --import tsx scripts/spike/harvest-routing.ts [repoRoot]

import fs from "node:fs";
import path from "node:path";
import { classifyItem, type ItemClass } from "../../packages/driver/src/classify.ts";

const ROOT = process.argv[2] ?? process.cwd();

/** One archived run's worth of plan items, with the charter that was in force. */
interface Harvested {
  run: string;
  item: string;
  index: number;
  verdict: ItemClass;
  outcome: Outcome;
}
/** What observably happened, reconstructed from the run's own event log. */
interface Outcome {
  known: boolean;
  reviewBlocked?: boolean;
  retried?: boolean;
  conflict?: boolean;
}

const UNKNOWN: Outcome = { known: false };

/** Plan items, one per checkbox line. `@scenario` and other continuation lines are indented
 *  and belong to the item above them, so only column-0 checkbox lines start a new item. */
function planItems(plan: string): string[] {
  return plan
    .split("\n")
    .filter((l) => /^- \[[ x]\]/.test(l))
    .map((l) =>
      l
        .replace(/^- \[[ x]\]\s*/, "")
        .replace(/^\(after:[^)]*\)\s*/, "")
        .replace(/^@(tool|gate|verify|human|feedback)\s*/, "")
        .trim(),
    )
    .filter(Boolean);
}

/** Outcome signals, if the run left an event log. A run archived without one yields UNKNOWN
 *  for every item — which is itself the finding, not an error. */
function outcomes(runDir: string, count: number): Outcome[] {
  const log = [path.join(runDir, "events.jsonl"), path.join(ROOT, ".leopold", "events.jsonl")].find(
    (p) => fs.existsSync(p) && fs.statSync(p).size > 0,
  );
  if (!log) return Array.from({ length: count }, () => UNKNOWN);

  const per = new Map<number, Outcome>();
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const idx = Number(ev.item ?? ev.item_index ?? NaN);
    if (!Number.isFinite(idx)) continue;
    const o = per.get(idx) ?? { known: true };
    const name = String(ev.event ?? "");
    if (name === "review_blocked" || ev.blocking === true) o.reviewBlocked = true;
    if (name === "item_retry" || name === "repeated_failure") o.retried = true;
    if (name === "conflict" || name === "merge_conflict") o.conflict = true;
    per.set(idx, o);
  }
  return Array.from({ length: count }, (_, i) => per.get(i + 1) ?? UNKNOWN);
}

function harvest(): Harvested[] {
  const runsDir = path.join(ROOT, ".leopold", "runs");
  if (!fs.existsSync(runsDir)) return [];
  const rows: Harvested[] = [];
  for (const run of fs.readdirSync(runsDir).sort()) {
    const dir = path.join(runsDir, run);
    const planPath = path.join(dir, "PLAN.md");
    if (!fs.existsSync(planPath)) continue;
    const charterPath = path.join(dir, "CHARTER.md");
    const charter = fs.existsSync(charterPath) ? fs.readFileSync(charterPath, "utf8") : "";
    const items = planItems(fs.readFileSync(planPath, "utf8"));
    const obs = outcomes(dir, items.length);
    items.forEach((item, i) => {
      rows.push({ run, item, index: i + 1, verdict: classifyItem(item, charter), outcome: obs[i] });
    });
  }
  return rows;
}

/** A disagreement is an item where the regex's verdict and the observed outcome point
 *  opposite ways. These, and only these, are worth spending a provider question on. */
function disagreements(rows: Harvested[]): Harvested[] {
  return rows.filter((r) => {
    if (!r.outcome.known) return false;
    const under = !r.verdict.critical && (r.outcome.reviewBlocked || r.outcome.retried);
    const over = r.verdict.critical && !r.outcome.reviewBlocked && !r.outcome.retried && !r.outcome.conflict;
    return under || over;
  });
}

const rows = harvest();
const withOutcome = rows.filter((r) => r.outcome.known);
const diverging = disagreements(rows);

const byEffort: Record<string, number> = {};
for (const r of rows) byEffort[r.verdict.effort] = (byEffort[r.verdict.effort] ?? 0) + 1;

console.log("# Spike harvest — deterministic classifier over archived plan items\n");
console.log(`repo:                 ${ROOT}`);
console.log(`archived runs:        ${new Set(rows.map((r) => r.run)).size}`);
console.log(`plan items harvested: ${rows.length}`);
console.log(`items with a known outcome: ${withOutcome.length}`);
console.log(`usable disagreements: ${diverging.length}   <- the provider-question sample\n`);
console.log("effort distribution (regex):");
for (const [k, v] of Object.entries(byEffort).sort()) console.log(`  ${k.padEnd(7)} ${v}`);
console.log(`  critical=true  ${rows.filter((r) => r.verdict.critical).length}`);
console.log("\nper item:");
for (const r of rows) {
  const o = r.outcome.known
    ? [r.outcome.reviewBlocked && "blocked", r.outcome.retried && "retried", r.outcome.conflict && "conflict"]
        .filter(Boolean)
        .join(",") || "clean"
    : "outcome-unknown";
  console.log(
    `  ${String(r.index).padStart(2)}  ${r.verdict.effort.padEnd(6)} ${r.verdict.critical ? "CRIT" : "    "}  ${o.padEnd(16)} ${r.item.slice(0, 68)}`,
  );
}
console.log(
  `\nVERDICT: ${
    diverging.length >= 20
      ? "sample is large enough to fit thresholds"
      : "sample too small to FIT thresholds — item 12 adopts priors, documented as unmeasured"
  }`,
);
