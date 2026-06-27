// Unit tests for the review gate's pure helpers (verdict parsing + sensitivity).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview, diffIsSensitive } from "../src/review.ts";

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
