// USD budget hard-stop: the pure decision functions (parse + the at/over-cap trip).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBudgetUsd, overBudget } from "../src/budget.ts";

test("parseBudgetUsd parses positive numbers, rejects junk", () => {
  assert.equal(parseBudgetUsd("5"), 5);
  assert.equal(parseBudgetUsd("0.50"), 0.5);
  assert.equal(parseBudgetUsd(undefined), undefined);
  assert.equal(parseBudgetUsd(""), undefined);
  assert.equal(parseBudgetUsd("0"), undefined);
  assert.equal(parseBudgetUsd("-3"), undefined);
  assert.equal(parseBudgetUsd("abc"), undefined);
});

test("overBudget trips at/over the cap, never without a cap", () => {
  assert.equal(overBudget(0, undefined), false);
  assert.equal(overBudget(999, undefined), false);
  assert.equal(overBudget(4.99, 5), false);
  assert.equal(overBudget(5, 5), true);
  assert.equal(overBudget(5.01, 5), true);
});
