// Load the brief and run state from .leopold/, and the driver config from env.

import fs from "node:fs";
import path from "node:path";
import { parseBudgetUsd } from "./budget.js";
import type { Brief, RunState, DriverConfig } from "./types.js";

export function findLeoDir(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    const leo = path.join(dir, ".leopold");
    if (fs.existsSync(leo)) return leo;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("No .leopold/ found here. Run /leopold-brief first to write the brief.");
}

function read(leoDir: string, name: string): string {
  const p = path.join(leoDir, name);
  if (!fs.existsSync(p)) throw new Error(`Missing ${name} in .leopold/. Run /leopold-brief first.`);
  return fs.readFileSync(p, "utf8");
}

export function loadBrief(cwd: string): Brief {
  const leoDir = findLeoDir(cwd);
  return {
    mission: read(leoDir, "MISSION.md"),
    charter: read(leoDir, "CHARTER.md"),
    guardrails: read(leoDir, "GUARDRAILS.md"),
    planPath: path.join(leoDir, "PLAN.md"),
    root: path.dirname(leoDir),
    leoDir,
  };
}

function intFrom(text: string, key: string, fallback: number): number {
  const m = text.match(new RegExp(`${key}\\s*:\\s*(\\d+)`, "i"));
  return m ? parseInt(m[1], 10) : fallback;
}

/** Read a `key: on|off` toggle from GUARDRAILS.md. Undefined when the key is absent
 *  (so the caller can fall back to a default). Tolerates a trailing `# comment`. */
export function boolFrom(text: string, key: string): boolean | undefined {
  const m = text.match(new RegExp(`^\\s*-?\\s*${key}\\s*:\\s*([a-z0-9]+)`, "im"));
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  if (["on", "true", "yes", "enabled", "1"].includes(v)) return true;
  if (["off", "false", "no", "disabled", "0"].includes(v)) return false;
  return undefined;
}

/** Resolve a boolean knob with precedence: explicit CLI/env > GUARDRAILS > default. */
function resolveBool(explicitOn: boolean, explicitOff: boolean, fromGuardrails: boolean | undefined, dflt: boolean): boolean {
  if (explicitOn) return true;
  if (explicitOff) return false;
  if (fromGuardrails !== undefined) return fromGuardrails;
  return dflt;
}

export function initState(brief: Brief): RunState {
  const state: RunState = {
    active: true,
    iteration: 0,
    max_iterations: intFrom(brief.guardrails, "max_iterations", 50),
    consecutive_failures: 0,
    max_failures: intFrom(brief.guardrails, "max_failures", 3),
    started_at: new Date().toISOString(),
    orchestrator_pid: process.pid,
  };
  writeState(brief.leoDir, state);
  return state;
}

/** Persist run state by MERGING over what's already on disk. The bash skill and
 *  Stop-hook write fields the driver's RunState doesn't model (session_id,
 *  max_subagents, …); a full overwrite would drop them (and they'd drop ours).
 *  Read-merge-write keeps both writers' fields intact. */
export function writeState(leoDir: string, state: RunState): void {
  const p = path.join(leoDir, "state.json");
  let onDisk: Record<string, unknown> = {};
  try {
    if (fs.existsSync(p)) onDisk = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch { /* corrupt/absent — fall back to a clean write */ }
  fs.writeFileSync(p, JSON.stringify({ ...onDisk, ...state }, null, 2));
}

export function killSwitch(leoDir: string): boolean {
  return fs.existsSync(path.join(leoDir, "STOP"));
}

/** Safety hygiene on stop: clear the kill switch and per-session git opt-in
 *  tokens so the next run re-locks git and does not halt on a stale STOP. */
export function clearRunTokens(leoDir: string): void {
  for (const t of ["STOP", "ALLOW_GIT", "ALLOW_PUSH"]) {
    try { fs.rmSync(path.join(leoDir, t), { force: true }); } catch { /* ignore */ }
  }
}

/** Read `--flag value` from argv (the value is the next token). */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Parse a positive integer flag/env, clamped to >=1, with a fallback. */
function intArg(argv: string[], name: string, env: string | undefined, fallback: number): number {
  const raw = flagValue(argv, name) ?? env;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Load the driver config. Precedence for each toggle: explicit CLI flag / env var >
 *  the run's GUARDRAILS.md > built-in default — so the brief can set the posture and
 *  a one-off flag can still override it. Pass the brief's guardrails text to honor it. */
export function loadConfig(argv: string[], guardrails = ""): DriverConfig {
  const g = guardrails;
  return {
    conductorModel: process.env.LEOPOLD_CONDUCTOR_MODEL || undefined,
    workerModel: process.env.LEOPOLD_WORKER_MODEL || undefined,
    maxTurnsPerItem: parseInt(process.env.LEOPOLD_MAX_TURNS_PER_ITEM ?? "40", 10),
    webhookUrl: process.env.LEOPOLD_WEBHOOK || undefined,
    dryRun: argv.includes("--dry-run"),
    worktree: argv.includes("--worktree") || process.env.LEOPOLD_WORKTREE === "1",
    budgetUsd: parseBudgetUsd(flagValue(argv, "--budget-usd") ?? process.env.LEOPOLD_BUDGET_USD),
    // Review gate: on by default; --no-review / LEOPOLD_REVIEW=0 off, or `review:` in guardrails.
    review: resolveBool(process.env.LEOPOLD_REVIEW === "1", argv.includes("--no-review") || process.env.LEOPOLD_REVIEW === "0", boolFrom(g, "review"), true),
    maxReviewRounds: intArg(argv, "--max-review-rounds", process.env.LEOPOLD_MAX_REVIEW_ROUNDS, 2),
    parallel: intArg(argv, "--parallel", process.env.LEOPOLD_PARALLEL, 1),
    // Hypothesis panel: on by default; --no-hypotheses / LEOPOLD_HYPOTHESES=0 off, or `hypotheses:` in guardrails.
    hypotheses: resolveBool(process.env.LEOPOLD_HYPOTHESES === "1", argv.includes("--no-hypotheses") || process.env.LEOPOLD_HYPOTHESES === "0", boolFrom(g, "hypotheses"), true),
    // Smart routing: opt-in (a short session per item to research blast radius).
    smartRouting: resolveBool(argv.includes("--smart-routing") || process.env.LEOPOLD_SMART_ROUTING === "1", process.env.LEOPOLD_SMART_ROUTING === "0", boolFrom(g, "smart_routing"), false),
    // Learn-on-finish: opt-in mining of the just-finished run into charter amendments.
    learnOnFinish: resolveBool(argv.includes("--learn-on-finish") || process.env.LEOPOLD_LEARN_ON_FINISH === "1", process.env.LEOPOLD_LEARN_ON_FINISH === "0", boolFrom(g, "learn_on_finish"), false),
  };
}
