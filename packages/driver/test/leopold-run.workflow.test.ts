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

// Regression: a real run (wf_63757ab2-647) lost two implement agents to "Connection
// closed mid-response" and still reported 13/13 done. The script had handed the item
// straight to review; an empty diff draws no blocking findings, so the item closed as
// DONE on work that never happened. A dead implementer must never be reviewed.
test("a dead implement agent is retried, never reviewed as a clean diff", async () => {
  const dies: Responder = ({ opts }) =>
    String(opts.label || "").startsWith("impl:") ? null : { ok: true, blocking: [] };

  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[{ id: "i1", text: "build it", effort: "medium", critical: false, sensitive: false }]], 2),
    respond: dies,
  });

  // It must not have reviewed anything: there was no diff to review.
  assert.equal(r.agents.filter((a) => a.label?.startsWith("verify:")).length, 0);
  // It retried up to the budget, then reported the item as NOT done.
  const report = r.result as { done: number; total: number; incomplete: Array<{ blocking: Array<{ issue: string }> }> };
  assert.equal(report.done, 0, "an item whose implementer died is not done");
  assert.equal(report.total, 1);
  assert.match(report.incomplete[0].blocking[0].issue, /never returned|nothing was built/i);
});

test("a first-attempt death still lets a later attempt finish the item", async () => {
  let attempt = 0;
  const diesOnce: Responder = ({ opts }) => {
    const label = String(opts.label || "");
    if (label.startsWith("impl:")) return ++attempt === 1 ? null : "built on the retry";
    return { ok: true, blocking: [] };
  };

  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[{ id: "i1", text: "build it", effort: "medium", critical: false, sensitive: false }]], 2),
    respond: diesOnce,
  });

  assert.equal(attempt, 2, "the dead round is charged and retried");
  assert.equal((r.result as { done: number }).done, 1);
  assert.equal(r.agents.filter((a) => a.label?.startsWith("verify:")).length, 1, "only the surviving attempt is reviewed");
});

// Regression: the first launch of wf_3b16a7c3-c27 got `args` as a JSON STRING, so
// `waves` came out empty and the run returned {total:0, done:0} in 221ms having
// spawned zero agents — a silent no-op that reads exactly like a clean finish.
test("a stringified args payload is parsed, not silently treated as an empty plan", async () => {
  const payload = JSON.stringify(baseArgs([[{ id: "i1", text: "do it", effort: "medium", critical: false, sensitive: false }]]));
  const r = await runWorkflow(SCRIPT, { args: payload as unknown as object, respond: cleanPanel });
  assert.equal((r.result as { total: number; done: number }).total, 1);
  assert.equal((r.result as { done: number }).done, 1);
});

test("an empty plan throws instead of reporting a clean zero-item run", async () => {
  await assert.rejects(
    () => runWorkflow(SCRIPT, { args: baseArgs([]), respond: cleanPanel }),
    /no plan items reached the workflow/i,
  );
});

// --- issue #60's runtime half: scenarios must reach the prompts, or conformance is a rubber stamp
test("@scenario lines reach the implementer AND the reviewer prompts", async () => {
  const prompts: Record<string, string[]> = { impl: [], verify: [] };
  const r = await runWorkflow(SCRIPT, {
    args: baseArgs([[{
      id: "i1",
      text: "Register the JSON flag — done when: the CLI emits valid JSON on stdout and the table keeps printing unchanged.",
      scenarios: ["no flag → the table prints unchanged", "flag set → stdout is valid JSON"],
      effort: "medium", critical: false, sensitive: false,
    }]]),
    respond: ({ prompt, opts }) => {
      const label = String(opts.label || "");
      if (label.startsWith("verify:")) { prompts.verify.push(prompt); return { ok: true, blocking: [] }; }
      prompts.impl.push(prompt); return "impl done";
    },
  });
  assert.equal((r.result as { done: number }).done, 1);
  for (const [who, seen] of Object.entries(prompts)) {
    assert.ok(seen.length > 0, `no ${who} prompt captured`);
    for (const s of ["no flag → the table prints unchanged", "flag set → stdout is valid JSON"]) {
      assert.ok(seen[0].includes(s), `${who} prompt is missing the acceptance case "${s}" — conformance would pass vacuously`);
    }
  }
  // And an item with NO scenarios builds the prompt this script has always built.
  const plain = await runWorkflow(SCRIPT, {
    args: baseArgs([[{ id: "i1", text: "plain", effort: "medium", critical: false, sensitive: false }]]),
    respond: ({ prompt, opts }) => {
      if (!String(opts.label || "").startsWith("verify:"))
        assert.ok(!prompt.includes("acceptance case"), "a scenario-less item must not grow a scenarios block");
      return String(opts.label || "").startsWith("verify:") ? { ok: true, blocking: [] } : "impl done";
    },
  });
  assert.equal((plain.result as { done: number }).done, 1);
});
