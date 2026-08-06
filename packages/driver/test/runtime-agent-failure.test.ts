// A dying agent must not take the whole run with it.
//
// Regression for #51: `leopold workflow --run` parsed the brief, logged the Plan
// phase and "wave 1/N", then stopped with `reason: error` and zero items done. The
// wave loop in the canonical script has no try/catch, so an exception from one agent
// unwound past every remaining item, past executeWorkflow, and out to the CLI. The
// native Claude Code runtime returns null for a dead agent — the script is written
// against that contract — but the in-driver runtime propagated the throw instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeWorkflow } from "../src/runtime.ts";

const SCRIPT = `
export const meta = { name: 'x', description: 'd' }
const out = []
for (const id of ['a', 'b', 'c']) {
  const r = await agent('do ' + id, { label: 'impl:' + id })
  out.push({ id, result: r })
}
return out
`;

test("a throwing agent yields null and the run keeps going", async () => {
  const errors: Array<{ label: string; message: string }> = [];
  const r = await executeWorkflow(SCRIPT, {
    args: {},
    runAgent: async (_p, opts) => {
      if (opts.label === "impl:b") throw new Error("Connection closed mid-response");
      return "built " + opts.label;
    },
    onAgentError: (label, message) => errors.push({ label, message }),
  });

  const out = r.result as Array<{ id: string; result: unknown }>;
  assert.equal(out.length, 3, "every item still got its turn");
  assert.equal(out[1].result, null, "the dead agent returned null, not an exception");
  assert.equal(out[2].result, "built impl:c", "the run continued past the failure");
  assert.equal(r.agentCount, 3);
});

test("the failure is reported, not swallowed", async () => {
  const errors: Array<{ label: string; message: string }> = [];
  await executeWorkflow(SCRIPT, {
    args: {},
    runAgent: async (_p, opts) => {
      if (opts.label === "impl:b") throw new Error("Connection closed mid-response");
      return "ok";
    },
    onAgentError: (label, message) => errors.push({ label, message }),
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].label, "impl:b", "the failing agent is named");
  assert.match(errors[0].message, /Connection closed/);
});

test("a run where EVERY agent dies still completes and reports each one", async () => {
  const errors: string[] = [];
  const r = await executeWorkflow(SCRIPT, {
    args: {},
    runAgent: async () => { throw new Error("provider down"); },
    onAgentError: (label) => errors.push(label),
  });
  assert.deepEqual((r.result as Array<{ result: unknown }>).map((x) => x.result), [null, null, null]);
  assert.deepEqual(errors, ["impl:a", "impl:b", "impl:c"]);
});

test("the agent cap and the token budget still throw — those are run-level stops", async () => {
  // Not every throw should be swallowed: exceeding the cap or the budget is a
  // deliberate halt, not one agent misbehaving.
  await assert.rejects(
    () => executeWorkflow(SCRIPT, { args: {}, runAgent: async () => "ok", maxAgents: 2 }),
    /2-agent cap/,
  );
  await assert.rejects(
    () => executeWorkflow(SCRIPT, {
      args: {}, runAgent: async () => "ok",
      budgetTokens: 10, tokensSpent: () => 99,
    }),
    /token budget/,
  );
});
