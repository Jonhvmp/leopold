// Unit tests for the review gate's pure helpers (verdict parsing + sensitivity + lens panel).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview, diffIsSensitive, lensesFor } from "../src/review.ts";

test("lensesFor: conformance is appended iff the item has scenarios (backward compatible)", () => {
  // no scenarios → exactly the panels as before
  assert.deepEqual(lensesFor({ sensitive: false, critical: false }), ["correctness"]);
  assert.deepEqual(lensesFor({ sensitive: true, critical: false }), ["correctness", "security"]);
  assert.deepEqual(lensesFor({ sensitive: false, critical: true }), ["correctness", "security", "does-it-work"]);
  // scenarios present → conformance appended to whatever base panel applies
  assert.deepEqual(lensesFor({ sensitive: false, critical: false, hasScenarios: true }), ["correctness", "conformance"]);
  assert.deepEqual(lensesFor({ sensitive: false, critical: true, hasScenarios: true }), ["correctness", "security", "does-it-work", "conformance"]);
  // explicit no-scenarios is identical to omitting it
  assert.deepEqual(lensesFor({ sensitive: false, critical: false, hasScenarios: false }), ["correctness"]);
});

test("an unmet scenario comes back as a blocking finding", () => {
  const r = parseReview('{"ok":false,"blocking":[{"file":"auth.ts","issue":"scenario \\"wrong password → 401\\" unmet: returns 200","severity":"blocking"}],"summary":"1 scenario unmet"}');
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.match(r.blocking[0].issue, /wrong password/);
});

test("a clean verdict passes the gate", () => {
  const r = parseReview('{"ok":true,"blocking":[],"summary":"looks good"}');
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
});

test("blocking findings fail the gate (fenced JSON tolerated)", () => {
  const r = parseReview('```json\n{"ok":false,"blocking":[{"file":"a.ts","issue":"null deref","severity":"blocking"}],"summary":"bug"}\n```');
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].file, "a.ts");
});

test("minor findings are dropped — only blockers gate", () => {
  const r = parseReview('{"ok":true,"blocking":[{"file":"a.ts","issue":"nit","severity":"minor"}],"summary":"x"}');
  assert.equal(r.blocking.length, 0);
  assert.equal(r.ok, true);
});

test("unparseable review fails CLOSED (does not silently pass)", () => {
  const r = parseReview("the model rambled with no json");
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
});

test("prose around the JSON is tolerated", () => {
  const r = parseReview('Here is my verdict:\n{"ok":false,"blocking":[{"file":"x","issue":"y","severity":"blocking"}]}\nThanks!');
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
});

test("sensitivity detection keys off diff file paths", () => {
  assert.equal(diffIsSensitive(" src/auth/session.ts | 12 +++"), true);
  assert.equal(diffIsSensitive(" src/billing/stripe.ts | 4 +"), true);
  assert.equal(diffIsSensitive(" .env.example | 1 +"), true);
  assert.equal(diffIsSensitive(" src/components/Button.tsx | 3 +"), false);
});
