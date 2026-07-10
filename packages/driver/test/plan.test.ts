// Unit tests for the dependency-aware plan parser + scheduler helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { parsePlan, readyItems, allDone, deadlocked, setItemDone } from "../src/plan.ts";

const PLAN = `# Plan

- [x] Set up the repo
- [ ] Add the API layer
- [ ] (after: 2) Wire the UI to the API
- [ ] (deps: 2, 3) Write the e2e tests
- [ ] Independent docs pass
`;

test("parses checkboxes, done state, and dependency markers", () => {
  const items = parsePlan(PLAN);
  assert.equal(items.length, 5);
  assert.equal(items[0].done, true);
  assert.equal(items[1].text, "Add the API layer");
  assert.deepEqual(items[2].deps, [2]);
  assert.equal(items[2].text, "Wire the UI to the API"); // marker stripped
  assert.deepEqual(items[3].deps, [2, 3]);
  assert.deepEqual(items[4].deps, []);
});

test("@scenario lines attach to the item above them; scenario-less items stay []", () => {
  const items = parsePlan(
    "- [ ] Build login\n" +
    "  @scenario existing email + right password → 200 + session cookie\n" +
    "  @scenario wrong password → 401 and no cookie\n" +
    "- [ ] Unrelated docs pass\n",
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].scenarios.length, 2);
  assert.equal(items[0].scenarios[0], "existing email + right password → 200 + session cookie");
  assert.equal(items[0].scenarios[1], "wrong password → 401 and no cookie");
  assert.equal(items[0].text, "Build login"); // scenarios do not bleed into item text
  assert.deepEqual(items[1].scenarios, []);    // an item with none is unchanged
});

test("@scenario is tolerant of a colon and casing, and drops orphans before any item", () => {
  const items = parsePlan(
    "@scenario this one has no item above it — dropped\n" +
    "- [ ] Do X\n" +
    "@Scenario: no leading indent, colon form\n",
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].scenarios, ["no leading indent, colon form"]);
});

test("existing plans are byte-for-byte backward compatible (scenarios: [] everywhere)", () => {
  const items = parsePlan(PLAN); // the classic fixture, no @scenario lines
  for (const it of items) assert.deepEqual(it.scenarios, []);
  // and the pre-existing fields are unchanged
  assert.equal(items.length, 5);
  assert.equal(items[2].text, "Wire the UI to the API");
  assert.deepEqual(items[3].deps, [2, 3]);
});

test("forward / self references are dropped (only earlier items count)", () => {
  const items = parsePlan("- [ ] (after: 2, 9) a\n- [ ] b\n");
  assert.deepEqual(items[0].deps, []); // 2 and 9 are not < 1
});

test("ready set respects deps and in-flight", () => {
  const items = parsePlan(PLAN);
  // Item 2 (API) and item 5 (docs) are independent → both ready. 3 and 4 wait.
  let ready = readyItems(items, new Set());
  assert.deepEqual(ready.map((i) => i.index).sort(), [2, 5]);

  // With 2 in flight, only 5 is ready (3 still waits on 2).
  ready = readyItems(items, new Set([2]));
  assert.deepEqual(ready.map((i) => i.index), [5]);
});

test("ready set opens up as deps complete", () => {
  const items = parsePlan(PLAN.replace("- [ ] Add the API layer", "- [x] Add the API layer"));
  const ready = readyItems(items, new Set());
  // 2 done → 3 unblocks; 4 still waits on 3; 5 independent.
  assert.deepEqual(ready.map((i) => i.index).sort(), [3, 5]);
});

test("allDone and deadlock detection", () => {
  assert.equal(allDone(parsePlan("- [x] a\n- [x] b\n")), true);
  assert.equal(allDone(parsePlan("- [x] a\n- [ ] b\n")), false);
  // Dropping forward refs (deps must point at earlier items) makes a real deadlock
  // impossible: the lowest-index open item always has its deps satisfied. So even a
  // graph that *looks* circular resolves — item 2's forward ref to 3 is dropped, so 2
  // is ready and nothing is deadlocked.
  const items = parsePlan("- [x] a\n- [ ] (after: 3) b\n- [ ] (after: 2) c\n");
  assert.deepEqual(readyItems(items, new Set()).map((i) => i.index), [2]);
  assert.equal(deadlocked(items, new Set()), false);
});

test("setItemDone closes a specific item by index", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-plan-"));
  const p = path.join(dir, "PLAN.md");
  fs.writeFileSync(p, PLAN);
  const left = setItemDone(p, 5); // close "Independent docs pass"
  assert.equal(left, 3); // items 2, 3, 4 still open
  const after = parsePlan(fs.readFileSync(p, "utf8"));
  assert.equal(after[4].done, true);
  assert.equal(after[1].done, false);
});
