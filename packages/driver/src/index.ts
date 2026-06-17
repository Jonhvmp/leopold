#!/usr/bin/env node
// leopold-driver: the external conductor. Reads the .leopold brief from the cwd
// and orchestrates Claude Code workers through the plan, git locked.

import { runDriver } from "./loop.js";

const arg = process.argv[2] ?? "run";
if (arg === "--help" || arg === "-h" || arg === "help") {
  process.stdout.write(`leopold-driver - conduct Claude Code through the .leopold brief.

Usage:
  leopold-driver [run] [--dry-run]

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
}

runDriver(process.cwd(), process.argv.slice(2)).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("leopold-driver error:", msg);
  process.exit(1);
});
