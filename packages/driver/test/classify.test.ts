// Unit tests for per-item risk classification (effort + criticality).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyItem } from "../src/classify.ts";

test("critical items get high+ effort and a second opinion", () => {
  for (const item of [
    "Add Stripe billing for the pro tier",
    "Refactor the auth/session middleware",
    "Rotate the API key handling in the secrets module",
    "Wire RBAC permission checks into the dashboard",
  ]) {
    const c = classifyItem(item);
    assert.equal(c.critical, true, item);
    assert.ok(c.effort === "high" || c.effort === "max", `${item} -> ${c.effort}`);
  }
});

test("sharp-edge critical items go to max effort", () => {
  for (const item of [
    "Migrate the users table schema to add tenant_id",
    "Make the payment capture irreversible after confirm",
    "Change the password crypto from bcrypt to argon2",
  ]) {
    assert.equal(classifyItem(item).effort, "max", item);
  }
});

test("trivial items go to low effort and are not critical", () => {
  for (const item of [
    "Fix a typo in the README",
    "Rename the variable foo to bar",
    "Reformat the changelog",
    "Bump version to 0.9.0",
  ]) {
    const c = classifyItem(item);
    assert.equal(c.effort, "low", item);
    assert.equal(c.critical, false, item);
  }
});

test("ordinary items default to medium", () => {
  const c = classifyItem("Add a JSON export button to the reports view");
  assert.equal(c.effort, "medium");
  assert.equal(c.critical, false);
});

test("a high-risk charter raises ordinary items to high (not critical)", () => {
  const charter = "This project handles payments and PII; treat it as security-critical.";
  const c = classifyItem("Add a new column to the reports grid", charter);
  assert.equal(c.effort, "high");
  assert.equal(c.critical, false);
  // ...but a cosmetic item stays low even under a high-risk charter.
  assert.equal(classifyItem("fix a typo in the footer", charter).effort, "low");
});
