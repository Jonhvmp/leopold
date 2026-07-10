// Unit tests for smart routing's pure verdict parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../src/route.ts";

test("a valid route verdict parses", () => {
  const r = parseRoute('{"effort":"high","critical":true,"reason":"touches the shared retry helper (41 callers)"}');
  assert.ok(r);
  assert.equal(r.effort, "high");
  assert.equal(r.critical, true);
  assert.match(r.reason, /smart-route:/);
});

test("fenced JSON and prose are tolerated", () => {
  const r = parseRoute('After checking:\n```json\n{"effort":"low","critical":false,"reason":"docs only"}\n```');
  assert.ok(r);
  assert.equal(r.effort, "low");
});

test("an invalid effort tier is rejected (falls back to keywords)", () => {
  assert.equal(parseRoute('{"effort":"ultra","critical":false,"reason":"x"}'), null);
  assert.equal(parseRoute('{"critical":true,"reason":"missing effort"}'), null);
  assert.equal(parseRoute("no json"), null);
});

test("critical must be literally true — anything else is not critical", () => {
  const r = parseRoute('{"effort":"medium","critical":"yes","reason":"x"}');
  assert.ok(r);
  assert.equal(r.critical, false);
});

test("the researched file set is parsed (slice scope); non-strings dropped", () => {
  const r = parseRoute('{"effort":"high","critical":false,"reason":"x","files":["src/a.ts"," src/b.ts ", 42, "", "src/c.ts"]}');
  assert.ok(r);
  assert.deepEqual(r.files, ["src/a.ts", "src/b.ts", "src/c.ts"]); // trimmed, non-strings/empties dropped
});

test("a verdict with no files field yields an empty slice (backward compatible)", () => {
  const r = parseRoute('{"effort":"low","critical":false,"reason":"docs"}');
  assert.ok(r);
  assert.deepEqual(r.files, []);
});
