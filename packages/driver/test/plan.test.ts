// Unit tests for the dependency-aware plan parser + scheduler helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  parsePlan, readyItems, allDone, deadlocked, setItemDone, setItemOpen, checkboxVector,
  checkboxLedgerMark, driverFlipsSince, forgedCheckboxes, restoreCheckboxes,
} from "../src/plan.ts";

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

// ---- the graph grammar: kinds, conditional edges, state contract ------------

test("an item with no new syntax is a work node with empty routes/emits/needs", () => {
  const items = parsePlan(PLAN);
  for (const it of items) {
    assert.equal(it.kind, "work");
    assert.equal(it.kindLabel, "");
    assert.deepEqual(it.routes, []);
    assert.deepEqual(it.emits, []);
    assert.deepEqual(it.needs, []);
  }
});

test("`@gate security Review auth` → gate kind, label captured, marker stripped", () => {
  const [it] = parsePlan("- [ ] @gate security Review auth\n");
  assert.equal(it.kind, "gate");
  assert.equal(it.kindLabel, "security");
  assert.equal(it.text, "Review auth");
});

test("a @tool node never loses its first word to the bare-label rule", () => {
  // The bare-label shorthand is what makes `@gate security Review auth` read well, but
  // on a tool node the text IS the command: eating `make` would silently run `test`.
  const [make] = parsePlan("- [ ] @tool make test\n");
  assert.equal(make.kind, "tool");
  assert.equal(make.kindLabel, "");
  assert.equal(make.text, "make test");
  const [npm] = parsePlan("- [ ] @tool npm run build\n");
  assert.equal(npm.text, "npm run build");
  // The guard must still see the word `git` — a bare label would have hidden it.
  const [g] = parsePlan("- [ ] @tool git push --force origin main\n");
  assert.equal(g.text, "git push --force origin main");
  // Labelling a tool node is still possible, the explicit way.
  const [labelled] = parsePlan("- [ ] @tool build: make release\n");
  assert.equal(labelled.kindLabel, "build");
  assert.equal(labelled.text, "make release");
});

test("every kind parses, via shorthand and via @node, with or without a label", () => {
  const items = parsePlan(
    "- [ ] @human Ask the team about pricing\n" +
    "- [ ] @tool build: Run the release build\n" +
    "- [ ] @verify Check the invariants\n" +
    "- [ ] @node gate release Sign off\n" +
    "- [ ] @node work Plain work, said out loud\n" +
    "- [ ] @gate Security: Review the auth diff\n",
  );
  assert.deepEqual(items.map((i) => i.kind), ["human", "tool", "verify", "gate", "work", "gate"]);
  // A capitalised first word is text, not a label — `@human Ask ...` keeps its text.
  assert.equal(items[0].kindLabel, "");
  assert.equal(items[0].text, "Ask the team about pricing");
  assert.equal(items[1].kindLabel, "build");
  assert.equal(items[1].text, "Run the release build");
  assert.equal(items[2].kindLabel, "");
  assert.equal(items[2].text, "Check the invariants");
  assert.equal(items[3].kindLabel, "release");
  assert.equal(items[3].text, "Sign off");
  assert.equal(items[4].text, "Plain work, said out loud");
  // An explicit `name:` label may be capitalised.
  assert.equal(items[5].kindLabel, "Security");
  assert.equal(items[5].text, "Review the auth diff");
});

test("the kind marker composes with (after:) in either order", () => {
  const a = parsePlan("- [ ] one\n- [ ] (after: 1) @gate api Review the endpoint\n")[1];
  assert.deepEqual(a.deps, [1]);
  assert.equal(a.kind, "gate");
  assert.equal(a.kindLabel, "api");
  assert.equal(a.text, "Review the endpoint");
  const b = parsePlan("- [ ] one\n- [ ] @gate api (after: 1) Review the endpoint\n")[1];
  assert.deepEqual(b.deps, [1]);
  assert.equal(b.kind, "gate");
  assert.equal(b.text, "Review the endpoint");
});

test("a `@node` line under an item sets the kind without touching the text", () => {
  const [it] = parsePlan("- [ ] Migrate the database\n  @node human ops\n");
  assert.equal(it.kind, "human");
  assert.equal(it.kindLabel, "ops");
  assert.equal(it.text, "Migrate the database");
});

test("`@node` without a known kind is prose, not a marker", () => {
  const [it] = parsePlan("- [ ] @node the graph builder into place\n");
  assert.equal(it.kind, "work");
  assert.equal(it.kindLabel, "");
  assert.equal(it.text, "@node the graph builder into place"); // untouched
});

test("`@on fail -> 7` is one status route", () => {
  const [it] = parsePlan("- [ ] Migrate\n  @on fail -> 7\n");
  assert.equal(it.routes.length, 1);
  assert.equal(it.routes[0].when, "fail");
  assert.equal(it.routes[0].target, 7);
  assert.equal(it.routes[0].kind, "status");
  assert.equal(it.routes[0].key, undefined);
});

test("`@on migrated=false -> 7` is a signal route, not a status one", () => {
  const [it] = parsePlan("- [ ] Migrate\n  @on migrated=false → 7\n");
  assert.equal(it.routes.length, 1);
  assert.deepEqual(it.routes[0], {
    when: "migrated=false", target: 7, kind: "signal", key: "migrated", op: "=", value: "false",
  });
});

test("routes accept ->, => and →, `!=`, quoted values and spacing", () => {
  const [it] = parsePlan(
    "- [ ] Migrate\n" +
    "  @on pass => 3\n" +
    "  @on stage != \"prod\" -> #4\n" +
    "  @on count == 2 → 5\n",
  );
  assert.deepEqual(it.routes.map((r) => [r.kind, r.key ?? "", r.op ?? "", r.value ?? "", r.target]), [
    ["status", "", "", "", 3],
    ["signal", "stage", "!=", "prod", 4],
    ["signal", "count", "=", "2", 5],
  ]);
});

test("routes are kept even when they cannot resolve — the validator names them", () => {
  const [it] = parsePlan("- [ ] Migrate\n  @on fail\n  @on fail -> rollback\n  @on\n");
  // A bare `@on` carries nothing and is dropped; the other two are kept with target 0
  // so the graph validator can name the offender instead of the parser hiding it.
  assert.deepEqual(it.routes.map((r) => [r.when, r.target]), [["fail", 0], ["fail", 0]]);
});

test("routes do not become dependencies", () => {
  const items = parsePlan("- [ ] one\n  @on fail -> 1\n- [ ] two\n");
  assert.deepEqual(items[0].deps, []);
  assert.deepEqual(readyItems(items, new Set()).map((i) => i.index), [1, 2]);
});

test("@emit declares signals; a bare key means true", () => {
  const [it] = parsePlan(
    "- [ ] Migrate\n" +
    "  @emit migrated=false\n" +
    "  @emit rollback_needed\n" +
    "  @emit note = \"schema v3 applied\"\n" +
    "  @emit\n",
  );
  assert.deepEqual(it.emits, [
    { key: "migrated", value: "false" },
    { key: "rollback_needed", value: "true" },
    { key: "note", value: "schema v3 applied" },
  ]);
});

test("@needs collects keys, comma- or space-separated, deduped", () => {
  const [it] = parsePlan(
    "- [ ] Deploy\n" +
    "  @needs migrated, reviewed\n" +
    "  @needs approved\n" +
    "  @needs migrated\n",
  );
  assert.deepEqual(it.needs, ["migrated", "reviewed", "approved"]);
});

test("graph markers attach to the item above them and never to the next one", () => {
  const items = parsePlan(
    "- [ ] @gate security Review auth\n" +
    "  @scenario a missing token → 401\n" +
    "  @needs built\n" +
    "  @emit reviewed=true\n" +
    "  @on fail -> 3\n" +
    "- [ ] Ship it\n" +
    "- [ ] Roll back\n",
  );
  assert.equal(items[0].scenarios.length, 1);
  assert.deepEqual(items[0].needs, ["built"]);
  assert.deepEqual(items[0].emits, [{ key: "reviewed", value: "true" }]);
  assert.equal(items[0].routes[0].target, 3);
  for (const it of items.slice(1)) {
    assert.equal(it.kind, "work");
    assert.deepEqual([it.routes, it.emits, it.needs, it.scenarios], [[], [], [], []]);
  }
});

test("graph markers before the first checkbox are dropped, like @scenario", () => {
  const items = parsePlan("@on fail -> 2\n@emit x=1\n@needs y\n@gate g\n- [ ] Do X\n");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "work");
  assert.deepEqual([items[0].routes, items[0].emits, items[0].needs], [[], [], []]);
});

// ---- backward compatibility -------------------------------------------------

// The golden was produced by the parser as it stood BEFORE the graph grammar existed
// (see fixtures/plan-legacy-golden.json). The fixtures under fixtures/plans/ are
// verbatim copies of this repo's own archived run plans (.leopold/runs/*/PLAN.md,
// which are gitignored) plus templates/PLAN.md AS IT STOOD BEFORE THE GRAMMAR (the
// shipped template now demonstrates routing; that current file is parsed and validated
// by plan-grammar-docs.test.ts, while this snapshot keeps proving the old one). If any
// of these five
// legacy fields moves for any of them, the change broke an existing plan.
const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "plans");
const GOLDEN: Record<string, Array<Record<string, unknown>>> = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "plan-legacy-golden.json"), "utf8"),
);

test("real plans reparse byte-identically to the pre-grammar parser", () => {
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".md")).sort();
  assert.ok(files.length >= 5, `expected the plan fixtures to be present, found ${files.length}`);
  let checked = 0;
  for (const file of files) {
    const expected = GOLDEN[file];
    assert.ok(expected, `no golden for fixture ${file}`);
    const items = parsePlan(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
    const legacy = items.map((i) => ({
      index: i.index, text: i.text, done: i.done, deps: i.deps, scenarios: i.scenarios,
    }));
    assert.deepEqual(legacy, expected, `${file} parses differently than it did before the graph grammar`);
    // ...and none of them uses the new grammar, so every one is a plain work node.
    for (const it of items) {
      assert.equal(it.kind, "work", `${file} item ${it.index} changed kind`);
      assert.deepEqual([it.routes, it.emits, it.needs], [[], [], []], `${file} item ${it.index} grew graph state`);
    }
    checked += items.length;
  }
  assert.ok(checked >= 45, `expected the fixtures to cover real plans, only saw ${checked} items`);
});

test("the awkward corners of the old grammar parse exactly as they did before", () => {
  // Cases + expectations captured by RUNNING the pre-grammar parser (git show HEAD),
  // not by reasoning about it: double spaces before a marker, a second `(after:)` that
  // must stay in the text, tab indents, CRLF, `@nodemon`-style words that must not read
  // as a `@node` marker, an arrow inside prose, and so on.
  const edge: { cases: Record<string, string>; expected: Record<string, unknown> } = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "fixtures", "plan-legacy-edge-cases.json"), "utf8"),
  );
  const names = Object.keys(edge.cases);
  assert.ok(names.length >= 15, `expected the edge-case battery, found ${names.length}`);
  for (const name of names) {
    const legacy = parsePlan(edge.cases[name]).map((i) => ({
      index: i.index, text: i.text, done: i.done, deps: i.deps, scenarios: i.scenarios,
    }));
    assert.deepEqual(legacy, edge.expected[name], `"${name}" parses differently than it did before`);
  }
});

test("the classic inline fixture matches its pre-grammar golden too", () => {
  const legacy = parsePlan(PLAN).map((i) => ({
    index: i.index, text: i.text, done: i.done, deps: i.deps, scenarios: i.scenarios,
  }));
  assert.deepEqual(legacy, GOLDEN["<classic-inline>"]);
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

// --- the checkbox ledger ------------------------------------------------------------
// WHO closed that item. A read-only node's brief receipt hashes PLAN.md with its
// checkboxes BLANKED, because a --parallel sibling legitimately closes another item
// while the node runs — which left the one forgery that ends a run early invisible:
// flip every `[ ]` to `[x]` and the next round sees allDone and stops with
// `plan_complete`, work undone. The ledger is what tells a driver flip from a forged
// one: the driver records every checkbox it writes, so a flip on nobody's ledger is a
// forgery, and the state the driver knows is what it gets restored to.

test("the driver records every checkbox it flips, and nothing it did not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-ledger-"));
  const p = path.join(dir, "PLAN.md");
  fs.writeFileSync(p, PLAN);
  assert.equal(checkboxVector(p), "x    ");

  const mark = checkboxLedgerMark();
  setItemDone(p, 2);
  assert.equal(checkboxVector(p), "xx   ");
  assert.deepEqual([...driverFlipsSince(mark, p)], [2], "the driver's own flip is on its ledger");
  // Another plan's flips are not this plan's.
  assert.deepEqual([...driverFlipsSince(mark, path.join(dir, "OTHER.md"))], []);
  // Closing an item that is already closed is not a flip, so it is not recorded.
  const mark2 = checkboxLedgerMark();
  setItemDone(p, 2);
  assert.deepEqual([...driverFlipsSince(mark2, p)], []);
  // Re-opening one is a flip like any other.
  setItemOpen(p, 1);
  assert.deepEqual([...driverFlipsSince(mark2, p)], [1]);
});

test("forgedCheckboxes names only the flips the driver never made", () => {
  const flipped = (n: number[]): Set<number> => new Set(n);
  // Nothing moved.
  assert.deepEqual(forgedCheckboxes("x  ", "x  ", flipped([])), []);
  // The driver closed item 2 mid-node: legitimate, and NOT a forgery.
  assert.deepEqual(forgedCheckboxes("x  ", "xx ", flipped([2])), []);
  // The same flip with nothing on the ledger is exactly the forgery that ends a run.
  assert.deepEqual(forgedCheckboxes("x  ", "xx ", flipped([])), [2]);
  // Every open item forged done, with one of them genuinely closed by the driver.
  assert.deepEqual(forgedCheckboxes("x  ", "xxx", flipped([2])), [3]);
  // Re-opening a done item behind the driver's back counts too.
  assert.deepEqual(forgedCheckboxes("xxx", "xx ", flipped([])), [3]);
  // A plan that gained or lost a line has shifted positions: the digest catches that
  // one, and guessing here would name the wrong item and restore the wrong line.
  assert.deepEqual(forgedCheckboxes("x  ", "x   ", flipped([])), []);
  assert.deepEqual(forgedCheckboxes("x  ", "x ", flipped([])), []);
  assert.deepEqual(forgedCheckboxes("", "xxx", flipped([])), []);
});

test("restoreCheckboxes puts a forged checkbox back to what the driver last knew", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-restore-"));
  const p = path.join(dir, "PLAN.md");
  fs.writeFileSync(p, PLAN);
  const was = checkboxVector(p);
  // A node with a shell forges every checkbox — the whole plan, "done".
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/- \[ \]/g, "- [x]"));
  assert.equal(checkboxVector(p), "xxxxx");

  const forged = forgedCheckboxes(was, checkboxVector(p), new Set());
  assert.deepEqual(forged, [2, 3, 4, 5]);
  assert.deepEqual(restoreCheckboxes(p, forged, was), [2, 3, 4, 5]);
  assert.equal(checkboxVector(p), was, "the plan is back to the state the driver knows");
  // The item TEXT is untouched by the restore — only the box moved, only the box moves back.
  assert.deepEqual(parsePlan(fs.readFileSync(p, "utf8")).map((i) => i.text), parsePlan(PLAN).map((i) => i.text));
});
