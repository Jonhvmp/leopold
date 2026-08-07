// Unit tests for the plan graph and its deterministic routing function.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, readyItems } from "../src/plan.ts";
import { buildGraph, nextNodes, validateGraph } from "../src/graph.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATIC_PLAN = `# Plan

- [x] Set up the repo
- [ ] Add the API layer
- [ ] (after: 2) Wire the UI to the API
- [ ] (deps: 2, 3) Write the e2e tests
- [ ] Independent docs pass
`;

test("buildGraph mirrors the items and their (after:) edges", () => {
  const g = buildGraph(parsePlan(STATIC_PLAN));
  assert.equal(g.nodes.length, 5);
  assert.deepEqual(g.nodes.map((n) => n.index), [1, 2, 3, 4, 5]);
  assert.equal(g.nodes[0].done, true);
  assert.equal(g.nodes[1].kind, "work");
  assert.deepEqual(
    g.edges,
    [
      { from: 2, to: 3, kind: "after" },
      { from: 2, to: 4, kind: "after" },
      { from: 3, to: 4, kind: "after" },
    ],
  );
});

test("a plan with only (after:) dispatches exactly what readyItems gives, item for item", () => {
  const items = parsePlan(STATIC_PLAN);
  const g = buildGraph(items);
  // Walk the whole run: at every step the graph's answer equals the scheduler's.
  const done = new Set<number>(items.filter((i) => i.done).map((i) => i.index));
  const live = items.map((i) => ({ ...i }));
  for (let step = 0; step < 10; step++) {
    const ready = readyItems(live, new Set()).map((i) => i.index);
    assert.deepEqual(nextNodes(g, done), ready, `step ${step}`);
    if (ready.length === 0) break;
    const pick = ready[0];
    done.add(pick);
    live[pick - 1].done = true;
    for (const n of g.nodes) if (n.index === pick) n.done = true;
  }
  assert.equal(readyItems(live, new Set()).length, 0);
});

test("every plan fixture routes identically to readyItems when it declares no @on", () => {
  const dir = path.join(HERE, "fixtures", "plans");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0);
  for (const f of files) {
    const items = parsePlan(fs.readFileSync(path.join(dir, f), "utf8"));
    if (items.some((i) => i.routes.length > 0 || i.needs.length > 0)) continue;
    const g = buildGraph(items);
    const live = items.map((i) => ({ ...i }));
    const done = new Set<number>(items.filter((i) => i.done).map((i) => i.index));
    for (let step = 0; step < items.length + 2; step++) {
      const ready = readyItems(live, new Set()).map((i) => i.index);
      assert.deepEqual(nextNodes(g, done), ready, `${f} step ${step}`);
      if (ready.length === 0) break;
      const pick = ready[0];
      done.add(pick);
      live[pick - 1].done = true;
      for (const n of g.nodes) if (n.index === pick) n.done = true;
    }
  }
});

const ROUTED_PLAN = `# Plan

- [ ] Prepare the migration
- [ ] (after: 1) Take the backup
- [ ] (after: 2) Run the migration
      @emit migrated
      @on ok -> 5
- [ ] (after: 3) Announce the migration
- [ ] (after: 4) Smoke test production
- [ ] (after: 5) Close the change ticket
`;

test("a matched route jumps to its target and bypasses the next positional item", () => {
  const g = buildGraph(parsePlan(ROUTED_PLAN));
  // 1-3 done, node 3 emitted ok: the run goes to 5, not to 4.
  const out = nextNodes(g, [1, 2, 3], { signals: { ok: "true" } });
  assert.deepEqual(out, [5]);

  // Same thing with the outcome recorded as the node's status instead of a signal.
  assert.deepEqual(nextNodes(g, [1, 2, 3], { status: { 3: "ok" } }), [5]);
});

test("a route whose condition matches no signal is not taken; the static order still applies", () => {
  const g = buildGraph(parsePlan(ROUTED_PLAN));
  assert.deepEqual(nextNodes(g, [1, 2, 3], {}), [4]);
  assert.deepEqual(nextNodes(g, [1, 2, 3], { signals: { other: "true" } }), [4]);
  // A status recorded for the node that is NOT the condition word: still not taken.
  assert.deepEqual(nextNodes(g, [1, 2, 3], { status: { 3: "fail" } }), [4]);
});

const SIGNAL_PLAN = `# Plan

- [ ] Run the migration
      @emit migrated=true
      @on migrated=false -> 3
- [ ] (after: 1) Ship the release
- [ ] Roll the migration back
`;

test("signal conditions compare the channel, and an absent key never matches", () => {
  const g = buildGraph(parsePlan(SIGNAL_PLAN));
  assert.deepEqual(nextNodes(g, [1], { signals: { migrated: "false" } }), [3]);
  assert.deepEqual(nextNodes(g, [1], { signals: { migrated: "true" } }), [2, 3]);
  // Absent key: neither `=` nor `!=` fires — unknown is not "different from".
  assert.deepEqual(nextNodes(g, [1], {}), [2, 3]);
});

test("`!=` fires only against a present, different value", () => {
  const g = buildGraph(parsePlan(`- [ ] Check\n      @on env!=prod -> 3\n- [ ] (after: 1) Deploy\n- [ ] Halt\n`));
  assert.deepEqual(nextNodes(g, [1], { signals: { env: "staging" } }), [3]);
  assert.deepEqual(nextNodes(g, [1], { signals: { env: "prod" } }), [2, 3]);
  assert.deepEqual(nextNodes(g, [1], {}), [2, 3]);
});

const FANOUT_PLAN = `# Plan

- [ ] Assess the incident
      @on sev=1 -> 4
      @on paged=true -> 3
- [ ] (after: 1) Write it up later
- [ ] (after: 1) Page the on-call
- [ ] (after: 1) Open the war room
`;

test("two matching routes fan out, deterministically ordered by target index", () => {
  const g = buildGraph(parsePlan(FANOUT_PLAN));
  const state = { signals: { sev: "1", paged: "true" } };
  assert.deepEqual(nextNodes(g, [1], state), [3, 4]);
  // Pure: the same inputs give the same answer, and declaration order does not leak.
  for (let i = 0; i < 5; i++) assert.deepEqual(nextNodes(g, [1], state), [3, 4]);
  // Only one matches: only that target, and the bypassed static successor stays out.
  assert.deepEqual(nextNodes(g, [1], { signals: { sev: "1" } }), [4]);
});

test("a dangling route target is recorded as an edge but never dispatched", () => {
  const g = buildGraph(parsePlan(`- [ ] Do the thing\n      @on fail -> 99\n- [ ] (after: 1) Next\n`));
  assert.ok(g.edges.some((e) => e.kind === "route" && e.to === 99));
  // The edge matched, so node 1 steered and 2 is bypassed — but 99 does not exist,
  // so nothing is dispatched. The validator's job is to name this before any run.
  assert.deepEqual(nextNodes(g, [1], { status: { 1: "fail" } }), []);
  // Unmatched, the plan runs as written.
  assert.deepEqual(nextNodes(g, [1], {}), [2]);
});

test("@needs gates a node until its signal is on the channel", () => {
  const g = buildGraph(parsePlan(`- [ ] Build\n- [ ] (after: 1) Deploy\n      @needs approved\n`));
  assert.deepEqual(nextNodes(g, [1], {}), []);
  assert.deepEqual(nextNodes(g, [1], { signals: { approved: "true" } }), [2]);
});

test("routing ignores nodes already done and honours plan-level done marks", () => {
  const g = buildGraph(parsePlan(`- [x] Done already\n- [ ] (after: 1) Open\n`));
  assert.deepEqual(nextNodes(g), [2]);
  assert.deepEqual(nextNodes(g, [2]), []);
});

// --- validateGraph -------------------------------------------------------------

const validate = (plan: string) => validateGraph(buildGraph(parsePlan(plan)));

const CYCLE_PLAN = `# Plan

- [ ] Prepare the repo
- [ ] (after: 1) Build the release
- [ ] (after: 2) Run the migration
      @on fail -> 5
- [ ] (after: 2) Update the docs
- [ ] (after: 4) Roll the migration back
      @on retry -> 3
`;

test("a route cycle is one diagnostic naming every item in the loop", () => {
  const d = validate(CYCLE_PLAN);
  assert.equal(d.length, 1, JSON.stringify(d, null, 2));
  assert.equal(d[0].code, "cycle");
  assert.equal(d[0].index, 3);
  assert.deepEqual(d[0].items, [3, 5]);
  // Names both offenders by index AND text, and shows the actual loop.
  assert.match(d[0].message, /item 3 \("Run the migration"\)/);
  assert.match(d[0].message, /item 5 \("Roll the migration back"\)/);
  assert.match(d[0].message, /^Cycle: item 3 .* -> item 5 .* -> item 3 /);
  // Item 4 sits next to the loop but is not in it, so it is not named.
  assert.ok(!d[0].items.includes(4));
  assert.ok(!/item 4/.test(d[0].message));
});

test("a self-route is a cycle of one", () => {
  const d = validate(`- [ ] Build\n- [ ] (after: 1) Retry forever\n      @on again -> 2\n`);
  assert.equal(d.length, 1);
  assert.equal(d[0].code, "cycle");
  assert.deepEqual(d[0].items, [2]);
  assert.match(d[0].message, /item 2 \("Retry forever"\) -> item 2 \("Retry forever"\)/);
});

test("a route to an item that does not exist is a dangling edge naming the target", () => {
  const plan = Array.from({ length: 10 }, (_, i) => `- [ ] Step ${i + 1}`).join("\n");
  const d = validate(`${plan.replace("- [ ] Step 4", "- [ ] Step 4\n      @on fail -> 99")}\n`);
  assert.equal(d.length, 1, JSON.stringify(d, null, 2));
  assert.deepEqual(
    { code: d[0].code, index: d[0].index, items: d[0].items, target: d[0].target },
    { code: "dangling-edge", index: 4, items: [4], target: 99 },
  );
  assert.equal(
    d[0].message,
    'item 4 ("Step 4") routes to item 99, which does not exist (`@on fail`).',
  );
});

test("an @on with no target at all is a dangling edge too, with target 0", () => {
  const d = validate(`- [ ] Do the thing\n      @on fail\n- [ ] (after: 1) Next\n`);
  assert.equal(d.length, 1);
  assert.equal(d[0].code, "dangling-edge");
  assert.equal(d[0].target, 0);
  assert.match(d[0].message, /item 1 \("Do the thing"\) declares `@on fail` with no target item/);
});

test("a @needs no item emits is an unmet-need naming the item and the key", () => {
  const d = validate(`- [ ] Build the artifact\n- [ ] (after: 1) Announce the release\n      @needs deployed\n`);
  const unmet = d.filter((x) => x.code === "unmet-need");
  assert.equal(unmet.length, 1, JSON.stringify(d, null, 2));
  assert.equal(unmet[0].index, 2);
  assert.equal(unmet[0].key, "deployed");
  assert.equal(
    unmet[0].message,
    'item 2 ("Announce the release") needs signal "deployed", which no item emits.',
  );
  // An upstream @emit of the same key clears it — and clears everything else too.
  assert.deepEqual(
    validate(`- [ ] Build the artifact\n      @emit deployed=true\n- [ ] (after: 1) Announce the release\n      @needs deployed\n`),
    [],
  );
});

test("an item nothing can dispatch is unreachable, and the cause is named separately", () => {
  const d = validate(
    `- [ ] Build the artifact\n- [ ] (after: 1) Deploy to production\n      @needs approved\n- [ ] (after: 2) Verify production\n`,
  );
  assert.equal(d.length, 2, JSON.stringify(d, null, 2));
  // The root cause, on the item that declared the impossible need...
  assert.equal(d[0].code, "unmet-need");
  assert.equal(d[0].index, 2);
  // ...and the item stranded behind it, named on its own.
  assert.equal(d[1].code, "unreachable");
  assert.deepEqual(d[1].items, [3]);
  assert.equal(
    d[1].message,
    'item 3 ("Verify production") is unreachable: no wave and no route can dispatch it.',
  );
  // A route straight at it rescues it: only the root cause is left.
  const rescued = validate(
    `- [ ] Build the artifact\n      @on fail -> 3\n- [ ] (after: 1) Deploy to production\n      @needs approved\n- [ ] (after: 2) Verify production\n`,
  );
  assert.deepEqual(rescued.map((x) => x.code), ["unmet-need"]);
});

test("each defect class produces its own distinct diagnostic in one pass", () => {
  const d = validate(`# Plan

- [ ] Kick off
- [ ] (after: 1) Migrate
      @on fail -> 99
- [ ] (after: 2) Announce
      @needs approved
- [ ] (after: 3) Close out
- [ ] (after: 1) Watch the loop
      @on again -> 6
- [ ] (after: 1) Loop back
      @on again -> 5
`);
  assert.deepEqual(
    d.map((x) => `${x.code}:${x.items.join("+")}`),
    ["cycle:5+6", "dangling-edge:2", "unmet-need:3", "unreachable:4"],
  );
  // Deterministic: same graph in, byte-identical diagnostics out.
  assert.deepEqual(validate(`# Plan

- [ ] Kick off
- [ ] (after: 1) Migrate
      @on fail -> 99
- [ ] (after: 2) Announce
      @needs approved
- [ ] (after: 3) Close out
- [ ] (after: 1) Watch the loop
      @on again -> 6
- [ ] (after: 1) Loop back
      @on again -> 5
`), d);
});

test("a valid graph — routed or not — validates clean", () => {
  assert.deepEqual(validate(STATIC_PLAN), []);
  assert.deepEqual(validate(ROUTED_PLAN), []);
  assert.deepEqual(validate(FANOUT_PLAN), []);
  assert.deepEqual(validate(SIGNAL_PLAN), []);
  // Half-run plans validate clean too: a done item is a dispatch that happened.
  assert.deepEqual(validate(`- [x] Build\n- [ ] (after: 1) Ship\n`), []);
});

test("every existing plan fixture validates clean — no old plan gains a new way to fail", () => {
  const dir = path.join(HERE, "fixtures", "plans");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0);
  for (const f of files) {
    const d = validateGraph(buildGraph(parsePlan(fs.readFileSync(path.join(dir, f), "utf8"))));
    assert.deepEqual(d, [], `${f}: ${JSON.stringify(d, null, 2)}`);
  }
});
