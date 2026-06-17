// Load the brief and run state from .leopold/, and the driver config from env.

import fs from "node:fs";
import path from "node:path";
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

export function initState(brief: Brief): RunState {
  const state: RunState = {
    active: true,
    iteration: 0,
    max_iterations: intFrom(brief.guardrails, "max_iterations", 50),
    consecutive_failures: 0,
    max_failures: intFrom(brief.guardrails, "max_failures", 3),
    started_at: new Date().toISOString(),
  };
  writeState(brief.leoDir, state);
  return state;
}

export function writeState(leoDir: string, state: RunState): void {
  fs.writeFileSync(path.join(leoDir, "state.json"), JSON.stringify(state, null, 2));
}

export function killSwitch(leoDir: string): boolean {
  return fs.existsSync(path.join(leoDir, "STOP"));
}

export function loadConfig(argv: string[]): DriverConfig {
  return {
    conductorModel: process.env.LEOPOLD_CONDUCTOR_MODEL || undefined,
    workerModel: process.env.LEOPOLD_WORKER_MODEL || undefined,
    maxTurnsPerItem: parseInt(process.env.LEOPOLD_MAX_TURNS_PER_ITEM ?? "40", 10),
    webhookUrl: process.env.LEOPOLD_WEBHOOK || undefined,
    dryRun: argv.includes("--dry-run"),
  };
}
