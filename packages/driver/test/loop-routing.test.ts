// Routing in the REAL scheduler, with zero model calls.
//
// The whole loop reaches the harness through one seam (src/sdk.ts), so a deterministic
// fake lets these tests drive runDriver end to end: the plan routes or it does not, and
// events.jsonl is the evidence. Three things are proven here:
//
//   1. an item that FAILS and declares `@on fail -> 6` sends the run to 6, and the
//      events log records the route AND why it was taken;
//   2. the same plan with that item succeeding takes no route at all and continues in
//      the static order;
//   3. a plan with no routes dispatches EXACTLY what it dispatched before routing
//      existed — serial and --parallel — asserted against readyItems itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver } from "../src/loop.ts";
import { parsePlan, readyItems } from "../src/plan.ts";
import { dispatchPlan, newRouting, settleNode, signalsFor } from "../src/dispatch.ts";
import { readSignals } from "../src/bus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

/** A repo with a brief whose PLAN.md is `plan`. Git is real (the loop reads HEAD). */
function briefRepo(plan: string): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-route-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".leopold/\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "MISSION.md"), "# Mission\nShip it.\n");
  fs.writeFileSync(path.join(leo, "CHARTER.md"), "# Charter\nSimplicity.\n");
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- max_failures: 3\n- max_iterations: 30\n");
  fs.writeFileSync(path.join(leo, "PLAN.md"), plan);
  return { root, leo };
}

const events = (leo: string): Array<Record<string, unknown>> =>
  fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const started = (leo: string): string[] =>
  events(leo).filter((e) => e.event === "item_start").map((e) => String(e.item));

function stream(text: string) {
  return (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    yield { type: "result", result: text, total_cost_usd: 0 };
  })();
}

interface Fake {
  /** Item texts (substring match) whose worker reports `blocked` instead of `done`. */
  fail?: string[];
  /** Item text substring → the SIGNALS line that worker reports. */
  signals?: Record<string, string>;
}

/** The worker's prompt arrives as the driver's InputChannel (streaming input), so the
 *  fake reads its first message to learn which item it was handed. */
type ChannelMessage = { message?: { content?: Array<{ text?: string }> } };
async function firstPrompt(channel: unknown): Promise<string> {
  const it = (channel as AsyncIterable<ChannelMessage>)[Symbol.asyncIterator]();
  const first = await it.next();
  return first.value?.message?.content?.[0]?.text ?? "";
}

/** Install a fake harness that plays every role deterministically: the worker reports
 *  done (or blocked) for whatever item its prompt names, and the conductor finishes a
 *  done turn and answers a blocked one (so the item ends NOT done, exactly as a real
 *  failure does). */
function installFake(f: Fake = {}): void {
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      return (async function* () {
        const text = await firstPrompt(input.prompt);
        const item = (text.match(/Work on this plan item now:\n\n([\s\S]*?)\n\n/) ?? [])[1]?.trim() ?? "";
        const failing = (f.fail ?? []).some((s) => item.includes(s));
        const sig = Object.entries(f.signals ?? {}).find(([s]) => item.includes(s))?.[1];
        const block =
          "```leopold-status\nSTATUS: " + (failing ? "blocked" : "done") +
          "\nITEM: " + item + "\nSUMMARY: " + (failing ? "stuck" : "implemented and verified") +
          "\nNEXT: none\nEVIDENCE: build+test ok" + (sig ? `\nSIGNALS: ${sig}` : "") + "\n```";
        yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
        yield { type: "result", result: block, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    if (sys.includes("the conductor")) {
      return /STATUS:\s*blocked/i.test(prompt)
        ? stream('{"action":"answer","reply":"try another angle","classification":"reversible","charterBasis":"retry"}')
        : stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    }
    return stream('{"ok":true,"blocking":[],"summary":"clean"}');
  }) as never);
}

/** Run the driver with stdout silenced. */
async function drive(root: string, argv: string[]): Promise<void> {
  const log = console.log, warn = console.warn, write = process.stdout.write.bind(process.stdout);
  console.log = () => {}; console.warn = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await runDriver(root, argv); }
  finally { console.log = log; console.warn = warn; process.stdout.write = write; resetQuery(); }
}

// Item 6 is the rollback the run only reaches by failing item 2: on the happy path it
// sits at the end of the static chain, on the failure path the route jumps straight to
// it and the chain 3→4→5 is bypassed.
const ROUTING_PLAN = `# Plan

- [ ] Prepare the release
- [ ] Run the migration
      @on fail -> 6
- [ ] (after: 2) Announce the release
- [ ] (after: 3) Smoke test production
- [ ] (after: 4) Close the change ticket
- [ ] (after: 5) Roll the migration back
`;

const BASE = ["--no-review", "--no-hypotheses", "--no-literal-reset"];

test("a failing item takes its @on fail route: the run executes the target next, and the log says why", async () => {
  const { root, leo } = briefRepo(ROUTING_PLAN);
  installFake({ fail: ["Run the migration"] });
  await drive(root, BASE);

  assert.deepEqual(started(leo), [
    "Prepare the release",
    "Run the migration",
    "Roll the migration back",
  ], "the run jumped from the failed item to its route target, bypassing 3-5");

  const route = events(leo).find((e) => e.event === "route");
  assert.ok(route, "the route was recorded in the events log");
  assert.equal(route!.from, 2);
  assert.equal(route!.to, 6);
  assert.equal(route!.when, "fail");
  assert.equal(route!.status, "fail");
  assert.match(String(route!.why), /item 2 ended "fail" and declares @on fail/, "the log says WHY the edge was taken");

  // The failed item was NOT retried and did NOT count as a run failure: the plan
  // declared where a failure goes, so walking that path is not a failing run.
  assert.equal(events(leo).filter((e) => e.event === "item_incomplete").length, 0);
  assert.ok(events(leo).some((e) => e.event === "item_routed" && e.index === 2));

  // The routed-around item stays OPEN in PLAN.md — the honest record of what ran.
  const md = fs.readFileSync(path.join(leo, "PLAN.md"), "utf8");
  assert.match(md, /- \[ \] Run the migration/);
  assert.match(md, /- \[ \] \(after: 3\) Smoke test production/);
  assert.match(md, /- \[x\] \(after: 5\) Roll the migration back/);
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "routed_complete");
});

test("the same plan with that item succeeding takes no route: the static order just continues", async () => {
  const { root, leo } = briefRepo(ROUTING_PLAN);
  installFake(); // nothing fails
  await drive(root, BASE);

  assert.deepEqual(started(leo), [
    "Prepare the release",
    "Run the migration",
    "Announce the release",
    "Smoke test production",
    "Close the change ticket",
    "Roll the migration back",
  ], "no route was taken, so the plan ran exactly in its declared order");
  assert.equal(events(leo).filter((e) => e.event === "route").length, 0, "no route event at all");
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "plan_complete");
  assert.doesNotMatch(fs.readFileSync(path.join(leo, "PLAN.md"), "utf8"), /- \[ \]/, "every box is checked");
});

test("routing works the same on the --parallel path", async () => {
  const { root, leo } = briefRepo(ROUTING_PLAN);
  installFake({ fail: ["Run the migration"] });
  await drive(root, [...BASE, "--parallel", "2"]);

  const seen = started(leo);
  assert.ok(seen.includes("Roll the migration back"), "the route target ran");
  assert.ok(!seen.includes("Announce the release"), "the bypassed chain never ran");
  const route = events(leo).find((e) => e.event === "route");
  assert.ok(route && route.from === 2 && route.to === 6);
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "routed_complete");
});

test("a taken route outranks the positional order: the target runs before a lower-index item", async () => {
  // Item 3 is dispatchable the whole time and sits BELOW the route's target, so the
  // only reason to run 4 first is that a route said so.
  const { root, leo } = briefRepo(
    "# Plan\n\n- [ ] Run the migration\n      @on fail -> 4\n- [ ] (after: 1) Ship the release\n" +
    "- [ ] Tidy the changelog\n- [ ] (after: 3) Roll the migration back\n",
  );
  installFake({ fail: ["Run the migration"] });
  await drive(root, BASE);
  assert.deepEqual(started(leo), ["Run the migration", "Roll the migration back", "Tidy the changelog"]);
});

// --- signals steering the dispatch ---------------------------------------------

const SIGNAL_PLAN = `# Plan

- [ ] Run the migration
      @emit migrated=true
      @on migrated=false -> 3
- [ ] (after: 1) Ship the release
- [ ] (after: 2) Roll the migration back
`;

test("a signal the node emitted steers the next dispatch", async () => {
  const { root, leo } = briefRepo(SIGNAL_PLAN);
  installFake({ signals: { "Run the migration": "migrated=false, leaked=nope" } });
  await drive(root, BASE);

  assert.deepEqual(started(leo), ["Run the migration", "Roll the migration back"]);
  assert.deepEqual(readSignals(leo), { migrated: "false" }, "the channel carries the decision the node reported");
  const refused = events(leo).find((e) => e.event === "signal_refused");
  assert.ok(refused && refused.key === "leaked", "a key the item never declared with @emit is refused");
  const route = events(leo).find((e) => e.event === "route");
  assert.match(String(route!.why), /signal migrated="false" matches @on migrated=false/);
});

test("the same plan with the declared signal value: no route, the static order continues", async () => {
  const { root, leo } = briefRepo(SIGNAL_PLAN);
  installFake(); // the worker reports nothing -> the single declared value is emitted
  await drive(root, BASE);

  assert.deepEqual(started(leo), ["Run the migration", "Ship the release", "Roll the migration back"]);
  assert.deepEqual(readSignals(leo), { migrated: "true" });
  assert.equal(events(leo).filter((e) => e.event === "route").length, 0);
});

test("signalsFor: the plan decides what a node may put on the channel, not the worker", () => {
  const [item] = parsePlan("- [ ] Migrate\n      @emit migrated=true\n");
  // Declared key, worker value wins.
  assert.deepEqual(signalsFor(item, { done: true, signals: { migrated: "false" } }).emitted, { migrated: "false" });
  // Undeclared key: refused, naming it.
  const r = signalsFor(item, { done: true, signals: { patch: "diff --git a/x" } });
  assert.deepEqual(r.emitted, { migrated: "true" });
  assert.equal(r.refused[0].key, "patch");
  // A failed node auto-emits nothing: the declared value describes success.
  assert.deepEqual(signalsFor(item, { done: false }).emitted, {});
  // Two declared values for one key is ambiguous — the worker must say which.
  const [amb] = parsePlan("- [ ] Check\n      @emit ok=true\n      @emit ok=false\n");
  assert.deepEqual(signalsFor(amb, { done: true }).emitted, {});
});

// --- backward compatibility: a plan with no routes dispatches exactly as before ---

const STATIC_PLAN = `# Plan

- [ ] Add the API layer
- [ ] (after: 1) Wire the UI to the API
- [ ] Independent docs pass
- [ ] (deps: 2, 3) Write the e2e tests
`;

test("with no routes, dispatchPlan IS readyItems — every fixture, every step of the run", () => {
  const dir = path.join(HERE, "fixtures", "plans");
  const plans = [STATIC_PLAN, ...fs.readdirSync(dir).filter((f) => f.endsWith(".md"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))];
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-bc-")); // no bus.json: an empty channel
  for (const plan of plans) {
    const items = parsePlan(plan);
    const routing = newRouting();
    for (let step = 0; step < 200; step++) {
      const expected = readyItems(items, new Set()).map((i) => i.index);
      const actual = dispatchPlan(leo, items, routing).order.map((i) => i.index);
      assert.deepEqual(actual, expected, `step ${step}`);
      if (!expected.length) break;
      // Close the item the serial loop would have picked: the first open one.
      items.find((i) => !i.done)!.done = true;
    }
  }
});

test("a routeless plan runs in the same order serially, and completes under --parallel", async () => {
  const a = briefRepo(STATIC_PLAN);
  installFake();
  await drive(a.root, BASE);
  assert.deepEqual(started(a.leo), [
    "Add the API layer", "Wire the UI to the API", "Independent docs pass", "Write the e2e tests",
  ], "serial dispatch order is the plan's order, exactly as before routing existed");
  assert.equal(events(a.leo).find((e) => e.event === "stop")!.reason, "plan_complete");

  const b = briefRepo(STATIC_PLAN);
  installFake();
  await drive(b.root, [...BASE, "--parallel", "2"]);
  const seen = started(b.leo);
  assert.deepEqual([...seen].sort(), [
    "Add the API layer", "Independent docs pass", "Wire the UI to the API", "Write the e2e tests",
  ]);
  assert.ok(seen.indexOf("Write the e2e tests") > seen.indexOf("Wire the UI to the API"), "deps still gate the wave");
  assert.equal(events(b.leo).find((e) => e.event === "stop")!.reason, "plan_complete");
  assert.doesNotMatch(fs.readFileSync(path.join(b.leo, "PLAN.md"), "utf8"), /- \[ \]/);
});

// A `@needs` NOTHING declares is a static defect, and the preflight gate rejects it
// before a single agent runs (test/preflight.test.ts owns that contract). What the
// scheduler still has to survive is a need that is legal on paper and unmet at
// runtime: item 1 may emit `approved`, but it declares two values for it, so nothing
// is written unless the worker itself reports one. It does not, so item 2 can never
// become ready — and the run must STOP by name instead of spinning or claiming success.
test("a declared-but-unemitted @needs stops the run by name instead of spinning or claiming success", async () => {
  const { root, leo } = briefRepo(
    "# Plan\n\n- [ ] Build it\n      @emit approved=yes\n      @emit approved=no\n" +
    "- [ ] (after: 1) Deploy it\n      @needs approved\n",
  );
  installFake();
  await drive(root, BASE);
  assert.deepEqual(started(leo), ["Build it"]);
  assert.deepEqual(readSignals(leo), {}, "no signal landed: the plan declared two values, the worker reported none");
  const stop = events(leo).find((e) => e.event === "stop")!;
  assert.equal(stop.reason, "deadlock");
  assert.deepEqual(events(leo).find((e) => e.event === "deadlock")!.items, [2]);
});

// A route whose target is ALREADY DONE points nowhere the scheduler can go: dispatch
// drops a routed target that is done, so settling the failure on that route would end
// the run as "routed_complete" while the declared recovery never ran — a failed run
// reported as a clean success. Backward `@on fail -> N` is the natural way to write a
// retry, and the same shape appears on resume when a forward route points at an item
// an earlier run checked off.
test("a route to an already-done item does not settle the failure: the run retries and escalates instead", async () => {
  const { root, leo } = briefRepo(
    "# Plan\n\n- [x] Set up the database\n- [ ] Run the migration\n      @on fail -> 1\n",
  );
  installFake({ fail: ["Run the migration"] });
  await drive(root, BASE);

  const stop = events(leo).find((e) => e.event === "stop")!;
  assert.notEqual(stop.reason, "routed_complete", "a failure the graph cannot route is never a complete run");
  assert.equal(events(leo).filter((e) => e.event === "route").length, 0, "no route was taken");
  const named = events(leo).find((e) => e.event === "route_unreachable");
  assert.ok(named, "the unusable route is named in the events log");
  assert.equal(named!.item, 2);
  assert.equal(named!.to, 1);
  assert.match(String(named!.reason), /item 2 routes to item 1, which is already done/);
  assert.ok(events(leo).some((e) => e.event === "item_incomplete"), "the item fell back to the retry path");
  assert.match(fs.readFileSync(path.join(leo, "PLAN.md"), "utf8"), /- \[ \] Run the migration/);
});

// --- the latch: a taken route stays taken, whatever a later node writes ---
//
// Signal keys are GLOBAL, and every `@tool` node writes the same `exit` whether or not
// the plan spells it out. Deriving the taken routes from the live channel on every
// round therefore let a later node silently UN-TAKE an earlier node's route: the branch
// the plan steered past became dispatchable again, and the serial loop walked into it.
// Here item 1's build passed and routed to item 3; item 3's tests then fail with
// `exit=1`, overwriting the very key item 1 routed on. Item 2 ("fix the build") must
// stay bypassed — the build passed, and nothing that happened afterwards changes that.
test("a route taken on a signal a later node overwrites stays taken, and its branch stays bypassed", () => {
  const plan = (first: string) => `# Plan

- [${first}] @tool run the build \`make build\`
      @on exit=0 -> 3
- [ ] (after: 1) fix the build
- [ ] (after: 1) @tool run the tests \`make test\`
`;
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-latch-"));
  const routing = newRouting();

  let items = parsePlan(plan(" "));
  assert.deepEqual(dispatchPlan(leo, items, routing).order.map((i) => i.index), [1]);
  const s1 = settleNode(leo, items, items[0], { done: true, signals: { exit: "0" } }, routing);
  assert.deepEqual(s1.routes.map((r) => r.to), [3], "the build passed and the plan routes past the fix");

  items = parsePlan(plan("x")); // the loop checks item 1 off in PLAN.md and re-parses
  const round2 = dispatchPlan(leo, items, routing);
  assert.deepEqual(round2.order.map((i) => i.index), [3]);
  assert.deepEqual(round2.bypassed, [2]);

  // Item 3's tests fail: `exit` on the channel flips to 1. Item 3 declares no route, so
  // it is retried — and item 1's route must NOT be re-evaluated against the new value.
  const s3 = settleNode(leo, items, items[2], { done: false, signals: { exit: "1" } }, routing);
  assert.deepEqual(s3.routes, [], "item 3 declares no route, so it settles nothing");
  assert.equal(readSignals(leo).exit, "1", "the later node did overwrite the key item 1 routed on");

  const round3 = dispatchPlan(leo, items, routing);
  assert.deepEqual(round3.bypassed, [2], "the fix branch stays bypassed: the build passed");
  assert.deepEqual(round3.routed, [3], "the taken route is latched, not re-derived");
  assert.deepEqual(round3.order.map((i) => i.index), [3], "the loop retries the tests, it does not 'fix' a build that passed");
});
