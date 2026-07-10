// Unit tests for the best-of-k tournament's pure core: winner selection + score parse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWinner, parseScore, type Judged } from "../src/tournament.ts";

const mk = (index: number, score: number, ok = true, patch = "diff…"): Judged =>
  ({ index, ok, patch, detail: "", score, why: "" });

test("pickWinner takes the highest score among successful, non-empty attempts", () => {
  assert.equal(pickWinner([mk(0, 4), mk(1, 9), mk(2, 7)]), 1);
});

test("pickWinner resolves ties to the lowest index (deterministic)", () => {
  assert.equal(pickWinner([mk(0, 8), mk(1, 8), mk(2, 8)]), 0);
});

test("pickWinner ignores failed attempts and empty diffs, even if 'high scoring'", () => {
  // index 2 scored 10 but failed; index 1 scored 9 but produced no diff; index 0 wins at 5.
  assert.equal(pickWinner([mk(0, 5), mk(1, 9, true, "   "), mk(2, 10, false)]), 0);
});

test("pickWinner returns -1 when nothing qualifies (caller falls back to single path)", () => {
  assert.equal(pickWinner([mk(0, 10, false), mk(1, 8, true, "")]), -1);
  assert.equal(pickWinner([]), -1);
});

test("parseScore clamps to 0-10 and fails low on garbage", () => {
  assert.equal(parseScore('{"score": 7, "why": "ok"}').score, 7);
  assert.equal(parseScore('{"score": 99}').score, 10);   // clamped
  assert.equal(parseScore('{"score": -3}').score, 0);     // clamped
  assert.equal(parseScore("no json at all").score, 0);    // fail low, can't win
  assert.equal(parseScore('```json\n{"score":6,"why":"x"}\n```').score, 6); // fenced tolerated
});
