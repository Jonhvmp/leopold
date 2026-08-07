// The graph, compiled into the workflow engine — and the proof that /leopold-workflow
// routes the SAME plan the SAME way /leopold-run does.
//
// Four things are proven here:
//   1. a routing plan compiles to a `graph` payload carrying the conditional edges, and
//      the workflow harness drives the real script down BOTH branches;
//   2. the workflow's execution order is IDENTICAL to the driver's scheduler order for
//      the same plan and the same outcomes — asserted against dispatchPlan/settleNode
//      themselves, not against a hand-written expectation;
//   3. a plan with no graph grammar compiles to a byte-identical payload and emits a
//      byte-identical script, and the script's agent calls are unchanged;
//   4. a malformed graph is refused at compile time, before a single agent runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { compileBrief } from "../src/compile.ts";
import { parsePlan } from "../src/plan.ts";
import { dispatchPlan, newRouting, settleNode } from "../src/dispatch.ts";
import { runWorkflowCommand } from "../src/workflow-cmd.ts";
import { fileURLToPath } from "node:url";
import { runWorkflow, workflowPath, type Responder } from "./workflow-harness.ts";

const SCRIPT = workflowPath("leopold-workflow", "leopold-run.workflow.js");
const DRIVER_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const CHARTER = "Be pragmatic.";

// A migration that either lands or has to be rolled back: items 3 and 4 both sit
// statically after 2, and the `@on` pair is what makes exactly one of them run.
const BRANCH_PLAN = `# Plan
- [ ] Prepare the ground
- [ ] (after: 1) Run the database migration
      @emit migrated=true
      @emit migrated=false
      @on migrated=true -> 3
      @on migrated=false -> 4
- [ ] (after: 2) Ship the feature behind the flag
- [ ] (after: 2) Roll the migration back
`;

const LEGACY_PLAN = `# Plan
- [ ] First thing
- [ ] Second thing
- [ ] (after: 1) Third depends on first
`;

function compile(planText: string) {
  return compileBrief({ mission: "# Mission\nShip it.", charter: CHARTER, planText });
}

/** Run the workflow script over a compiled plan, deciding each item's outcome from
 *  `decide` (item id → the signals it reports, or `false` to fail its review). */
async function driveWorkflow(planText: string, decide: (id: string) => Record<string, string> | false) {
  const respond: Responder = ({ opts }) => {
    const label = String(opts.label || "");
    const parts = label.split(":");
    if (parts[0] === "verify") return { ok: true, blocking: [] }; // the review gate
    if (parts[0] === "node") {
      return parts[1] === "tool" ? { exit: 0 } : { ok: true, blocking: [] };
    }
    const verdict = decide(parts[1]);
    return verdict === false ? { summary: "could not finish" } : { summary: "done", signals: verdict };
  };
  return runWorkflow(SCRIPT, { args: compile(planText), respond });
}

/** The order the DRIVER's scheduler would dispatch, for the same plan and outcomes.
 *  Uses the real seam (dispatchPlan + settleNode), so parity is asserted against the
 *  driver's actual routing, never against a restatement of it. */
function driverOrder(planText: string, outcome: (index: number) => { done: boolean; signals?: Record<string, string> }): number[] {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-parity-"));
  const items = parsePlan(planText);
  const routing = newRouting();
  const order: number[] = [];
  const closed = new Set<number>();
  for (let guard = 0; guard < 50; guard++) {
    const next = dispatchPlan(leo, items, routing).order.find((i) => !closed.has(i.index));
    if (!next) break;
    order.push(next.index);
    closed.add(next.index);
    const o = outcome(next.index);
    settleNode(leo, items, next, o, routing);
    // The driver marks a finished item done in PLAN.md; the next dispatch re-reads it.
    if (o.done) next.done = true;
  }
  return order;
}

/** The plan indices the workflow actually ran, in order — read from the labels of the
 *  agents that EXECUTE a node (`impl:<id>` for work, `node:<kind>:<id>` for the rest),
 *  never from the review gate's `verify:<id>:<lens>`. */
function workflowOrder(agents: Array<{ label?: string }>): number[] {
  const out: number[] = [];
  for (const a of agents) {
    const m = String(a.label ?? "").match(/^(?:impl|node:(?:gate|verify|tool)):i(\d+)$/);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

test("a routing plan compiles to a graph carrying the conditional edges", () => {
  const c = compile(BRANCH_PLAN);
  assert.ok(c.graph, "a plan with @on must compile a graph");
  assert.equal(c.graph!.nodes.length, 4);
  const migration = c.graph!.nodes.find((n) => n.index === 2)!;
  assert.deepEqual(
    migration.routes.map((r) => ({ when: r.when, target: r.target, kind: r.kind })),
    [
      { when: "migrated=true", target: 3, kind: "signal" },
      { when: "migrated=false", target: 4, kind: "signal" },
    ],
  );
  assert.deepEqual(migration.emits, [{ key: "migrated", value: "true" }, { key: "migrated", value: "false" }]);
  // The waves payload still compiles, so an older copy of the script keeps running.
  assert.equal(c.waves.flat().length, 4);
});

test("the emitted script contains the branch: the router, not just the wave loop", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  for (const marker of ["routeDecision", "routeMatches", "takenRoutes", "signalsFor", "@on"]) {
    assert.ok(src.includes(marker), `the canonical script must carry ${marker}`);
  }
});

test("the migration succeeds -> the run ships, and never rolls back", async () => {
  const r = await driveWorkflow(BRANCH_PLAN, (id) => (id === "i2" ? { migrated: "true" } : {}));
  assert.deepEqual(workflowOrder(r.agents), [1, 2, 3]);
  assert.deepEqual((r.result as { routes: unknown[] }).routes, [{ from: 2, to: 3, when: "migrated=true" }]);
});

test("the migration fails -> the run rolls back, and never ships", async () => {
  const r = await driveWorkflow(BRANCH_PLAN, (id) => (id === "i2" ? { migrated: "false" } : {}));
  assert.deepEqual(workflowOrder(r.agents), [1, 2, 4]);
  assert.deepEqual((r.result as { routes: unknown[] }).routes, [{ from: 2, to: 4, when: "migrated=false" }]);
});

for (const [name, decided] of [["true", "true"], ["false", "false"]] as const) {
  test(`both engines route the same plan the same way (migrated=${name})`, async () => {
    const signals = (i: number) => (i === 2 ? { migrated: decided } : undefined);
    const expected = driverOrder(BRANCH_PLAN, (i) => ({ done: true, signals: signals(i) }));
    const r = await driveWorkflow(BRANCH_PLAN, (id) => (id === "i2" ? { migrated: decided } : {}));
    assert.deepEqual(workflowOrder(r.agents), expected);
  });
}

test("a node may only emit what it declared; anything else is refused", async () => {
  const r = await driveWorkflow(BRANCH_PLAN, (id) =>
    id === "i2" ? { migrated: "true", stolen: "a whole file of work product" } : {},
  );
  assert.ok(r.logs.some((l) => l.includes("signal refused") && l.includes("stolen")));
  assert.ok(!r.logs.some((l) => l.includes("stolen=")));
});

test("a @human node stops the run and asks, dispatching nothing after it", async () => {
  const plan = `# Plan
- [ ] Build the thing
- [ ] (after: 1) @human Approve the rollout
- [ ] (after: 2) Announce it
`;
  const r = await driveWorkflow(plan, () => ({}));
  assert.deepEqual(workflowOrder(r.agents), [1]);
  const out = r.result as { awaiting_human?: { item: string }; note: string };
  assert.ok(out.awaiting_human, "the run must report that it is awaiting a human");
  assert.match(out.awaiting_human!.item, /Approve the rollout/);
  assert.match(out.note, /@human/);
});

test("a @tool node routes on its command's exit status, with no @emit line", async () => {
  // Both branches sit statically after the tool node, so the ROUTE is the only thing
  // that can pick between them: without `(after: 1)` they would both be ready from the
  // start and both engines would run both, which is a plan that declares no branch.
  const plan = `# Plan
- [ ] @tool run the suite: \`make test\`
      @on exit=0 -> 2
      @on exit=1 -> 3
- [ ] (after: 1) Ship it
- [ ] (after: 1) Fix the suite
`;
  const drive = async (exit: number) =>
    runWorkflow(SCRIPT, {
      args: compile(plan),
      respond: ({ opts }) => (String(opts.label).startsWith("node:tool:") ? { exit } : { ok: true, blocking: [] }),
    });

  const green = await drive(0);
  assert.deepEqual(workflowOrder(green.agents), [1, 2]);
  const red = await drive(1);
  assert.deepEqual(workflowOrder(red.agents), [1, 3]);

  // …and the driver takes the same two paths through the same plan.
  for (const [exit, expected] of [["0", [1, 2]], ["1", [1, 3]]] as const) {
    assert.deepEqual(
      driverOrder(plan, (i) => ({ done: true, signals: i === 1 ? { exit } : undefined })),
      expected,
    );
  }
});

test("a malformed graph is refused at compile time, naming the offender", () => {
  const plan = `# Plan
- [ ] Run the migration
      @on fail -> 99
- [ ] Ship it
`;
  assert.throws(() => compile(plan), (e: Error) => {
    assert.match(e.message, /item 1 \("Run the migration"\) routes to item 99, which does not exist/);
    return true;
  });
});

test("an unmet @needs is refused at compile time, naming the item and the key", () => {
  assert.throws(
    () => compile("# Plan\n- [ ] Ship it\n      @needs deployed\n"),
    /needs signal "deployed", which no item emits/,
  );
});

// --- backward compatibility -------------------------------------------------------

test("a plan with no graph grammar compiles to a byte-identical payload", () => {
  const c = compile(LEGACY_PLAN);
  assert.equal("graph" in c, false, "no graph key may appear for a plain checklist");
  assert.equal(
    JSON.stringify(c),
    JSON.stringify({
      mission: "# Mission\nShip it.",
      charter: CHARTER,
      maxReviewRounds: 2,
      waves: [
        [
          { id: "i1", text: "First thing", effort: "medium", critical: false, sensitive: false },
          { id: "i2", text: "Second thing", effort: "medium", critical: false, sensitive: false },
        ],
        [{ id: "i3", text: "Third depends on first", effort: "medium", critical: false, sensitive: false }],
      ],
    }),
  );
});

test("a plan with no routes runs the wave loop untouched: same prompts, same report", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: compile(LEGACY_PLAN),
    respond: ({ opts }) => (String(opts.label).startsWith("verify:") ? { ok: true, blocking: [] } : "impl done"),
  });
  assert.deepEqual(r.agents.filter((a) => a.label?.startsWith("impl:")).map((a) => a.label), ["impl:i1", "impl:i2", "impl:i3"]);
  // No schema is attached to an impl agent that declares no signals, and no signals
  // block reaches its prompt — the prompt is the one this script has always built.
  const impl = r.agents.find((a) => a.label === "impl:i1")!;
  assert.equal(impl.opts.schema, undefined);
  assert.ok(!impl.prompt.includes("Signals —"));
  const out = r.result as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["mission", "total", "done", "incomplete", "note"]);
  assert.equal(out.done, 3);
});

test("`leopold-driver workflow` emits the canonical script byte for byte", async () => {
  // The command serves the script vendored into assets/ by the build. That directory is
  // gitignored build output, so it can be absent (fresh clone) or stale (built before
  // the script changed) when the tests run — either way this test would be measuring the
  // last build instead of the current script. Re-run the build's own vendoring step, so
  // the comparison is always against what a published package would actually carry.
  execFileSync(process.execPath, [path.join(DRIVER_ROOT, "scripts", "copy-runtime.mjs")], { stdio: "ignore" });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-wf-emit-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "MISSION.md"), "# Mission\nShip it.\n");
  fs.writeFileSync(path.join(leo, "CHARTER.md"), "# Charter\nSimplicity.\n");
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- max_failures: 3\n");
  fs.writeFileSync(path.join(leo, "PLAN.md"), LEGACY_PLAN);

  const code = await runWorkflowCommand(root, []);
  assert.equal(code, 0);
  const emitted = fs.readFileSync(path.join(root, ".claude", "workflows", "leopold-run.js"));
  assert.deepEqual(emitted, fs.readFileSync(SCRIPT), "the emitted script is a copy, never generated code");
  const args = JSON.parse(fs.readFileSync(path.join(leo, "workflow-args.json"), "utf8"));
  assert.equal("graph" in args, false);
});

// --- the latch, on both engines ---------------------------------------------------
//
// Every `@tool` node writes the same global `exit` key. A route taken on item 1's
// `exit=0` must survive item 3 overwriting `exit` with 1 — otherwise the branch the
// plan steered past ("fix the build") becomes dispatchable again and a work node edits
// the repo to fix a build that passed. Asserted on the workflow engine AND the driver,
// because a latch that only one of them holds is half-shipped.
const LATCH_PLAN = `# Plan
- [ ] @tool run the build \`make build\`
      @on exit=0 -> 3
- [ ] (after: 1) fix the build
- [ ] (after: 1) @tool run the tests \`make test\`
`;

test("a later node overwriting the routed-on signal never un-takes the route — both engines", async () => {
  const exits: Record<string, number> = { i1: 0, i3: 1 };
  const respond: Responder = ({ opts }) => {
    const parts = String(opts.label || "").split(":");
    if (parts[0] === "verify") return { ok: true, blocking: [] };
    if (parts[0] === "node" && parts[1] === "tool") return { exit: exits[parts[2]] ?? 0 };
    return { summary: "done" };
  };
  const r = await runWorkflow(SCRIPT, { args: compile(LATCH_PLAN), respond });
  const order = workflowOrder(r.agents);
  assert.deepEqual(order, [1, 3], "item 2 never runs: the build passed, so the plan routed past the fix");

  assert.deepEqual(
    driverOrder(LATCH_PLAN, (i) => ({ done: exits[`i${i}`] === 0, signals: { exit: String(exits[`i${i}`] ?? 0) } })),
    order,
    "the driver dispatches the same order the workflow ran",
  );
});
