#!/usr/bin/env node
// leopold-driver: the external conductor. Reads the .leopold brief from the cwd
// and orchestrates Claude Code workers through the plan, git locked.

import { runDriver } from "./loop.js";
import { runWatch } from "./watch.js";

const arg = process.argv[2] ?? "run";

// Live dashboard: `leopold-driver watch [--port N]`. Launches the local web dashboard
// for the run in the current project (http://127.0.0.1:4179).
if (arg === "watch" || arg === "watch-web") {
  runWatch(process.argv.slice(3));
} else if (arg === "--help" || arg === "-h" || arg === "help") {
  process.stdout.write(`leopold-driver - conduct Claude Code through the .leopold brief.

Usage:
  leopold-driver [run] [--dry-run]      conduct the run (default)
  leopold-driver watch [--port N]       open the live dashboard (http://127.0.0.1:4179)

Reads .leopold/ (MISSION, CHARTER, GUARDRAILS, PLAN) from the current project.

Auth:
  Uses your existing Claude Code login (your subscription) for BOTH the worker
  and the conductor. No API key needed. ANTHROPIC_API_KEY is only required in a
  headless environment that has no Claude Code auth configured.

Env:
  LEOPOLD_CONDUCTOR_MODEL      conductor model (default: your Claude Code default)
  LEOPOLD_WORKER_MODEL         worker model (default: your Claude Code default)
  LEOPOLD_MAX_TURNS_PER_ITEM   max worker turns per item (default: 40)
  LEOPOLD_WEBHOOK              optional URL for JSON POST notifications
`);
  process.exit(0);
} else {
  runDriver(process.cwd(), process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("leopold-driver error:", msg);
    process.exit(1);
  });
}
