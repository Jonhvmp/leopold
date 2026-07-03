// The experimental in-driver workflow runtime: it runs a real workflow-script body
// (meta capture, agent/pipeline/parallel/phase/log/budget) against an injected agent
// mock, so the orchestration engine is verified without the SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeWorkflow } from "../src/runtime.ts";

const SCRIPT = `
export const meta = { name: 'demo', description: 'a tiny workflow', phases: [{title:'Work'}] }
phase('Work')
log('starting')
const items = args.items
const results = await pipeline(items, (it) => agent('do ' + it, { label: 'do:' + it }))
const checks = await parallel(results.map(r => () => agent('verify ' + r, { label: 'verify' })))
return { results, checks }
`;

test("executes the script body: meta, phases, logs, and the pipeline/parallel results", async () => {
  const phases: string[] = [];
  const logs: string[] = [];
  const r = await executeWorkflow(SCRIPT, {
    args: { items: ["a", "b"] },
    runAgent: async (prompt) => prompt.toUpperCase(),
    onPhase: (t) => phases.push(t),
    onLog: (m) => logs.push(m),
  });
  assert.equal(r.meta.name, "demo");
  assert.deepEqual(phases, ["Work"]);
  assert.deepEqual(logs, ["starting"]);
  const out = r.result as { results: string[]; checks: string[] };
  assert.deepEqual(out.results, ["DO A", "DO B"]);
  assert.deepEqual(out.checks, ["VERIFY DO A", "VERIFY DO B"]);
  assert.equal(r.agentCount, 4); // 2 pipeline + 2 parallel
});

test("the concurrency cap is honored", async () => {
  let active = 0, peak = 0;
  const script = `
export const meta = { name: 'fan', description: 'x' }
await parallel(args.n.map((i) => () => agent('a' + i, {})))
return true`;
  await executeWorkflow(script, {
    args: { n: [1, 2, 3, 4, 5, 6, 7, 8] },
    concurrency: 3,
    runAgent: async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1; return "ok";
    },
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} must not exceed the cap of 3`);
  assert.ok(peak >= 2, `cap should actually parallelize (peak ${peak})`);
});

test("a throwing agent inside parallel resolves to null, not a crash", async () => {
  const script = `
export const meta = { name: 'e', description: 'x' }
return await parallel([() => agent('ok',{}), () => agent('boom',{})])`;
  const r = await executeWorkflow(script, {
    args: {},
    runAgent: async (p) => { if (p === "boom") throw new Error("kaboom"); return "fine"; },
  });
  assert.deepEqual(r.result, ["fine", null]);
});

test("the token budget stops further agents once exceeded", async () => {
  let spent = 0;
  const script = `
export const meta = { name: 'b', description: 'x' }
const out = []
for (const i of args.n) { out.push(await agent('a'+i, {})) }
return out`;
  await assert.rejects(
    executeWorkflow(script, {
      args: { n: [1, 2, 3, 4, 5] },
      budgetTokens: 100,
      tokensSpent: () => spent,
      runAgent: async () => { spent += 60; return "ok"; }, // 2 agents → 120 > 100
    }),
    /token budget/,
  );
});
