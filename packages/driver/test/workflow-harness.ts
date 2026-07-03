// Mock-runtime harness for exercising the dynamic-workflow scripts.
//
// The five *.workflow.js scripts under skills/**/reference/ are written for Claude
// Code's dynamic-workflow runtime: ESM with `export const meta`, top-level await,
// top-level `return`, and the injected globals agent/pipeline/parallel/phase/log/
// args/budget. `node --check` proves they parse; this harness proves their CONTROL
// FLOW — waves, lens escalation, review loops, quarantine separation, tournament
// scoring — by running the real script body against deterministic stubs.
//
// It loads the script text, rewrites `export const meta =` to an assignment onto a
// captured context (so `meta` is observable while `return` still yields the result),
// wraps the body in an AsyncFunction, and runs it with mocks that record every call.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AsyncFunction = Object.getPrototypeOf(async function () { /* c8 */ }).constructor as
  new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** One recorded agent() call. */
export interface AgentCall {
  index: number;
  prompt: string;
  opts: Record<string, unknown>;
  label?: string;
  phase?: string;
}

/** A responder decides what a mocked agent() returns for a given call. */
export type Responder = (call: { prompt: string; opts: Record<string, unknown>; index: number }) => unknown;

export interface RunResult {
  meta: Record<string, unknown>;
  result: unknown;
  agents: AgentCall[];
  phases: string[];
  logs: string[];
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** Absolute path to a reference workflow script by its skill folder + basename. */
export function workflowPath(skill: string, file: string): string {
  return path.join(REPO_ROOT, "skills", skill, "reference", file);
}

/** List every reference workflow script in the repo (for the static validator). */
export function allWorkflowScripts(): string[] {
  const skillsDir = path.join(REPO_ROOT, "skills");
  const out: string[] = [];
  for (const skill of fs.readdirSync(skillsDir)) {
    const ref = path.join(skillsDir, skill, "reference");
    if (!fs.existsSync(ref)) continue;
    for (const f of fs.readdirSync(ref)) if (f.endsWith(".workflow.js")) out.push(path.join(ref, f));
  }
  return out.sort();
}

export interface RunOptions {
  args?: unknown;
  respond?: Responder;
  budget?: { total: number | null; spent: () => number; remaining: () => number };
}

/** Execute a workflow script against deterministic mocks and capture its behavior. */
export async function runWorkflow(scriptFile: string, opts: RunOptions = {}): Promise<RunResult> {
  const raw = fs.readFileSync(scriptFile, "utf8");
  // `export const meta = {...}` -> assign onto the captured context. `meta` is not
  // referenced elsewhere in these scripts, so nothing downstream breaks.
  const transformed = raw.replace(/export\s+const\s+meta\s*=/, "__ctx.meta =");

  const agents: AgentCall[] = [];
  const phases: string[] = [];
  const logs: string[] = [];
  const respond = opts.respond ?? (() => ({}));

  const agent = async (prompt: string, o: Record<string, unknown> = {}) => {
    const index = agents.length;
    agents.push({ index, prompt, opts: o, label: o.label as string | undefined, phase: o.phase as string | undefined });
    return respond({ prompt, opts: o, index });
  };

  // pipeline: each item threads through every stage independently; collect finals.
  const pipeline = async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>) => {
    const results: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      let v: unknown = items[i];
      try {
        for (const stage of stages) v = await stage(v, items[i], i);
        results.push(v);
      } catch {
        results.push(null);
      }
    }
    return results;
  };

  // parallel: run all thunks; a throwing thunk resolves to null (matches the runtime).
  const parallel = async (thunks: Array<() => unknown>) =>
    Promise.all(thunks.map(async (t) => { try { return await t(); } catch { return null; } }));

  const phase = (title: string) => { phases.push(title); };
  const log = (msg: string) => { logs.push(String(msg)); };
  const budget = opts.budget ?? { total: null, spent: () => 0, remaining: () => Infinity };
  const ctx: { meta: Record<string, unknown> } = { meta: {} };

  const fn = new AsyncFunction(
    "agent", "pipeline", "parallel", "phase", "log", "args", "budget", "__ctx",
    transformed,
  );
  const result = await fn(agent, pipeline, parallel, phase, log, opts.args, budget, ctx);

  return { meta: ctx.meta, result, agents, phases, logs };
}
