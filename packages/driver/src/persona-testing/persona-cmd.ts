// `leopold persona <run|report|list>`: the CLI shell over the persona harness.
// Registered in index.ts exactly like `recall`; everything load-bearing lives in
// the pure/conducting modules beside this file — this file only parses flags,
// resolves `.leopold/persona/`, prints, and returns an exit code.
//
// The exit-code contract:
//   - `list` always answers with 0 — an empty module is an answer ("nothing to
//     run", with the pointer to build one), never a failure;
//   - `run` is non-zero when there is nothing to conduct (no `.leopold/`, no
//     persona module, no such flow — each named loudly, with the path) or the
//     cast itself errors;
//   - `report` is non-zero when the run dir has no readable journals;
//   - a usage error (unknown flag, missing argument) is 2, said out loud.
//
// `report` re-synthesizes REPORT.md from the journals ALONE (report.ts is
// byte-deterministic), then re-splices the existing report's executive-summary
// body — the ONE sanctioned non-deterministic region — so re-running the
// command rewrites the file byte-identical outside the summary marker.

import fs from "node:fs";
import path from "node:path";
import { findLeoDir } from "../config.js";
import { conductCast, resultLine, type ConductOptions } from "./conduct.js";
import { checkContract } from "./contract-check.js";
import { parseFlow, flowErrorMessage } from "./flow.js";
import { reportFromRunDir, spliceSummary, SUMMARY_OPEN, SUMMARY_CLOSE, SUMMARY_PLACEHOLDER } from "./report.js";

const USAGE =
  "Usage: leopold persona run <flow> [--persona <id>|all] [--parallel N] | leopold persona report <run-dir> | leopold persona list";

/** The loud empty-module answer, with the pointer to build one. One home. */
export const NOTHING_TO_RUN =
  "nothing to run — no .leopold/persona/ module here. Run /leopold-persona in a session to build the first persona contract and declare a flow.";

// -- Flag parsing ------------------------------------------------------------

/** Flags index.ts resolves globally before dispatch; their values must not be
 *  read as positionals here (same rule as recall's `--provider` skip). */
const GLOBAL_VALUE_FLAGS = ["--provider", "--executor-provider", "--review-provider", "--conductor-provider"];

interface Args {
  sub: string;
  positionals: string[];
  persona: string;
  parallel: number;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  let persona = "all";
  let parallel = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (GLOBAL_VALUE_FLAGS.includes(a)) { i++; continue; }
    if (a === "--persona") {
      const v = argv[++i];
      if (v === undefined || v === "") throw new Error(`--persona needs a persona id (or "all"). ${USAGE}`);
      persona = v;
      continue;
    }
    if (a === "--parallel") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error(`--parallel needs a positive integer. ${USAGE}`);
      parallel = v;
      continue;
    }
    if (a.startsWith("-")) throw new Error(`unknown flag "${a}". ${USAGE}`);
    positionals.push(a);
  }
  const [sub = "", ...rest] = positionals;
  return { sub, positionals: rest, persona, parallel };
}

// -- Module resolution -------------------------------------------------------

function personaDirOf(cwd: string): { leoDir: string; personaDir: string } | undefined {
  let leoDir: string;
  try {
    leoDir = findLeoDir(cwd);
  } catch {
    return undefined;
  }
  const personaDir = path.join(leoDir, "persona");
  return fs.existsSync(personaDir) ? { leoDir, personaDir } : undefined;
}

function dirNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// -- list --------------------------------------------------------------------

/** One status line per persona and per flow, sorted, from the same gates the
 *  conductor enforces (checkContract / parseFlow) — never a second opinion. */
function runList(cwd: string): number {
  const found = personaDirOf(cwd);
  if (found === undefined) {
    console.log(NOTHING_TO_RUN);
    return 0;
  }
  const { personaDir } = found;
  const personas = dirNames(path.join(personaDir, "personas"));
  const flows = (() => {
    try {
      return fs
        .readdirSync(path.join(personaDir, "flows"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  })();
  if (personas.length === 0 && flows.length === 0) {
    console.log(NOTHING_TO_RUN);
    return 0;
  }
  for (const id of personas) {
    const contractPath = path.join(personaDir, "personas", id, "contract.yaml");
    let text: string;
    try {
      text = fs.readFileSync(contractPath, "utf8");
    } catch {
      console.log(`persona ${id}: no contract — expected personas/${id}/contract.yaml`);
      continue;
    }
    const gate = checkContract(text, id);
    if (gate.status === "ready") console.log(`persona ${id}: ready`);
    else if (gate.status === "skipped") console.log(`persona ${id}: ${gate.contractStatus} — skipped when conducting`);
    else console.log(`persona ${id}: ERROR — ${gate.reason}`);
  }
  if (personas.length === 0) console.log("no personas yet — run /leopold-persona to build the first contract.");
  for (const name of flows) {
    const parsed = parseFlow(fs.readFileSync(path.join(personaDir, "flows", `${name}.md`), "utf8"));
    if (parsed.status === "ok") console.log(`flow ${name}: ok (max ${parsed.flow.maxTurns} turns)`);
    else console.log(`flow ${name}: INVALID — ${flowErrorMessage(parsed)}`);
  }
  if (flows.length === 0) console.log("no flows yet — declare one under .leopold/persona/flows/.");
  return 0;
}

// -- run ---------------------------------------------------------------------
// Per-persona result lines come from conduct.ts's own resultLine — the exact
// lines the cast notification carries, imported rather than respelled, so the
// CLI and the notification cannot drift.

/** The build identity pinned into every journal header: the explicit env pin
 *  wins; the flow's own "App version pin" section is the fallback; a run with
 *  neither is stated as unpinned, never guessed. */
export function resolveAppVersion(env: NodeJS.ProcessEnv, flowText: string | undefined): string {
  const pinned = (env.LEOPOLD_APP_VERSION ?? "").trim();
  if (pinned !== "") return pinned;
  if (flowText !== undefined) {
    const parsed = parseFlow(flowText);
    if (parsed.status === "ok" && parsed.flow.appVersionPin.trim() !== "") return parsed.flow.appVersionPin.trim();
  }
  return "unpinned";
}

async function runRun(cwd: string, args: Args): Promise<number> {
  const flow = args.positionals[0];
  if (flow === undefined || flow === "") {
    console.error(`leopold persona: which flow? ${USAGE}`);
    return 2;
  }
  const found = personaDirOf(cwd);
  if (found === undefined) {
    console.error(`leopold persona: ${NOTHING_TO_RUN}`);
    return 1;
  }
  const { leoDir, personaDir } = found;
  const flowPath = path.join(personaDir, "flows", `${flow}.md`);
  let flowText: string | undefined;
  try {
    flowText = fs.readFileSync(flowPath, "utf8");
  } catch {
    console.error(`leopold persona: no flow at ${flowPath} — declare the flow before conducting it.`);
    return 1;
  }

  const opts: ConductOptions = {
    root: path.dirname(leoDir),
    leoDir,
    personaDir,
    flow,
    personas: args.persona === "all" ? "all" : [args.persona],
    parallel: args.parallel,
    appVersion: resolveAppVersion(process.env, flowText),
    webhookUrl: process.env.LEOPOLD_WEBHOOK,
  };
  const cast = await conductCast(opts);
  if (cast.status === "error") {
    console.error(`leopold persona: ${cast.reason}`);
    return 1;
  }
  console.log(`Persona run complete — ${flow}`);
  console.log(`Report: ${cast.reportPath}`);
  for (const p of cast.personas) console.log(resultLine(p.personaId, p.result));
  return 0;
}

// -- report ------------------------------------------------------------------

/** The existing report's executive-summary body, or undefined when the file or
 *  the marked section is absent, or the section still holds the placeholder. */
export function existingSummaryOf(reportText: string): string | undefined {
  const open = reportText.indexOf(SUMMARY_OPEN);
  const close = reportText.indexOf(SUMMARY_CLOSE);
  if (open === -1 || close === -1 || close < open) return undefined;
  const body = reportText.slice(open + SUMMARY_OPEN.length, close).trim();
  if (body === "" || body === SUMMARY_PLACEHOLDER) return undefined;
  return body;
}

function runReport(cwd: string, args: Args): number {
  const arg = args.positionals[0];
  if (arg === undefined || arg === "") {
    console.error(`leopold persona: which run? ${USAGE}`);
    return 2;
  }
  const runDir = path.resolve(cwd, arg);
  const fresh = reportFromRunDir(runDir);
  if (fresh.status !== "ok") {
    console.error(`leopold persona: ${fresh.reason}`);
    return 1;
  }
  const reportPath = path.join(runDir, "REPORT.md");
  let text = fresh.text;
  try {
    const summary = existingSummaryOf(fs.readFileSync(reportPath, "utf8"));
    if (summary !== undefined) {
      const spliced = spliceSummary(text, summary);
      if (spliced.status === "ok") text = spliced.text;
    }
  } catch {
    // No existing report: the fresh render (placeholder summary) stands.
  }
  fs.writeFileSync(reportPath, text);
  console.log(reportPath);
  return 0;
}

// -- Dispatch ----------------------------------------------------------------

/** `leopold persona run|report|list`, exactly as index.ts registers it. */
export async function runPersonaCommand(cwd: string, argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`leopold persona: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  switch (args.sub) {
    case "list":
      return runList(cwd);
    case "run":
      return runRun(cwd, args);
    case "report":
      return runReport(cwd, args);
    default:
      console.error(
        args.sub === ""
          ? `leopold persona: what should I do? ${USAGE}`
          : `leopold persona: unknown subcommand "${args.sub}". ${USAGE}`,
      );
      return 2;
  }
}
