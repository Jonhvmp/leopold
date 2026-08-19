// Unit tests for the insights aggregator (events.jsonl → report).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, renderInsights } from "../src/insights.ts";

const EVENTS = [
  '{"ts":"2026-06-27T10:00:00Z","event":"run_start","parallel":3,"review":true}',
  '{"ts":"2026-06-27T10:00:01Z","event":"item_start","item":"a","effort":"low","critical":false}',
  '{"ts":"2026-06-27T10:00:02Z","event":"cost","item":"a","usd":0.12}',
  '{"ts":"2026-06-27T10:00:03Z","event":"review","item":"a","ok":true,"blocking":0,"sensitive":false}',
  '{"ts":"2026-06-27T10:00:04Z","event":"item_done","item":"a","applied":true}',
  '{"ts":"2026-06-27T10:00:05Z","event":"item_start","item":"b","effort":"max","critical":true}',
  '{"ts":"2026-06-27T10:00:06Z","event":"review","item":"b","ok":false,"blocking":2,"sensitive":true,"second_opinion":true}',
  '{"ts":"2026-06-27T10:00:07Z","event":"cost","item":"b","usd":0.40}',
  '{"ts":"2026-06-27T10:00:08Z","event":"review","item":"b","ok":true,"blocking":0,"sensitive":true,"lenses":3,"panel":"correctness+security+does-it-actually-work"}',
  '{"ts":"2026-06-27T10:00:09Z","event":"hypothesis","item":"b","considered":3,"survived":1,"angle":"verify","confidence":8,"theory":"the flag was off"}',
  '{"ts":"2026-06-27T10:00:10Z","event":"item_done","item":"b","applied":false}',
  '{"ts":"2026-06-27T10:00:11Z","event":"guard_block","tool":"Bash"}',
];

test("summarize aggregates items, effort, reviews, cost", () => {
  const r = summarize(EVENTS, { stopped_reason: "plan_complete", spent_usd: 0.52 });
  assert.equal(r.itemsStarted, 2);
  assert.equal(r.itemsDone, 2);
  assert.equal(r.conflicts, 1); // item b applied:false
  assert.equal(r.effort.low, 1);
  assert.equal(r.effort.max, 1);
  assert.equal(r.critical, 1);
  assert.equal(r.reviews.total, 3);
  assert.equal(r.reviews.clean, 2);
  assert.equal(r.reviews.blocked, 1);
  assert.equal(r.reviews.sensitive, 2);
  // Panel counts both the old `second_opinion` flag and the new `lenses>=2` shape.
  assert.equal(r.reviews.panel, 2);
  assert.equal(r.hypotheses.runs, 1);
  assert.equal(r.hypotheses.survivors, 1);
  assert.equal(r.guardBlocks, 1);
  assert.equal(r.costUsd, 0.52); // state spend wins when higher
  assert.equal(r.stoppedReason, "plan_complete");
});

test("summarize tolerates blank and malformed lines", () => {
  const r = summarize(["", "   ", "not json", '{"event":"cost","usd":1}', "{bad"]);
  assert.equal(r.costUsd, 1);
  assert.equal(r.events, 1); // only the one valid line counts
});

// A persona cast's event stream, exactly as conduct.ts logs it through log.ts:
// 3 personas fanned out, 5 turns total, 1 abandonment, findings per persona.
const PERSONA_EVENTS = [
  '{"ts":"2026-08-18T09:00:00Z","event":"persona_run_start","flow":"checkout","personas":["casual","rushed","skeptic"],"run_dir":"runs/x"}',
  '{"ts":"2026-08-18T09:00:01Z","event":"persona_turn","persona":"casual","turn_id":"turn-1"}',
  '{"ts":"2026-08-18T09:00:02Z","event":"persona_turn","persona":"casual","turn_id":"turn-2"}',
  '{"ts":"2026-08-18T09:00:03Z","event":"persona_turn","persona":"rushed","turn_id":"turn-1"}',
  '{"ts":"2026-08-18T09:00:04Z","event":"persona_turn","persona":"skeptic","turn_id":"turn-1"}',
  '{"ts":"2026-08-18T09:00:05Z","event":"persona_turn","persona":"skeptic","turn_id":"turn-2"}',
  '{"ts":"2026-08-18T09:00:06Z","event":"persona_violation","persona":"rushed","rule":"allowlist","detail":"prod.example.org"}',
  '{"ts":"2026-08-18T09:00:07Z","event":"persona_stall","persona":"rushed","reason":"no valid turn after one retry"}',
  '{"ts":"2026-08-18T09:00:08Z","event":"persona_outcome","persona":"casual","outcome":"succeeded"}',
  '{"ts":"2026-08-18T09:00:09Z","event":"persona_outcome","persona":"skeptic","outcome":"abandoned"}',
  '{"ts":"2026-08-18T09:00:10Z","event":"persona_findings","persona":"casual","count":1}',
  '{"ts":"2026-08-18T09:00:11Z","event":"persona_findings","persona":"rushed","count":2}',
  '{"ts":"2026-08-18T09:00:12Z","event":"persona_findings","persona":"skeptic","count":2}',
];

test("summarize recognizes persona runs: cast size, turns, findings, abandonment", () => {
  const r = summarize(PERSONA_EVENTS);
  assert.equal(r.persona.casts, 1);
  assert.equal(r.persona.castSize, 3);
  assert.equal(r.persona.turns, 5);
  assert.equal(r.persona.findings, 5);
  assert.deepEqual(r.persona.outcomes, { succeeded: 1, abandoned: 1 });
  assert.equal(r.persona.abandoned, 1);
  assert.equal(r.persona.stalls, 1);
  assert.equal(r.persona.violations, 1);
});

test("renderInsights shows the persona section with the abandonment rate", () => {
  const out = renderInsights(summarize(PERSONA_EVENTS));
  assert.match(out, /Persona casts\s+1 run · 3 personas · 5 turns · 5 findings/);
  // 1 abandoned of a 3-persona cast: 33% — an abandonment is data, never hidden.
  assert.match(out, /1 abandoned/);
  assert.match(out, /\(33% abandonment\)/);
  assert.match(out, /1 stall · 1 bound violation/);
});

test("renderInsights stays silent about personas when no cast ran", () => {
  const out = renderInsights(summarize(EVENTS));
  assert.doesNotMatch(out, /Persona casts/);
});

test("renderInsights produces a readable, non-empty report", () => {
  const out = renderInsights(summarize(EVENTS, { stopped_reason: "plan_complete" }));
  assert.match(out, /Leopold insights/);
  assert.match(out, /Items\s+2 done/);
  assert.match(out, /Review gate\s+3 run/);
  assert.match(out, /low/);
  assert.match(out, /max/);
});
