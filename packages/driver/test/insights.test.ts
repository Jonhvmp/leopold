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
  '{"ts":"2026-06-27T10:00:08Z","event":"review","item":"b","ok":true,"blocking":0,"sensitive":true,"second_opinion":true}',
  '{"ts":"2026-06-27T10:00:09Z","event":"item_done","item":"b","applied":false}',
  '{"ts":"2026-06-27T10:00:10Z","event":"guard_block","tool":"Bash"}',
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
  assert.equal(r.reviews.secondOpinion, 2);
  assert.equal(r.guardBlocks, 1);
  assert.equal(r.costUsd, 0.52); // state spend wins when higher
  assert.equal(r.stoppedReason, "plan_complete");
});

test("summarize tolerates blank and malformed lines", () => {
  const r = summarize(["", "   ", "not json", '{"event":"cost","usd":1}', "{bad"]);
  assert.equal(r.costUsd, 1);
  assert.equal(r.events, 1); // only the one valid line counts
});

test("renderInsights produces a readable, non-empty report", () => {
  const out = renderInsights(summarize(EVENTS, { stopped_reason: "plan_complete" }));
  assert.match(out, /Leopold insights/);
  assert.match(out, /Items\s+2 done/);
  assert.match(out, /Review gate\s+3 run/);
  assert.match(out, /low/);
  assert.match(out, /max/);
});
