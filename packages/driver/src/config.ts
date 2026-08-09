// Load the brief and run state from .leopold/, and the driver config from env.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseBudgetUsd } from "./budget.js";
import type { Autonomy, Brief, RunState, DriverConfig } from "./types.js";

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

/** Read `autonomy: full | ask` from GUARDRAILS.md. Undefined when the key is absent or
 *  says something this does not recognize — an unreadable posture must not silently
 *  become the strict one, and the caller's default (`full`) stands.
 *
 *  Same shape as `boolFrom` (leading `-`, `**bold**`, a trailing comment all tolerated),
 *  because this is one more line in the same list a human writes their guardrails in. */
export function autonomyFrom(text: string): Autonomy | undefined {
  const m = text.match(/^\s*-?\s*(?:\*\*)?autonomy(?:\*\*)?\s*:\s*([a-z]+)/im);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  if (v === "full") return "full";
  if (["ask", "halt", "human"].includes(v)) return "ask";
  return undefined;
}

/** Resolve the judgment posture: explicit CLI flag / env > GUARDRAILS.md > `full`.
 *  Exported for tests — the precedence is the promise, not the parsing. */
export function resolveAutonomy(argv: string[], env: string | undefined, guardrails: string): Autonomy {
  const explicit = flagValue(argv, "--autonomy") ?? (argv.includes("--ask") ? "ask" : undefined) ?? env;
  if (explicit) {
    const v = explicit.trim().toLowerCase();
    if (v === "full") return "full";
    if (["ask", "halt", "human"].includes(v)) return "ask";
    // An unrecognized value used to fall straight through to the default — and the default
    // is the PERMISSIVE posture. An operator who typed `--autonomy asks` or
    // `LEOPOLD_AUTONOMY=Ask-only` got exactly the autonomy they were trying to switch off,
    // silently. Every other knob falls back to a documented default; this one falls back to
    // the one that matters, so it says so and takes the safe side.
    console.warn(
      `  ⚠ autonomy: "${explicit}" is not a posture I know — using "ask" (the strict one). ` +
        `Valid: full | ask (halt, human also spell ask).`,
    );
    return "ask";
  }
  return autonomyFrom(guardrails) ?? "full";
}

/** Resolve a boolean knob with precedence: explicit CLI/env > GUARDRAILS > default. */
function resolveBool(explicitOn: boolean, explicitOff: boolean, fromGuardrails: boolean | undefined, dflt: boolean): boolean {
  if (explicitOn) return true;
  if (explicitOff) return false;
  if (fromGuardrails !== undefined) return fromGuardrails;
  return dflt;
}

/** How many plan items `@feedback` nodes have already added, as recorded on disk.
 *  0 when the field, the file, or the JSON is absent or unreadable — a counter that
 *  cannot be read is not a licence to spend, but it must not crash a run either. */
export function readAmendmentsAdded(leoDir: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(leoDir, "state.json"), "utf8")) as { amendments_added?: unknown };
    const n = Math.floor(Number(raw.amendments_added));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
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
    // The repeated-failure rescue (rescue.ts) is spent PER RUN, and it is written here
    // explicitly because `writeState` merges forward: a `true` left on disk by the last
    // run would otherwise deny this one its single change of approach forever. It pairs
    // with `consecutive_failures`, which starts at zero right above for the same reason —
    // the failures reset, so the one attempt that answers them resets with them.
    failure_rescue_used: false,
  };
  // The amendment budget is the ONE counter that survives re-entry. Re-running the
  // driver is the documented way to resume (every escalation and failure notice says
  // "re-run leopold-driver"), and `writeState` only ever merges forward — so a fresh
  // literal here handed every restart a full purse of 3 more items, which is exactly
  // the unbounded plan growth the bound exists to prevent. `/leopold-run` writes a
  // brand-new state.json when it activates a NEW run, so a real new run still starts
  // at zero; only a resume inherits what it already spent.
  const spent = readAmendmentsAdded(brief.leoDir);
  if (spent > 0) state.amendments_added = spent;
  writeState(brief.leoDir, state);
  return state;
}

/** Brief files a READ-ONLY node (`@gate` / `@verify` / `@feedback`) must leave exactly
 *  as it found them, hashed into one receipt. The guard refuses the shell commands that
 *  would write these (guard.ts), and this is the second net: if the bytes moved anyway,
 *  the run SAYS SO instead of passing the node's verdict off as clean.
 *
 *  Deliberately NOT the whole directory: `events.jsonl`, `state.json` and `DECISIONS.md`
 *  are written by the DRIVER while the node runs, so hashing them would cry wolf on
 *  every single node. PLAN.md is hashed with its checkboxes blanked, because a
 *  `--parallel` run legitimately closes another item mid-node — a deleted, rewritten or
 *  injected line still moves the hash, which is what the bounds are actually about.
 *
 *  Blanking them is NOT a licence to forge one. This digest covers the plan's TEXT; its
 *  checkbox state has its own receipt, `checkboxVector` + the driver's flip ledger in
 *  plan.ts, which loop.ts checks alongside this one. A checkbox that moved and is on
 *  nobody's ledger is a forgery, and gets restored — the failure the two nets exist to
 *  stop is exactly a node marking the plan done and the run ending on `plan_complete`. */
const BRIEF_RECEIPT_FILES = ["PLAN.md", "GUARDRAILS.md", "MISSION.md", "CHARTER.md", "ALLOW_GIT", "ALLOW_PUSH"] as const;

export function briefDigest(leoDir: string): string {
  return BRIEF_RECEIPT_FILES.map((name) => {
    let body: string;
    try {
      body = fs.readFileSync(path.join(leoDir, name), "utf8");
    } catch {
      return `${name} -`; // absent is a state too: creating ALLOW_GIT must move the digest
    }
    if (name === "PLAN.md") body = body.replace(/^([ \t]*-[ \t]*)\[[ xX]\]/gm, "$1[]");
    return `${name} ${createHash("sha256").update(body).digest("hex")}`;
  }).join("\n");
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
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  // `--flag=value` too. Only the space-separated form was read, so the equals form was not
  // rejected — it was IGNORED, and the flag silently fell back to its default. Harmless on
  // a number; on `--autonomy=ask` it handed back the posture the operator was switching off.
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq === undefined ? undefined : eq.slice(name.length + 1);
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
    // Conformance (R1): on by default; --no-conformance / LEOPOLD_CONFORMANCE=0 off, or `conformance:` in guardrails. Only bites when an item has @scenario lines.
    conformance: resolveBool(process.env.LEOPOLD_CONFORMANCE === "1", argv.includes("--no-conformance") || process.env.LEOPOLD_CONFORMANCE === "0", boolFrom(g, "conformance"), true),
    // Literal reset (R2): on by default; --no-literal-reset / LEOPOLD_LITERAL_RESET=0 off, or `literal_reset:` in guardrails. Only acts in a worktree-isolated run.
    literalReset: resolveBool(process.env.LEOPOLD_LITERAL_RESET === "1", argv.includes("--no-literal-reset") || process.env.LEOPOLD_LITERAL_RESET === "0", boolFrom(g, "literal_reset"), true),
    // Best-of-k (R3): 1 = off (opt-in; it costs). --best-of-k N / LEOPOLD_BEST_OF_K, else `best_of_k:` in guardrails, clamped >=1.
    bestOfK: intArg(argv, "--best-of-k", process.env.LEOPOLD_BEST_OF_K, intFrom(g, "best_of_k", 1)),
    // Slice scope: opt-in; feeds smart_routing's file set to the worker as scope. --slice-scope / LEOPOLD_SLICE_SCOPE=1, or `slice_scope:` in guardrails.
    sliceScope: resolveBool(argv.includes("--slice-scope") || process.env.LEOPOLD_SLICE_SCOPE === "1", process.env.LEOPOLD_SLICE_SCOPE === "0", boolFrom(g, "slice_scope"), false),
    // Judgment posture: `full` by default — a @human node is EXECUTED under a synthesized
    // role instead of halting the run. `--autonomy ask` / `--ask` / LEOPOLD_AUTONOMY=ask,
    // or `autonomy: ask` in guardrails, restores the halt for a plan written against it.
    autonomy: resolveAutonomy(argv, process.env.LEOPOLD_AUTONOMY, g),
  };
}
