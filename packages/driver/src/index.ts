#!/usr/bin/env node
// leopold-driver: Leopold from npm. Install + manage the harness, conduct runs, and
// watch — without cloning the repo or running `make`. The harness assets are bundled
// into the package at build time; subcommands run them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDriver } from "./loop.js";
import { runInstall, runMenu, runWatch, runExt, runDoctor, runUp } from "./harness.js";
import { runSecrets } from "./secrets.js";
import { runInsights } from "./insights.js";
import { runWorkflowCommand } from "./workflow-cmd.js";

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
  leopold-driver install [--with-gstack]   install skills + hooks into ~/.claude
  leopold-driver insights [--json]          summarize the current run (events.jsonl)
  leopold-driver menu                       toolchain manager (serena / gstack / ovmem / enhance)
  leopold-driver watch [--port N]           live dashboard (http://127.0.0.1:4179)
  leopold-driver serena [install|doctor]    manage an extension (also: gstack, ovmem, enhance)
  leopold-driver enhance [toggle|status]    global prompt enhancer (Haiku interprets weak prompts)
  leopold-driver doctor                     run every extension's doctor
  leopold-driver update                     reinstall from this package
  leopold-driver run [--worktree] [--parallel N] [--budget-usd N] [--no-review]
                     [--no-hypotheses] [--smart-routing] [--learn-on-finish] [--dry-run]
                                            conduct the .leopold run (the SDK driver)
  leopold-driver workflow [--print] [--run] compile the brief into a dynamic workflow
                                            (emit by default; --run executes it, experimental)
  leopold-driver secrets set|list [NAME]    manage the run's encrypted secret vault

Most commands run the bundled harness — no repo clone, no make. 'watch' needs Python 3.
Newer version: npm i -g leopold-driver@latest.

Conducting a run uses your existing Claude Code login (ANTHROPIC_API_KEY only in headless).
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
Env: LEOPOLD_CONDUCTOR_MODEL, LEOPOLD_WORKER_MODEL, LEOPOLD_MAX_TURNS_PER_ITEM, LEOPOLD_WEBHOOK,
     LEOPOLD_WORKTREE, LEOPOLD_BUDGET_USD, LEOPOLD_REVIEW, LEOPOLD_MAX_REVIEW_ROUNDS,
     LEOPOLD_HYPOTHESES, LEOPOLD_SMART_ROUTING, LEOPOLD_LEARN_ON_FINISH
`);
}

function conduct(): void {
  runDriver(process.cwd(), process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("leopold-driver error:", msg);
    process.exit(1);
  });
}

switch (sub) {
  case "up":
    process.exit(runUp(rest));
  case "install":
  case "update":
    process.exit(runInstall(rest));
  case "insights":
    process.exit(runInsights(rest));
  case "workflow":
    runWorkflowCommand(process.cwd(), rest).then((c) => process.exit(c)).catch((err: unknown) => {
      console.error("leopold-driver workflow error:", err instanceof Error ? err.message : String(err));
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
