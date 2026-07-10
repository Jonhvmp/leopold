// Unit tests for the serial-retry fresh-restart framing.
//
// Ed's principle: on a retry the failed diff is still in the shared tree, and
// building on it pulls the fresh worker back toward the same dead end. Every serial
// retry must carry the fresh-restart framing — with the root-cause lead folded in
// when the panel produced one, and standing alone when it did not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryLead, buildWorkerPrompt, shouldLiteralReset, tournamentEligible } from "../src/loop.ts";

test("retryLead always carries the fresh-restart framing (no panel lead)", () => {
  const lead = retryLead(undefined);
  assert.match(lead, /previous attempt at this item FAILED/i);
  assert.match(lead, /dead end written by someone else/i);
  assert.match(lead, /replace it wholesale/i);
});

test("retryLead folds the panel lead in AFTER the framing", () => {
  const panel = "THEORY: the API moved. FIX: call the new endpoint.";
  const lead = retryLead(panel);
  assert.match(lead, /previous attempt at this item FAILED/i); // framing present
  assert.ok(lead.includes(panel));                             // lead present
  // framing comes first so the worker restarts clean before reading the theory
  assert.ok(lead.indexOf("FAILED") < lead.indexOf("THEORY"));
});

test("buildWorkerPrompt lists scenarios as the definition of done", () => {
  const p = buildWorkerPrompt("Build login", [
    "existing email + right password → 200 + cookie",
    "wrong password → 401",
  ]);
  assert.match(p, /Work on this plan item now:\n\nBuild login/);
  assert.match(p, /Acceptance scenarios/i);
  assert.ok(p.includes("existing email + right password → 200 + cookie"));
  assert.ok(p.includes("wrong password → 401"));
});

test("buildWorkerPrompt is backward compatible with a scenario-less item", () => {
  const p = buildWorkerPrompt("Rename the helper", []);
  assert.ok(p.includes("Work on this plan item now:\n\nRename the helper"));
  assert.doesNotMatch(p, /Acceptance scenarios/i); // no scenarios → no scenario block
  assert.match(p, /Do it completely and verify it/);
});

test("buildWorkerPrompt threads steer and retry lead in order", () => {
  const p = buildWorkerPrompt("Do X", [], "PANEL LEAD", "STEER NOTE");
  assert.ok(p.indexOf("STEER NOTE") < p.indexOf("Do X"));     // steer first
  assert.ok(p.indexOf("Do X") < p.indexOf("PANEL LEAD"));     // then item, then lead
});

test("buildWorkerPrompt renders a slice scope only when files are given", () => {
  const withScope = buildWorkerPrompt("Do X", [], undefined, undefined, ["src/a.ts", "src/b.ts"]);
  assert.match(withScope, /Likely in scope/);
  assert.ok(withScope.includes("src/a.ts") && withScope.includes("src/b.ts"));
  const noScope = buildWorkerPrompt("Do X", [], undefined, undefined, []);
  assert.doesNotMatch(noScope, /Likely in scope/); // empty slice → no scope block (unchanged)
});

test("shouldLiteralReset only fires on a retry, toggle on, isolated, with a snapshot", () => {
  const on = { isRetry: true, literalReset: true, isolated: true, haveSnapshot: true };
  assert.equal(shouldLiteralReset(on), true);
  assert.equal(shouldLiteralReset({ ...on, isRetry: false }), false, "not a retry");
  assert.equal(shouldLiteralReset({ ...on, literalReset: false }), false, "toggle off");
  assert.equal(shouldLiteralReset({ ...on, isolated: false }), false, "never reset a live repo");
  assert.equal(shouldLiteralReset({ ...on, haveSnapshot: false }), false, "no snapshot to restore");
});

test("tournamentEligible: K>1 + isolated + critical-or-max; off by default is a no-op", () => {
  assert.equal(tournamentEligible({ bestOfK: 3, isolated: true, critical: true, maxEffort: false }), true);
  assert.equal(tournamentEligible({ bestOfK: 3, isolated: true, critical: false, maxEffort: true }), true);
  // toggle off (K=1) → never, so the loop is unchanged when best_of_k is off
  assert.equal(tournamentEligible({ bestOfK: 1, isolated: true, critical: true, maxEffort: true }), false);
  // ordinary item → single attempt even with the toggle on
  assert.equal(tournamentEligible({ bestOfK: 4, isolated: true, critical: false, maxEffort: false }), false);
  // never in a non-isolated (live-repo) run — the winner is applied with a hard reset
  assert.equal(tournamentEligible({ bestOfK: 4, isolated: false, critical: true, maxEffort: true }), false);
});
