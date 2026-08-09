// The in-session engine (hooks/stop-continuity.sh) parses PLAN.md in bash, on purpose:
// it must run with no Node, no install and no build. That makes it a SECOND
// implementation of the plan grammar, and two implementations drift. This test parses
// the same plans with BOTH -- the driver's parser and the hook -- and fails the moment
// they disagree about what the plan means, i.e. about the first open item's node kind.
//
// The contract under test: the item the hook is "at" is the first open checkbox (the one
// the re-injected instruction tells the agent to pick). If that item is a `@human` node,
// what happens depends on the JUDGMENT POSTURE and on nothing else -- under the default
// `autonomy: full` the node is executed under a synthesized role and the hook re-injects,
// under `autonomy: ask` the hook allows the stop and records `awaiting_human` -- exactly
// as the driver resolves a human node in each posture. Any other kind -- and every plan
// written before the grammar existed -- re-injects, unchanged, in both postures.
//
// So every case below is parsed by both engines under BOTH postures: a drift that only
// shows up when someone opts back into `ask` is still a drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePlan } from "../src/plan.ts";
import { haltsRun } from "../src/kinds.ts";
import type { Autonomy } from "../src/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = path.join(REPO, "hooks", "stop-continuity.sh");

/** bash + jq are what the hook itself requires. Absent (Windows without a shell), the
 *  test cannot run at all -- say so loudly instead of asserting nonsense. */
function toolsPresent(): string | false {
  if (!fs.existsSync(HOOK)) return "hooks/stop-continuity.sh not found";
  const r = spawnSync("bash", ["-c", "command -v jq >/dev/null"], { stdio: "ignore" });
  if (r.error) return "bash is not available";
  if (r.status !== 0) return "jq is not installed (the hook requires it)";
  return false;
}
const MISSING = toolsPresent();

/** Run the Stop hook against one plan in a hermetic temp project, under `autonomy`.
 *  Returns `"block"` when the hook re-injects, otherwise the `stopped_reason` it recorded.
 *
 *  The posture is written into GUARDRAILS.md -- the brief's own channel, so this exercises
 *  the same parsing a user's guardrails get -- and LEOPOLD_AUTONOMY is always cleared, so
 *  an ambient env var cannot flip the suite. */
function hookSays(plan: string, autonomy: Autonomy = "full"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-hook-"));
  try {
    const leo = path.join(root, ".leopold");
    fs.mkdirSync(leo);
    fs.writeFileSync(path.join(leo, "PLAN.md"), plan);
    fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), `# Guardrails\n- autonomy: ${autonomy}\n`);
    fs.writeFileSync(
      path.join(leo, "state.json"),
      JSON.stringify({ active: true, iteration: 1, max_iterations: 50 }),
    );
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ cwd: root }),
      encoding: "utf8",
      env: { ...process.env, LEOPOLD_AUTONOMY: "" },
    });
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    const out = (r.stdout ?? "").trim();
    if (out) return String((JSON.parse(out) as { decision?: string }).decision ?? "");
    const state = JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")) as {
      stopped_reason?: string;
    };
    return String(state.stopped_reason ?? "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** What the DRIVER's parser says the hook must do with this plan -- or null when the
 *  driver cannot see the plan at all. That happens for CRLF files only: JS `.` never
 *  matches `\r`, so the parser recognises no checkbox in one (a pre-existing quirk, the
 *  fixture "windows line endings" records it). The hook has always read those plans --
 *  its open-item count is a grep -- and this change does not touch that, so a plan the
 *  driver cannot see is out of the comparison and is asserted on its own below. */
function driverSays(plan: string, autonomy: Autonomy): string | null {
  const items = parsePlan(plan);
  if (items.length === 0 && /^[ \t]*- \[[ xX]\]/m.test(plan)) return null;
  const open = items.filter((i) => !i.done);
  if (open.length === 0) return "plan_complete";
  // haltsRun is the driver's answer to "does this node stop the run?" -- the same
  // function both schedulers gate on. Reusing it is the point: the expectation cannot be
  // hardcoded, so a change to the posture rule shows up here as a disagreement.
  return haltsRun(open[0].kind, autonomy) ? "awaiting_human" : "block";
}

let compared = 0;
function agree(plan: string, label: string): void {
  for (const autonomy of ["full", "ask"] as const) {
    const expected = driverSays(plan, autonomy);
    if (expected === null) return; // CRLF: see driverSays
    compared += 1;
    assert.equal(hookSays(plan, autonomy), expected, `hook and driver disagree on: ${label} (autonomy: ${autonomy})`);
  }
}

// Every shape of the grammar that can decide the answer, plus the shapes that look like
// it and must not. Expectations are never hardcoded: the driver's parser is the oracle.
const CASES: Record<string, string> = {
  "no kinds at all": "- [x] done\n- [ ] plain item\n- [ ] another\n",
  "human inline": "- [ ] @human Ask the team about pricing\n- [ ] later\n",
  "human after a done item": "- [x] @work shipped\n- [ ] @human Decide the price\n",
  "human on a marker line": "- [ ] Migrate the db\n      @node human ops\n- [ ] next\n",
  "human with an explicit label": "- [ ] @human decide: the pricing\n",
  "human with a dep marker first": "- [ ] one\n- [ ] (after: 1) @human Decide\n",
  "dep marker after the kind": "- [ ] one\n- [ ] @human (after: 1) Decide\n",
  "uppercase marker": "- [ ] @HUMAN Ask\n",
  "node keyword with a colon": "- [ ] @node: human Ask them\n",
  "two kinds on one line, last wins": "- [ ] @gate sec @human Ask them\n",
  "kind overridden by a marker line": "- [ ] item\n      @node human\n      @node work\n",
  "kind set by a later marker line": "- [ ] @work item\n      @node human\n",
  "gate is not human": "- [ ] @gate security Review the auth diff\n",
  "tool is not human": "- [ ] @tool run the migration\n",
  "tool keeps its command's first word": "- [ ] @tool make test\n",
  "tool with an explicit label": "- [ ] @tool build: make release\n",
  "verify is not human": "- [ ] @verify the suite is green\n",
  "feedback is not human": "- [ ] @feedback Read the run and improve the plan\n",
  "feedback with a label": "- [ ] @feedback health Read the run\n- [ ] next\n",
  "feedback on a marker line": "- [ ] Read the run\n      @node feedback\n- [ ] next\n",
  "@feedbacks is prose": "- [ ] @feedbacks from the beta users\n",
  "@humanoid is prose": "- [ ] @humanoid robotics research\n",
  "@needs human is a need, not a kind": "- [ ] item\n      @needs human\n- [ ] next\n",
  "@emit human is a signal, not a kind": "- [ ] item\n      @emit human=true\n",
  "@on human is a route, not a kind": "- [ ] item\n      @on human -> 2\n- [ ] next\n",
  "@scenario mentioning @human": "- [ ] item\n      @scenario @human node reached -> stop\n",
  "done human node is not reached": "- [x] @human already answered\n- [ ] plain work\n",
  "human node behind an unfinished one": "- [ ] plain work\n- [ ] @human Decide\n",
  "human node in a finished plan": "- [x] @human answered\n- [x] done\n",
  "nested bullet, human": "  - [ ] @human Ask\n",
  "tab-indented, human": "\t- [ ] @human Ask\n",
  "human as prose, not a marker": "- [ ] Ask a human about the pricing\n",
  "@node with no known kind": "- [ ] @node bogus thing\n",
  "empty item text after the kind": "- [ ] @human\n- [ ] next\n",
};

test("the hook and the driver agree on every shape of the kind grammar", { skip: MISSING }, () => {
  const before = compared;
  for (const [label, plan] of Object.entries(CASES)) agree(plan, label);
  assert.equal(compared - before, Object.keys(CASES).length * 2, "a case was silently skipped");
});

test("a CRLF plan keeps the behavior it had, kinds included", { skip: MISSING }, () => {
  // The driver's parser sees no items in a CRLF file (see driverSays), so there is
  // nothing to agree with. What must hold is that the hook did not change: it still
  // reads the plan, and it applies the kind grammar to it consistently -- under the
  // default posture the human node is executed like any other, under `ask` it stops.
  assert.equal(hookSays("- [ ] a\r\n- [ ] (after: 1) b\r\n"), "block");
  assert.equal(hookSays("- [x] a\r\n"), "plan_complete");
  assert.equal(hookSays("- [ ] @human Ask\r\n- [ ] later\r\n"), "block");
  assert.equal(hookSays("- [ ] @human Ask\r\n- [ ] later\r\n", "ask"), "awaiting_human");
});

test("the hook and the driver agree on this repo's real plans", { skip: MISSING }, () => {
  const dir = path.join(HERE, "fixtures", "plans");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  assert.ok(files.length >= 5, `expected the plan fixtures, found ${files.length}`);
  for (const file of files) {
    const plan = fs.readFileSync(path.join(dir, file), "utf8");
    // None of these declares a kind, so none of them can ever reach the new branch: this
    // is the backward-compatibility half of the proof, on real plans.
    for (const it of parsePlan(plan)) {
      assert.equal(it.kind, "work", `${file} item ${it.index} is no longer a work node`);
    }
    agree(plan, file);
  }
});

test("the hook and the driver agree on the old grammar's awkward corners", { skip: MISSING }, () => {
  const edge: { cases: Record<string, string> } = JSON.parse(
    fs.readFileSync(path.join(HERE, "fixtures", "plan-legacy-edge-cases.json"), "utf8"),
  );
  const names = Object.keys(edge.cases);
  assert.ok(names.length >= 15, `expected the edge-case battery, found ${names.length}`);
  for (const name of names) agree(edge.cases[name], name);
});

/** A hermetic run of the hook over one plan, returning everything the assertions need:
 *  what it printed, what it logged, and the state it left behind. */
function runHook(plan: string, guardrails?: string, env: Record<string, string> = {}): {
  stdout: string; stderr: string; events: Array<Record<string, unknown>>; state: Record<string, unknown>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-hook-"));
  try {
    const leo = path.join(root, ".leopold");
    fs.mkdirSync(leo);
    fs.writeFileSync(path.join(leo, "PLAN.md"), plan);
    if (guardrails !== undefined) fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), guardrails);
    fs.writeFileSync(path.join(leo, "state.json"), JSON.stringify({ active: true, iteration: 1 }));
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ cwd: root }),
      encoding: "utf8",
      env: { ...process.env, LEOPOLD_AUTONOMY: "", ...env },
    });
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    const raw = fs.existsSync(path.join(leo, "events.jsonl"))
      ? fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim()
      : "";
    return {
      stdout: (r.stdout ?? "").trim(),
      stderr: r.stderr ?? "",
      events: raw ? raw.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [],
      state: JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")) as Record<string, unknown>,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const HUMAN_PLAN = "- [x] shipped\n- [ ] @human Ask the team about pricing\n- [ ] later\n";

test("autonomy full: a @human node is executed under a synthesized role", { skip: MISSING }, () => {
  // The default posture, and the whole point: the plan asked a person, nobody is coming,
  // so the turn keeps going with the role synthesized in-session. Same resolution as
  // processItem() in the driver -- the hook cannot make a model call, so what it hands the
  // session is the instruction to synthesize the role, take it, and record the call.
  for (const guardrails of [undefined, "# Guardrails\n- autonomy: full\n"]) {
    const r = runHook(HUMAN_PLAN, guardrails);
    const reason = String((JSON.parse(r.stdout) as { decision: string; reason: string }).reason);
    assert.equal((JSON.parse(r.stdout) as { decision: string }).decision, "block", "the hook must re-inject");
    assert.match(reason, /THIS ITEM IS A @human NODE \(plan item 2: Ask the team about pricing\)/);
    assert.match(reason, /SYNTHESIZE the role/);
    assert.match(reason, /DECISIONS\.md/);
    assert.match(reason, /Reversal/);
    // The trust boundary is restated, never moved: a persona decides, the guard ships
    // nothing -- and the note is precise about which half of that a hook actually enforces
    // (guard scope = git commit + git push; the rest is the role's to keep). Whether the
    // wording ever over-claims again is asserted against the LIVE guard in
    // test/trust-boundary.test.ts; here we only pin that both halves are stated.
    assert.match(reason, /you do not ship/);
    assert.match(reason, /guard denies `git commit` and `git push`/);
    assert.match(reason, /never raise a budget or iteration limit/);
    assert.match(reason, /no hook will stop you/);
    // The run is not stopped, and the fork is on the event stream as a persona fork.
    assert.equal(r.state.active, true);
    assert.equal(r.state.stopped_reason, undefined);
    const persona = r.events.find((e) => e.event === "persona");
    assert.ok(persona, "no persona event was logged");
    assert.equal(persona.fork, "human");
    assert.equal(persona.engine, "hook");
    assert.equal(persona.item, 2);
    assert.equal(persona.text, "Ask the team about pricing");
    assert.equal(r.events.some((e) => e.event === "awaiting_human"), false, "nothing awaits a human");
  }
});

test("autonomy ask: a @human node names the item it is waiting on", { skip: MISSING }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-hook-"));
  try {
    const leo = path.join(root, ".leopold");
    fs.mkdirSync(leo);
    fs.writeFileSync(
      path.join(leo, "PLAN.md"),
      "- [x] shipped\n- [ ] @human Ask the team about pricing\n- [ ] later\n",
    );
    fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- autonomy: ask\n");
    fs.writeFileSync(path.join(leo, "state.json"), JSON.stringify({ active: true, iteration: 1 }));
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ cwd: root }),
      encoding: "utf8",
      env: { ...process.env, LEOPOLD_AUTONOMY: "" },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "", "the hook must allow the stop, not re-inject");
    // The human is told which item, in the terminal...
    assert.match(r.stderr, /item 2 is a @human node/);
    assert.match(r.stderr, /Ask the team about pricing/);
    // ...and the run records it, so the dashboard and the driver see the same thing.
    const events = fs
      .readFileSync(path.join(leo, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const awaiting = events.find((e) => e.event === "awaiting_human");
    assert.ok(awaiting, "no awaiting_human event was logged");
    assert.equal(awaiting.item, 2);
    assert.equal(awaiting.text, "Ask the team about pricing");
    const state = JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(state.active, false);
    assert.equal(state.stopped_reason, "awaiting_human");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the hook resolves the posture from the same places the driver does", { skip: MISSING }, () => {
  // Precedence and vocabulary, asserted against resolveAutonomy()/autonomyFrom() in
  // packages/driver/src/config.ts: explicit env > GUARDRAILS.md > full, `ask|halt|human`
  // all mean ask, and anything else means "not stated" -- never "halt".
  const decision = (g?: string, env?: string): string => {
    const r = runHook(HUMAN_PLAN, g, env === undefined ? {} : { LEOPOLD_AUTONOMY: env });
    return r.stdout ? String((JSON.parse(r.stdout) as { decision: string }).decision) : String(r.state.stopped_reason);
  };
  assert.equal(decision(), "block", "no guardrails at all: full");
  assert.equal(decision("# Guardrails\n- max_iterations: 50\n"), "block", "guardrails without the key: full");
  for (const word of ["ask", "halt", "human"]) {
    assert.equal(decision(`# Guardrails\n- autonomy: ${word}\n`), "awaiting_human", `autonomy: ${word}`);
  }
  assert.equal(decision("# Guardrails\n- **autonomy**: ask\n"), "awaiting_human", "bolded key");
  assert.equal(decision("# Guardrails\n- autonomy: ASK   # shout it\n"), "awaiting_human", "case + trailing comment");
  assert.equal(decision("# Guardrails\n- autonomy: whatever\n"), "block", "an unknown value is not a halt");
  assert.equal(decision("# Guardrails\n> The autonomy boundary for this run.\n"), "block", "prose is not the key");
  // Env is the explicit channel and outranks the brief, in both directions.
  assert.equal(decision("# Guardrails\n- autonomy: full\n", "ask"), "awaiting_human");
  assert.equal(decision("# Guardrails\n- autonomy: ask\n", "full"), "block");
  assert.equal(decision("# Guardrails\n- autonomy: ask\n", ""), "awaiting_human", "an empty env var is not a posture");
});
