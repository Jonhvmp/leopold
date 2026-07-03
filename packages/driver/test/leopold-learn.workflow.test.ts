// Executes the leopold-learn workflow: disjoint-source miner fan-out, the skip of the
// transcript miner when there are no transcripts, the kill-biased skeptic filter, and
// the honest empty-result paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, workflowPath, type Responder } from "./workflow-harness.ts";

const SCRIPT = workflowPath("leopold-learn", "leopold-learn.workflow.js");

function args(over: Record<string, unknown> = {}) {
  return {
    projectDir: "/repo",
    charter: "## Always\n- verify before done",
    decisionsPaths: ["/repo/.leopold/DECISIONS.md"],
    transcriptDir: "/home/u/.claude/projects/-repo",
    outPath: "/repo/.leopold/CHARTER-amendments.md",
    maxCandidates: 12,
    ...over,
  };
}

const labelsOf = (r: { agents: Array<{ label?: string }> }) => r.agents.map((a) => a.label);

test("all three miners fan out when every source is present", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: args(),
    respond: ({ opts }) => (String(opts.label).startsWith("mine:") ? { candidates: [] } : { candidates: [] }),
  });
  const labels = labelsOf(r);
  assert.ok(labels.includes("mine:decisions"));
  assert.ok(labels.includes("mine:transcripts"));
  assert.ok(labels.includes("mine:git-history"));
});

test("the transcript miner is skipped when there are no transcripts", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: args({ transcriptDir: "" }),
    respond: () => ({ candidates: [] }),
  });
  const labels = labelsOf(r);
  assert.ok(!labels.includes("mine:transcripts"), "no transcript miner without a transcriptDir");
  assert.ok(labels.includes("mine:git-history"), "git miner always runs");
});

test("the decisions miner is skipped when there are no decision logs", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: args({ decisionsPaths: [] }),
    respond: () => ({ candidates: [] }),
  });
  assert.ok(!labelsOf(r).includes("mine:decisions"));
});

test("happy path: mine → cluster → one skeptic per candidate → only survivors proposed", async () => {
  const respond: Responder = ({ opts, prompt }) => {
    const label = String(opts.label || "");
    if (label.startsWith("mine:")) return { candidates: [{ rule: "R-raw", evidence: "seen 3x" }] };
    if (label === "cluster") return { candidates: [{ rule: "KEEP-rule", evidence: "e1" }, { rule: "DROP-rule", evidence: "e2" }] };
    if (label.startsWith("verify:")) {
      const keep = prompt.includes("KEEP-rule");
      return { keep, refined: keep ? "KEEP-rule (refined)" : "", why: keep ? "would prevent a real mistake" : "one-off" };
    }
    return "written"; // distill
  };
  const r = await runWorkflow(SCRIPT, { args: args(), respond });

  // One skeptic per clustered candidate.
  const verifies = r.agents.filter((a) => a.label?.startsWith("verify:"));
  assert.equal(verifies.length, 2);
  // The distill step ran.
  assert.ok(r.agents.some((a) => a.label === "distill"));

  const result = r.result as { proposed: number; outPath: string; rules: string[] };
  assert.equal(result.proposed, 1);
  assert.deepEqual(result.rules, ["KEEP-rule (refined)"]);
  assert.match(result.outPath, /CHARTER-amendments\.md$/);
});

test("no mined candidates → honest empty result, no charter touched", async () => {
  const r = await runWorkflow(SCRIPT, { args: args(), respond: () => ({ candidates: [] }) });
  const result = r.result as { proposed: number; outPath: null; note: string };
  assert.equal(result.proposed, 0);
  assert.equal(result.outPath, null);
  assert.ok(!r.agents.some((a) => a.label === "distill"), "no distill when nothing was mined");
});

test("all candidates killed by the skeptic → nothing proposed", async () => {
  const respond: Responder = ({ opts }) => {
    const label = String(opts.label || "");
    if (label.startsWith("mine:")) return { candidates: [{ rule: "R", evidence: "e" }] };
    if (label === "cluster") return { candidates: [{ rule: "R1", evidence: "e" }, { rule: "R2", evidence: "e" }] };
    if (label.startsWith("verify:")) return { keep: false, why: "not durable" };
    return "written";
  };
  const r = await runWorkflow(SCRIPT, { args: args(), respond });
  const result = r.result as { proposed: number; outPath: null };
  assert.equal(result.proposed, 0);
  assert.equal(result.outPath, null);
  assert.ok(!r.agents.some((a) => a.label === "distill"));
});
