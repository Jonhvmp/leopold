#!/usr/bin/env node
// leopold-driver: Leopold from npm. Install + manage the harness, conduct runs, and
// watch — without cloning the repo or running `make`. The harness assets are bundled
// into the package at build time; subcommands run them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDriver, InvalidPlanGraphError } from "./loop.js";
import { runInstall, runMenu, runWatch, runExt, runDoctor, runUp } from "./harness.js";
import { runSecrets } from "./secrets.js";
import { runInsights } from "./insights.js";
import { runGraphCommand } from "./graph-cmd.js";
import { runRecallCommand } from "./recall-cmd.js";
import { runWorkflowCommand } from "./workflow-cmd.js";
import { runPersonaCommand } from "./persona-testing/persona-cmd.js";
import { setProvider, setRoleProviders, currentProvider } from "./sdk.js";
import {
  HARNESSES, describeHarness, installedHarnesses, leopoldHome, resolveProvider, resolveRoleProviders,
  UnknownProviderError, type ProviderId,
} from "./provider.js";

const sub = process.argv[2];
const rest = process.argv.slice(3);

/** The driver's own version, read from its package.json (dist/ lives next to it). */
function version(): string {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function help(): void {
  process.stdout.write(`leopold-driver — Leopold from npm. Manage the harness, conduct runs, watch.

Usage:
  leopold-driver --version                  print the leopold-driver version
  leopold-driver up                         one-shot setup: install + permissions + extensions
  leopold-driver harness                    which harnesses are here, and what each can do
  leopold-driver home                       print the resolved Leopold asset home (hooks, scripts)
  leopold-driver install [--with-gstack]   install skills + hooks (Claude Code and/or Codex)
  leopold-driver graph [--mermaid|--json]   print + validate the plan's graph (exit 1 if invalid)
  leopold-driver insights [--json]          summarize the current run (events.jsonl)
  leopold-driver recall <query> [--json]    search this project's archived runs (.leopold/runs)
  leopold-driver recall --digest            print the bounded run-start digest of past decisions
  leopold-driver menu                       toolchain manager (serena / gstack / ovmem / enhance)
  leopold-driver watch [--port N]           live dashboard + Canvas DAG (http://127.0.0.1:4179)
  leopold-driver serena [install|doctor]    manage an extension (also: gstack, ovmem, enhance)
  leopold-driver enhance [toggle|status]    global prompt enhancer (Haiku interprets weak prompts)
  leopold-driver doctor                     run every extension's doctor
  leopold-driver update                     reinstall from this package
  leopold-driver run [--provider claude|codex] [--worktree] [--parallel N] [--budget-usd N]
                     [--no-review] [--no-hypotheses] [--smart-routing] [--learn-on-finish]
                     [--autonomy full|ask] [--dry-run]
                                             conduct the .leopold run (the SDK driver)
  leopold-driver workflow [--print] [--run] [--provider claude|codex|hybrid]
                                            compile the brief into a dynamic workflow
                                            (emit by default; --run executes it, experimental)
  leopold-driver persona run <flow> [--persona <id>|all] [--parallel N]
                                            conduct a synthetic-customer persona run headless —
                                            the same .leopold/persona/runs/ tree the
                                            /leopold-persona skill writes
  leopold-driver persona report <run-dir>   re-synthesize REPORT.md from the run's journals
  leopold-driver persona list               personas (contract status) and flows here
  leopold-driver secrets set|list [NAME]    manage the run's encrypted secret vault

'graph' is the pre-flight: it prints the plan as a graph (node kinds, dependency edges,
conditional @on routes) and validates it, before a single agent runs. A cycle, a route to an
item that does not exist, an unreachable item or an unmet @needs is an ERROR: it exits 1 with
the offending items named and nothing is dispatched. An @on route naming a signal no item
@emits is a WARNING: the edge can never fire, so it is reported — every time, in both
spellings — and the run still proceeds, because such a plan ran before this check existed.
--mermaid emits a fenced diagram, --json the machine form, --plan PATH checks a plan
outside .leopold/.

'recall' answers "what did this project already decide?" from its own archive. It searches
.leopold/runs/* — DECISIONS.md blocks first-class (Decision and Reversal outrank prose),
MISSION/PLAN/events.jsonl as prose — and prints ranked excerpts naming the run, the file
and any Reversal line. Everything it returns is past-run text framed as untrusted data,
never instructions. Lexical, cwd-scoped, zero network, zero dependencies; a project with
no archive gets "no archived runs yet" and exit 0. --json for the machine form, --limit N
to cap the hits (default 8). 'recall --digest' prints the bounded "what this project
already decided" block a run starts with — the exact bytes the SDK driver seeds, from the
same builder, so the in-session engine reads the same memory; with no archived decisions
stdout is empty (the driver seeds nothing) and stderr says so.

'persona' is the synthetic-customer harness over .leopold/persona/ (built in a session by
/leopold-persona). 'persona run <flow>' conducts one supervised worker per persona through
flows/<flow>.md — journal contract, domain allowlist and irreversibility bounds enforced by
the driver, window continuity from JOURNEY.jsonl — then writes the deterministic REPORT.md.
--persona <id> runs one persona (default: all), --parallel N fans the cast out. 'persona
report <run-dir>' rewrites REPORT.md from the journals alone, byte-identical outside the
executive-summary marker. 'persona list' answers what is here: each persona with its
contract status (ready / draft / blocked / error) and each flow with its parse verdict —
exit 0 always, including the "nothing to run" answer. LEOPOLD_APP_VERSION pins the build
identity journaled per run (fallback: the flow's own "App version pin" section).

Most commands run the bundled harness — no repo clone, no make. 'watch' needs Python 3.
Newer version: npm i -g leopold-driver@latest.

Every command that reaches a model takes --provider claude|codex — 'run', 'workflow
--run' AND 'persona run'. With both CLIs installed and no flag, Leopold picks the harness whose session it
was launched from (Codex exports CODEX_THREAD_ID, Claude Code exports CLAUDECODE); only
when that is unknowable does it fall back to Claude. LEOPOLD_PROVIDER also works.

--provider hybrid assigns a harness PER ROLE, so one run can execute on one and review on
the other:
  leopold workflow --run --provider hybrid --executor-provider codex --review-provider claude
Roles: executor (the workers), review (review lenses, hypotheses, tournament judges),
conductor (turn decisions, routing). A role left unset inherits the resolved default, and
every agent's provider is recorded in .leopold/events.jsonl. Env equivalents:
LEOPOLD_EXECUTOR_PROVIDER, LEOPOLD_REVIEW_PROVIDER, LEOPOLD_CONDUCTOR_PROVIDER.

The brief in .leopold/ is the same on both, and so are the hooks; only the seam that
reaches the model differs. Codex keeps a hook inert until you trust it once, so headless
Codex workers arm their own git lock — see "leopold harness".
--worktree isolates the run in a git worktree; --budget-usd stops it at a USD cap.
--parallel N runs up to N independent plan items at once, each in its own worktree, replaying
each item's diff onto the main tree (staged, never committed). Declare order in PLAN.md with
"- [ ] (after: 2, 3) ...". Items with no deps run concurrently.
Each item is risk-classified (sets reasoning effort) and, before it closes, a diverse-lens
review panel gates it: correctness always; +security on sensitive diffs; +does-it-actually-work
on critical items. --no-review turns the gate off; --max-review-rounds N caps fix rounds (2).
When an item is retried after a failure, a root-cause panel (3 investigators over disjoint
evidence + refuters) hands the next attempt a concrete lead (--no-hypotheses turns it off).
--smart-routing replaces keyword classification with a short read-only session that researches
the item's real blast radius (always falls back to keywords; never lowers a critical floor).
--learn-on-finish mines the finished run (its decisions + git history) into proposed charter
amendments at .leopold/CHARTER-amendments.md — it never edits CHARTER.md. Each of these toggles
can also be set in the brief's GUARDRAILS.md (review / hypotheses / smart_routing /
learn_on_finish: on|off); a CLI flag or env var overrides the brief.
--autonomy sets the JUDGMENT posture. The default, full, means nothing halts for a decision:
a @human node is executed by a role Leopold synthesizes for it from the item + CHARTER.md,
and the call it made is written to .leopold/DECISIONS.md with a Reversal line. --autonomy ask
(or "autonomy: ask" in GUARDRAILS.md) restores the old behavior — the run stops at a @human
node with awaiting_human. It is a posture on decisions only: git stays locked under both, and
no posture raises a budget, clears .leopold/STOP or edits GUARDRAILS.md.
Env: LEOPOLD_CONDUCTOR_MODEL, LEOPOLD_WORKER_MODEL, LEOPOLD_MAX_TURNS_PER_ITEM, LEOPOLD_WEBHOOK,
     LEOPOLD_WORKTREE, LEOPOLD_BUDGET_USD, LEOPOLD_REVIEW, LEOPOLD_MAX_REVIEW_ROUNDS,
     LEOPOLD_HYPOTHESES, LEOPOLD_SMART_ROUTING, LEOPOLD_LEARN_ON_FINISH, LEOPOLD_AUTONOMY
`);
}

/** Report which harnesses Leopold can drive here and what each one can do. */
function harnessReport(): number {
  const active = currentProvider();
  const present = installedHarnesses();
  process.stdout.write(`Conducting on: ${HARNESSES[active].label}  (--provider / LEOPOLD_PROVIDER to switch)\n\n`);
  for (const id of Object.keys(HARNESSES) as ProviderId[]) {
    process.stdout.write(`${id === active ? "*" : " "} ${describeHarness(id)}\n`);
    const caveat = HARNESSES[id].caveat;
    if (caveat) process.stdout.write(`    note: ${caveat}\n`);
  }
  if (!present.length) {
    process.stdout.write("\nNo harness detected on PATH. Install Claude Code or Codex CLI first.\n");
    return 1;
  }
  return 0;
}

function conduct(): void {
  runDriver(process.cwd(), process.argv.slice(2)).catch((err: unknown) => {
    // A rejected graph is not a driver failure: the pre-flight already printed the
    // named offenders, so this only adds the one-line verdict, unprefixed.
    if (err instanceof InvalidPlanGraphError) {
      console.error(err.message);
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("leopold-driver error:", msg);
    process.exit(1);
  });
}

// Resolve the harness before dispatching, so a typo in --provider fails here with a
// usable message rather than halfway through a run.
try {
  const base = resolveProvider(process.argv.slice(2));
  setProvider(base);
  // Hybrid is opt-in and per role; undefined leaves every role on `base`, which is what
  // keeps a single-provider run byte-for-byte unchanged.
  setRoleProviders(resolveRoleProviders(process.argv.slice(2), base));
} catch (err) {
  if (err instanceof UnknownProviderError) {
    console.error(`leopold-driver: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

switch (sub) {
  case "up":
    process.exit(runUp(rest));
  case "install":
  case "update":
    process.exit(runInstall(rest));
  case "graph":
    process.exit(runGraphCommand(process.cwd(), rest));
  case "insights":
    process.exit(runInsights(rest));
  case "recall":
    process.exit(runRecallCommand(process.cwd(), rest));
  case "workflow":
    runWorkflowCommand(process.cwd(), rest).then((c) => process.exit(c)).catch((err: unknown) => {
      console.error("leopold-driver workflow error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "persona":
    runPersonaCommand(process.cwd(), rest).then((c) => process.exit(c)).catch((err: unknown) => {
      console.error("leopold-driver persona error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "menu":
    process.exit(runMenu());
  case "watch":
  case "watch-web":
    process.exit(runWatch(rest));
  case "serena":
  case "gstack":
  case "ovmem":
  case "enhance":
    process.exit(runExt(sub, rest));
  case "harness":
  case "harnesses":
    process.exit(harnessReport());
  case "home":
    // One line, absolute, nothing else — this is what scripts and skills read to
    // find the hooks/templates without hardcoding a harness path.
    console.log(leopoldHome());
    process.exit(0);
  case "doctor":
    process.exit(runDoctor());
  case "secrets":
    process.exit(runSecrets(rest));
  case "--help":
  case "-h":
  case "help":
    help();
    process.exit(0);
  case "--version":
  case "-v":
  case "version":
    console.log(version());
    process.exit(0);
  default:
    // A non-flag unknown command is an error. Bare invocation, `run`, and run's flags
    // (`leopold --dry-run`, `--parallel N`, …) fall through to conducting a run —
    // `--version`/`--help` are caught above, so they no longer leak into a run.
    if (sub && sub !== "run" && !sub.startsWith("-")) {
      console.error(`leopold-driver: unknown command "${sub}". Try: leopold-driver --help`);
      process.exit(2);
    }
    conduct();
}
