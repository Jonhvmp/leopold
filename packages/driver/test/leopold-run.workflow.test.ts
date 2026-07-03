// Executes the leopold-run workflow script against the mock runtime and asserts its
// real control flow: meta, dependency-wave order, lens escalation, the review→fix
// loop, maxReviewRounds, and the report shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, workflowPath, type Responder } from "./workflow-harness.ts";

const SCRIPT = workflowPath("leopold-workflow", "leopold-run.workflow.js");

function baseArgs(waves: unknown[], maxReviewRounds = 2) {
  return { mission: "# Mission\nShip the thing.", charter: "Be pragmatic.", maxReviewRounds, waves };
}

// A responder where every review panel is clean, so items finish on the first round.
const cleanPanel: Responder = ({ opts }) =>
  String(opts.label || "").startsWith("verify:") ? { ok: true, blocking: [] } : "impl done";

test("meta is well-formed and Plan/Report phases run", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[{ id: "i1", text: "do a thing", effort: "medium", critical: false, sensitive: false }]]),
    respond: cleanPanel,
  });
  assert.equal(r.meta.name, "leopold-run");
  assert.ok(typeof r.meta.description === "string" && (r.meta.description as string).length > 0);
  assert.ok(r.phases.includes("Plan"));
  assert.ok(r.phases.includes("Report"));
});

test("lens escalation: ordinary → 1 verifier, sensitive → 2, critical → 3", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[
      { id: "ord", text: "ordinary", effort: "medium", critical: false, sensitive: false },
      { id: "sen", text: "touch secrets", effort: "high", critical: false, sensitive: true },
      { id: "crit", text: "billing", effort: "max", critical: true, sensitive: true },
    ]]),
    respond: cleanPanel,
  });
  const verifiers = (id: string) => r.agents.filter((a) => a.label?.startsWith(`verify:${id}:`)).map((a) => a.label!.split(":")[2]);
  assert.deepEqual(verifiers("ord"), ["correctness"]);
  assert.deepEqual(verifiers("sen"), ["correctness", "security"]);
  assert.deepEqual(verifiers("crit"), ["correctness", "security", "does-it-actually-work"]);
});

test("waves run in dependency order: wave 1 fully before wave 2", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([
      [{ id: "a", text: "first", effort: "low", critical: false, sensitive: false }],
      [{ id: "b", text: "second", effort: "low", critical: false, sensitive: false }],
    ]),
    respond: cleanPanel,
  });
  const implOrder = r.agents.filter((a) => a.label?.startsWith("impl:")).map((a) => a.label);
  assert.deepEqual(implOrder, ["impl:a", "impl:b"]);
});

test("a blocking review re-runs the impl agent, then a clean round finishes the item", async () => {
  let verifyCount = 0;
  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[{ id: "i1", text: "ordinary", effort: "medium", critical: false, sensitive: false }]]),
    respond: ({ opts }) => {
      if (String(opts.label || "").startsWith("verify:")) {
        verifyCount += 1;
        return verifyCount === 1 ? { ok: false, blocking: [{ file: "a.ts", issue: "bug" }] } : { ok: true, blocking: [] };
      }
      return "impl done";
    },
  });
  const impls = r.agents.filter((a) => a.label === "impl:i1");
  assert.equal(impls.length, 2, "impl runs twice: once, then again after the blocking review");
  // The second impl prompt carries the reviewer feedback.
  assert.match(impls[1].prompt, /prior review found blocking issues/i);
  const result = r.result as { done: number; incomplete: unknown[] };
  assert.equal(result.done, 1);
  assert.equal(result.incomplete.length, 0);
});

test("maxReviewRounds bounds the retries and leaves a still-blocking item incomplete", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[{ id: "i1", text: "ordinary", effort: "medium", critical: false, sensitive: false }]], 2),
    respond: ({ opts }) =>
      String(opts.label || "").startsWith("verify:") ? { ok: false, blocking: [{ file: "a.ts", issue: "still broken" }] } : "impl",
  });
  const impls = r.agents.filter((a) => a.label === "impl:i1");
  assert.equal(impls.length, 3, "impl runs maxReviewRounds + 1 = 3 times, then gives up");
  const result = r.result as { done: number; incomplete: Array<{ item: string }> };
  assert.equal(result.done, 0);
  assert.equal(result.incomplete.length, 1);
});

test("report summarizes done vs incomplete and notes nothing was committed", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[{ id: "i1", text: "x", effort: "low", critical: false, sensitive: false }]]),
    respond: cleanPanel,
  });
  const result = r.result as { total: number; done: number; note: string };
  assert.equal(result.total, 1);
  assert.equal(result.done, 1);
  assert.match(result.note, /nothing was committed/i);
});
