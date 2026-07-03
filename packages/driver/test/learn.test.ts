// Pure helpers of learn-on-finish: candidate/skeptic parsing, empty-decisions
// detection, and proposal formatting. The SDK orchestration is not exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCandidates, parseSkeptic, decisionsAreEmpty, formatAmendments } from "../src/learn.ts";

test("parseCandidates reads the candidates array (fenced JSON tolerated)", () => {
  const c = parseCandidates('```json\n{"candidates":[{"rule":"prefer X","evidence":"seen 3x"},{"rule":"","evidence":"drop me"}]}\n```');
  assert.equal(c.length, 1, "candidates without a rule are dropped");
  assert.equal(c[0].rule, "prefer X");
  assert.equal(c[0].evidence, "seen 3x");
});

test("parseCandidates returns [] on garbage", () => {
  assert.deepEqual(parseCandidates("no json here"), []);
  assert.deepEqual(parseCandidates('{"candidates":"not an array"}'), []);
});

test("parseSkeptic keeps only on literal true and fails closed otherwise", () => {
  assert.deepEqual(parseSkeptic('{"keep":true,"refined":"prefer X (tightened)","why":"recurs"}'), { keep: true, refined: "prefer X (tightened)", why: "recurs" });
  assert.equal(parseSkeptic('{"keep":false,"why":"one-off"}').keep, false);
  assert.equal(parseSkeptic('{"keep":"yes"}').keep, false, "non-boolean keep is not kept");
  assert.equal(parseSkeptic("rambled with no json").keep, false, "unparseable fails closed");
});

test("decisionsAreEmpty ignores the header and detects a real entry", () => {
  assert.equal(decisionsAreEmpty("# Decisions\n\nAutonomous decisions, newest last.\n\n"), true);
  assert.equal(decisionsAreEmpty(""), true);
  assert.equal(decisionsAreEmpty("# Decisions\n\n## Fork: chose Postgres over SQLite\nBecause the charter prizes durability."), false);
});

test("formatAmendments renders a review-and-apply proposal, never a charter edit", () => {
  const md = formatAmendments([
    { rule: "Prefer explicit over clever", evidence: "3 reverts of abstractions", why: "would have prevented churn" },
  ]);
  assert.match(md, /proposed by leopold learn-on-finish/);
  assert.match(md, /## Prefer explicit over clever/);
  assert.match(md, /Evidence:.*3 reverts/);
  assert.match(md, /fold the ones that sound like you into \.leopold\/CHARTER\.md/);
});
