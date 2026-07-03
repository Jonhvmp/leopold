// Executes the plan-tournament workflow: three drafters from distinct stances, two
// comparative judges, a winner by summed score, and a synthesizer that receives the
// runners-up's strongest ideas (but not the winner's own — it already owns those).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, workflowPath, type Responder } from "./workflow-harness.ts";

const SCRIPT = workflowPath("leopold-brief", "plan-tournament.workflow.js");

const ARGS = { mission: "Build a CLI.", charter: "Ship simple.", projectDir: "/repo", constraints: "checkbox items" };

// Judges score risk-first highest (5+? vs...), so it should win.
const scores = {
  realism: [
    { angle: "mvp-first", score: 5, strongest: "MVP_STRONGEST", weakest: "w" },
    { angle: "risk-first", score: 9, strongest: "RISK_STRONGEST", weakest: "w" },
    { angle: "user-first", score: 3, strongest: "USER_STRONGEST", weakest: "w" },
  ],
  "mission-fit": [
    { angle: "mvp-first", score: 4, strongest: "MVP_STRONGEST", weakest: "w" },
    { angle: "risk-first", score: 8, strongest: "RISK_STRONGEST", weakest: "w" },
    { angle: "user-first", score: 2, strongest: "USER_STRONGEST", weakest: "w" },
  ],
};

const respond: Responder = ({ opts }) => {
  const label = String(opts.label || "");
  if (label.startsWith("draft:")) return { plan: [`${label} item`], rationale: "because" };
  if (label === "judge:realism") return { scores: scores.realism };
  if (label === "judge:mission-fit") return { scores: scores["mission-fit"] };
  if (label === "synthesize") return { plan: ["- [ ] final synthesized item"], notes: "grafted the good bits" };
  return {};
};

test("three drafters, two judges, and a synthesizer all run", async () => {
  const r = await runWorkflow(SCRIPT, { args: ARGS, respond });
  const labels = r.agents.map((a) => a.label);
  assert.deepEqual(labels.filter((l) => l?.startsWith("draft:")).sort(), ["draft:mvp-first", "draft:risk-first", "draft:user-first"]);
  assert.ok(labels.includes("judge:realism"));
  assert.ok(labels.includes("judge:mission-fit"));
  assert.ok(labels.includes("synthesize"));
});

test("the winner is the highest summed score across judges", async () => {
  const r = await runWorkflow(SCRIPT, { args: ARGS, respond });
  const result = r.result as { winner: string; ranking: Array<{ angle: string; total: number }> };
  assert.equal(result.winner, "risk-first");
  assert.equal(result.ranking[0].angle, "risk-first");
  assert.equal(result.ranking[0].total, 17); // 9 + 8
});

test("the synthesizer receives the runners-up's strongest ideas, not the winner's", async () => {
  const r = await runWorkflow(SCRIPT, { args: ARGS, respond });
  const synth = r.agents.find((a) => a.label === "synthesize");
  assert.ok(synth);
  assert.match(synth!.prompt, /MVP_STRONGEST/, "runner-up idea is offered for grafting");
  assert.match(synth!.prompt, /USER_STRONGEST/, "the other runner-up idea too");
  // The winner's own strongest is not re-offered — it already owns its plan.
  assert.doesNotMatch(synth!.prompt, /RISK_STRONGEST/);
});

test("the final plan comes from the synthesizer", async () => {
  const r = await runWorkflow(SCRIPT, { args: ARGS, respond });
  const result = r.result as { plan: string[] };
  assert.deepEqual(result.plan, ["- [ ] final synthesized item"]);
});

test("no drafts → honest null winner", async () => {
  const r = await runWorkflow(SCRIPT, { args: ARGS, respond: ({ opts }) => (String(opts.label).startsWith("draft:") ? null : {}) });
  const result = r.result as { winner: null; note: string };
  assert.equal(result.winner, null);
  assert.match(result.note, /No drafter/);
});
