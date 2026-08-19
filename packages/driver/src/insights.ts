// `leopold insights`: turn a run's events.jsonl into a readable report — where the
// time, tokens, and decisions went, and what the run got stuck on. The same data
// the watch dashboard streams live, summarized after the fact so it can feed back
// into better briefs. Pure aggregation (summarize) is unit-tested; runInsights just
// reads the files and prints.

import fs from "node:fs";
import path from "node:path";
import { findLeoDir } from "./config.js";

interface Ev { event?: string; ts?: string; [k: string]: unknown; }

export interface InsightsReport {
  events: number;
  firstTs?: string;
  lastTs?: string;
  itemsStarted: number;
  itemsDone: number;
  itemsIncomplete: number;
  conflicts: number;
  effort: Record<string, number>;
  critical: number;
  reviews: { total: number; blocked: number; clean: number; sensitive: number; panel: number };
  hypotheses: { runs: number; survivors: number };
  /** Plan amendments a `@feedback` node proposed: what the bounds let through, and
   *  what they refused. Both stay 0 for a run with no feedback node. */
  amendments: { applied: number; refused: number };
  learnProposed?: number;
  /** Persona casts (conduct.ts events). All zero for a run with no persona
   *  activity — and the rendered report stays silent about personas then. */
  persona: {
    casts: number;
    castSize: number;
    turns: number;
    findings: number;
    outcomes: Record<string, number>;
    abandoned: number;
    stalls: number;
    violations: number;
  };
  guardBlocks: number;
  escalations: number;
  decisions: number;
  costUsd: number;
  stoppedReason?: string;
}

function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

export function summarize(lines: string[], state: Record<string, unknown> = {}): InsightsReport {
  const r: InsightsReport = {
    events: 0, itemsStarted: 0, itemsDone: 0, itemsIncomplete: 0, conflicts: 0,
    effort: {}, critical: 0,
    reviews: { total: 0, blocked: 0, clean: 0, sensitive: 0, panel: 0 },
    hypotheses: { runs: 0, survivors: 0 },
    amendments: { applied: 0, refused: 0 },
    persona: { casts: 0, castSize: 0, turns: 0, findings: 0, outcomes: {}, abandoned: 0, stalls: 0, violations: 0 },
    guardBlocks: 0, escalations: 0, decisions: 0, costUsd: 0,
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let e: Ev;
    try { e = JSON.parse(t) as Ev; } catch { continue; }
    r.events += 1;
    if (typeof e.ts === "string") { r.firstTs ??= e.ts; r.lastTs = e.ts; }
    switch (e.event) {
      case "item_start":
        r.itemsStarted += 1;
        if (typeof e.effort === "string") r.effort[e.effort] = (r.effort[e.effort] ?? 0) + 1;
        if (e.critical === true) r.critical += 1;
        break;
      case "item_done":
        r.itemsDone += 1;
        if (e.applied === false) r.conflicts += 1;
        break;
      case "item_incomplete": r.itemsIncomplete += 1; break;
      case "review":
        r.reviews.total += 1;
        if (e.ok === true) r.reviews.clean += 1; else r.reviews.blocked += 1;
        if (e.sensitive === true) r.reviews.sensitive += 1;
        // A multi-lens panel ran: new events carry `lenses` (a count); tolerate the
        // old `second_opinion` flag so archived runs still summarize.
        if (num(e.lenses) >= 2 || e.second_opinion === true) r.reviews.panel += 1;
        break;
      case "hypothesis":
        r.hypotheses.runs += 1;
        if (typeof e.theory === "string" && e.theory) r.hypotheses.survivors += 1;
        break;
      case "learn":
        r.learnProposed = num(e.proposed);
        break;
      case "persona_run_start":
        r.persona.casts += 1;
        r.persona.castSize += Array.isArray(e.personas) ? e.personas.length : 0;
        break;
      case "persona_turn": r.persona.turns += 1; break;
      case "persona_findings": r.persona.findings += num(e.count); break;
      case "persona_outcome":
        if (typeof e.outcome === "string") {
          r.persona.outcomes[e.outcome] = (r.persona.outcomes[e.outcome] ?? 0) + 1;
          if (e.outcome === "abandoned") r.persona.abandoned += 1;
        }
        break;
      case "persona_stall": r.persona.stalls += 1; break;
      case "persona_violation": r.persona.violations += 1; break;
      case "amendment": r.amendments.applied += 1; break;
      case "amendment_refused": r.amendments.refused += 1; break;
      case "guard_block": r.guardBlocks += 1; break;
      case "cost": r.costUsd += num(e.usd); break;
    }
  }
  // Escalations/decisions are clearer from state + DECISIONS, but events carry stop.
  if (typeof state.stopped_reason === "string") r.stoppedReason = state.stopped_reason;
  if (typeof state.spent_usd === "number" && state.spent_usd > r.costUsd) r.costUsd = state.spent_usd;
  return r;
}

/** Count decision blocks (## D...) and escalation hand-offs from the trail files. */
function trailCounts(leoDir: string): { decisions: number; escalations: number } {
  let decisions = 0, escalations = 0;
  try {
    const d = fs.readFileSync(path.join(leoDir, "DECISIONS.md"), "utf8");
    decisions = (d.match(/^## D\d+/gm) ?? []).length;
  } catch { /* none yet */ }
  try {
    const ev = fs.readFileSync(path.join(leoDir, "events.jsonl"), "utf8");
    escalations = (ev.match(/"reason":"escalation"/g) ?? []).length;
  } catch { /* none */ }
  return { decisions, escalations };
}

function bar(n: number, max: number, width = 18): string {
  const filled = max > 0 ? Math.round((n / max) * width) : 0;
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
}

/** The persona section, silent unless a cast actually ran. Abandonment is a
 *  rate over the cast — an abandonment is data, never smoothed away. */
function personaLines(p: InsightsReport["persona"]): string[] {
  if (p.casts === 0) return [];
  const rate = p.castSize > 0 ? Math.round((p.abandoned / p.castSize) * 100) : 0;
  const outcomes = Object.keys(p.outcomes).sort().map((k) => `${p.outcomes[k]} ${k}`).join(" · ") || "none declared";
  return [
    `Persona casts    ${p.casts} run · ${p.castSize} persona${p.castSize === 1 ? "" : "s"} · ${p.turns} turns · ${p.findings} finding${p.findings === 1 ? "" : "s"}`,
    `                 outcomes: ${outcomes}  (${rate}% abandonment)` +
      (p.stalls || p.violations ? `  ·  ${p.stalls} stall${p.stalls === 1 ? "" : "s"} · ${p.violations} bound violation${p.violations === 1 ? "" : "s"}` : ""),
  ];
}

export function renderInsights(r: InsightsReport): string {
  const dur = r.firstTs && r.lastTs
    ? `${Math.max(0, Math.round((Date.parse(r.lastTs) - Date.parse(r.firstTs)) / 1000))}s` : "—";
  const efOrder = ["low", "medium", "high", "xhigh", "max"];
  const efMax = Math.max(1, ...Object.values(r.effort));
  const efLines = efOrder.filter((k) => r.effort[k]).map((k) =>
    `    ${k.padEnd(7)} ${bar(r.effort[k], efMax)} ${r.effort[k]}`).join("\n") || "    (none)";
  const reviewRate = r.reviews.total ? Math.round((r.reviews.clean / r.reviews.total) * 100) : 0;
  return [
    `Leopold insights`,
    `────────────────`,
    `Duration         ${dur}     Events ${r.events}     Stopped: ${r.stoppedReason ?? "—"}`,
    `Spend            $${r.costUsd.toFixed(4)}`,
    ``,
    `Items            ${r.itemsDone} done · ${r.itemsIncomplete} incomplete · ${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"}  (of ${r.itemsStarted} started)`,
    `Effort mix`,
    efLines,
    `Critical items   ${r.critical}`,
    ``,
    `Review gate      ${r.reviews.total} run · ${r.reviews.clean} clean · ${r.reviews.blocked} sent back  (${reviewRate}% first-pass clean)`,
    `                 ${r.reviews.sensitive} security-sensitive · ${r.reviews.panel} multi-lens panel`,
    `Root-cause panel ${r.hypotheses.runs} run · ${r.hypotheses.survivors} produced a lead`,
    ...(r.learnProposed !== undefined ? [`Charter amendments ${r.learnProposed} proposed (learn-on-finish)`] : []),
    // A run that rewrote its own plan says so. Silent only when it did not touch it.
    ...(r.amendments.applied || r.amendments.refused
      ? [`Plan amendments  ${r.amendments.applied} applied · ${r.amendments.refused} refused by a bound (@feedback)`]
      : []),
    ...personaLines(r.persona),
    `Decisions logged ${r.decisions}     Escalations ${r.escalations}     Guard blocks ${r.guardBlocks}`,
  ].join("\n");
}

export function runInsights(argv: string[]): number {
  let leoDir: string;
  try { leoDir = findLeoDir(process.cwd()); }
  catch { console.error("leopold insights: no .leopold/ here. Run /leopold-brief first."); return 1; }

  const evPath = path.join(leoDir, "events.jsonl");
  const lines = fs.existsSync(evPath) ? fs.readFileSync(evPath, "utf8").split("\n") : [];
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(fs.readFileSync(path.join(leoDir, "state.json"), "utf8")); } catch { /* none */ }

  const report = summarize(lines, state);
  const trail = trailCounts(leoDir);
  report.decisions = trail.decisions;
  report.escalations = trail.escalations;

  if (argv.includes("--json")) { console.log(JSON.stringify(report, null, 2)); return 0; }
  console.log(renderInsights(report));
  return 0;
}
