// What each node KIND does at runtime, proven in the real scheduler with zero model
// calls. The whole loop reaches a harness through one seam (src/sdk.ts), so a
// deterministic fake lets these tests drive runDriver end to end and read the evidence
// out of events.jsonl, PLAN.md, the state channel and the git index.
//
// Four kinds, four observably different behaviors — and the fifth assertion is that a
// plan of plain work items is untouched by all of it:
//
//   @human  the run STOPS (`awaiting_human`), names the item, stages everything, and
//           spends no turn on it;
//   @tool   the declared command RUNS, its exit status becomes the `exit` signal, and
//           no model turn is spent (the fake counts every session it is asked for);
//   @gate   a review-only session judges the diff — editing tools are denied by the
//           session AND by the guard, and its verdict is the node's outcome;
//   @work   byte-identical to the path that ran before kinds existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver, buildWorkerPrompt } from "../src/loop.ts";
import { parsePlan } from "../src/plan.ts";
import { signalsFor } from "../src/dispatch.ts";
import { buildGraph, validateGraph } from "../src/graph.ts";
import { makeGuard, bashDenial } from "../src/guard.ts";
import { readSignals } from "../src/bus.ts";
import { toolCommand, isReviewOnly, haltsRun, isHuman, isTool, EDIT_TOOLS } from "../src/kinds.ts";
import { treeStateSignature } from "../src/git.ts";

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo with a brief whose PLAN.md is `plan`. Git is real (the loop reads HEAD). */
function briefRepo(plan: string): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-kind-"));
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
const stopReason = (leo: string): string =>
  String(events(leo).filter((e) => e.event === "stop").pop()!.reason);
const stateOf = (leo: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8"));

function stream(text: string) {
  return (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    yield { type: "result", result: text, total_cost_usd: 0 };
  })();
}

type ChannelMessage = { message?: { content?: Array<{ text?: string }> } };
async function firstPrompt(channel: unknown): Promise<string> {
  const it = (channel as AsyncIterable<ChannelMessage>)[Symbol.asyncIterator]();
  const first = await it.next();
  return first.value?.message?.content?.[0]?.text ?? "";
}

interface Session { prompt: string; options: Record<string, unknown> }
interface Fake {
  /** Item text substrings whose session reports `blocked` instead of `done`. */
  fail?: string[];
  /** Every worker/gate session the driver opened, in order. */
  sessions: Session[];
  /** What persona synthesis answers. `null` = an unusable answer, which is the
   *  best-effort path: the item must still run, under the default worker prompt. */
  personaJson?: string | null;
}

/** Install a fake harness that plays every role deterministically and RECORDS every
 *  session it is asked to open — which is how "no model turn is spent" is proven.
 *  `sideEffect` lets a test give a session a body: what a real worker's shell would do
 *  to the working tree, which is how a review-only node's no-edit promise gets tested
 *  against something that actually edits. */
function installFake(fail: string[] = [], sideEffect?: (s: Session) => void): Fake {
  const f: Fake = { fail, sessions: [] };
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      return (async function* () {
        const text = await firstPrompt(input.prompt);
        const session: Session = { prompt: text, options: (input.options ?? {}) as Record<string, unknown> };
        f.sessions.push(session);
        sideEffect?.(session);
        const item =
          (text.match(/Work on this plan item now:\n\n([\s\S]*?)\n\n/) ??
            text.match(/you may NOT edit anything:\n\n([\s\S]*?)\n\n/) ??
            text.match(/completely and verified\.\n\n([\s\S]*?)\n\n/) ?? [])[1]?.trim() ?? "";
        const failing = (f.fail ?? []).some((s) => item.includes(s));
        // A @human node is asked for its decision block; a persona that got the seat
        // states the call it made and how to undo it, outside the status block.
        const decision = /leopold-decision/.test(text)
          ? "```leopold-decision\nDECISION: approve the window for Sunday 02:00 UTC\n" +
            "WHY: the charter puts trust before reach and the window is the lowest-traffic hour\n" +
            "REVERSAL: revert window.txt and re-open the item in PLAN.md\n```\n"
          : "";
        const block = decision +
          "```leopold-status\nSTATUS: " + (failing ? "blocked" : "done") +
          "\nITEM: " + item + "\nSUMMARY: " + (failing ? "the diff is not acceptable" : "implemented and verified") +
          "\nNEXT: none\nEVIDENCE: build+test ok\n```";
        yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
        yield { type: "result", result: block, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    // Persona synthesis: one turn, no tools, answering with the role JSON.
    if (sys.includes("synthesize the ROLE")) {
      return stream(f.personaJson === null
        ? "I am afraid I cannot do that."
        : f.personaJson ?? '{"name":"Dana Okafor","role":"Release Engineer","expertise":["database migrations","maintenance windows"],"optimizesFor":["reversibility","the lowest-traffic hour"],"rationale":"the item is a cutover window call"}');
    }
    if (sys.includes("the conductor")) {
      return /STATUS:\s*blocked/i.test(prompt)
        ? stream('{"action":"answer","reply":"try another angle","classification":"reversible","charterBasis":"retry"}')
        : stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    }
    return stream('{"ok":true,"blocking":[],"summary":"clean"}');
  }) as never);
  return f;
}

async function drive(root: string, argv: string[]): Promise<void> {
  const log = console.log, warn = console.warn, write = process.stdout.write.bind(process.stdout);
  console.log = () => {}; console.warn = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await runDriver(root, argv); }
  finally { console.log = log; console.warn = warn; process.stdout.write = write; resetQuery(); }
}

const BASE = ["--no-review", "--no-hypotheses", "--no-literal-reset"];

// --- the pure rules ------------------------------------------------------------

test("the kind predicates say which path an item takes", () => {
  // NOTHING halts under the default posture — a @human node is executed by a role
  // Leopold synthesizes. `ask` is the opt-out, and it is the ONLY thing that halts.
  assert.equal(haltsRun("human"), false);
  assert.equal(haltsRun("human", "full"), false);
  assert.equal(haltsRun("human", "ask"), true);
  assert.equal(isHuman("human"), true);
  assert.equal(isTool("tool"), true);
  assert.deepEqual([isReviewOnly("gate"), isReviewOnly("verify")], [true, true]);
  for (const k of ["work", "human", "tool"] as const) assert.equal(isReviewOnly(k), false);
  for (const k of ["work", "gate", "verify", "tool", "feedback"] as const) {
    assert.equal(haltsRun(k), false);
    assert.equal(haltsRun(k, "ask"), false, `${k} never halts, whatever the posture`);
    assert.equal(isHuman(k), false);
  }
});

test("a @tool node's command is its text, or the backticked span inside it", () => {
  assert.equal(toolCommand("make test"), "make test");
  assert.equal(toolCommand("run the suite: `npm test -- --silent`"), "npm test -- --silent");
  assert.equal(toolCommand("   "), "");
  // Parsed end to end: the marker is stripped, the text that remains is the command.
  const [t] = parsePlan("- [ ] @tool `make test`\n");
  assert.equal(t.kind, "tool");
  assert.equal(toolCommand(t.text), "make test");
});

test("a @tool node declares `exit` without an @emit line; nothing else widens", () => {
  const [tool] = parsePlan("- [ ] @tool make test\n");
  assert.deepEqual(signalsFor(tool, { done: true, signals: { exit: "0" } }).emitted, { exit: "0" });
  // A failing tool still reports its status — the value comes from the executor, and
  // there is no declared fallback to invent one.
  assert.deepEqual(signalsFor(tool, { done: false, signals: { exit: "3" } }).emitted, { exit: "3" });
  assert.deepEqual(signalsFor(tool, { done: true }).emitted, {});
  // Work nodes are untouched by the implicit declaration.
  const [work] = parsePlan("- [ ] Build it\n");
  const r = signalsFor(work, { done: true, signals: { exit: "0" } });
  assert.deepEqual(r.emitted, {});
  assert.equal(r.refused[0].key, "exit");
});

test("the validator counts a @tool node's `exit` as emitted", () => {
  const ok = validateGraph(buildGraph(parsePlan(
    "- [ ] @tool make test\n- [ ] (after: 1) Ship it\n      @needs exit\n",
  )));
  assert.deepEqual(ok, [], "`@needs exit` downstream of a tool node is satisfiable");
  const bad = validateGraph(buildGraph(parsePlan(
    "- [ ] Build it\n- [ ] (after: 1) Ship it\n      @needs exit\n",
  )));
  assert.equal(bad[0].code, "unmet-need", "a work node emits no exit, so the need is unmet");
});

test("the guard denies every editing tool in a review-only session, and only there", async () => {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-guard-"));
  const blocked: string[] = [];
  const ro = makeGuard(leo, (t) => blocked.push(t), { readOnly: true });
  for (const tool of EDIT_TOOLS) {
    assert.equal((await ro(tool, { file_path: "x" })).behavior, "deny", tool);
  }
  assert.deepEqual(blocked, [...EDIT_TOOLS]);
  assert.equal((await ro("Read", { file_path: "x" })).behavior, "allow");
  const rw = makeGuard(leo, () => {});
  for (const tool of EDIT_TOOLS) {
    assert.equal((await rw(tool, { file_path: "x" })).behavior, "allow", `${tool} stays a work node's call`);
  }
});

// --- @human: the role is synthesized, the item is EXECUTED, the call is recorded ---
//
// The default posture (`autonomy: full`) is the whole point of the kind now: nobody is
// coming, so Leopold synthesizes the role the decision needs, runs the item under it,
// and writes what it decided — with a Reversal — to DECISIONS.md. `autonomy: ask` is the
// opt-out that restores the old halt, and it is tested right after, unchanged.

const HUMAN_PLAN = `# Plan

- [ ] Draft the migration
- [ ] (after: 1) @human ops Approve the maintenance window
- [ ] (after: 2) Run the migration
`;

/** A charter with a rule that BINDS, so the persona's constraints are provably the
 *  charter's and not the model's paraphrase. */
const BINDING_CHARTER = "# Charter\n\n## Never\n- Add a new runtime dependency.\n";

test("a @human node is EXECUTED under a synthesized persona, and the run continues", async () => {
  const { root, leo } = briefRepo(HUMAN_PLAN);
  fs.writeFileSync(path.join(leo, "CHARTER.md"), BINDING_CHARTER);
  const fake = installFake();
  await drive(root, BASE);

  // Every item ran, in order, and the plan finished. `awaiting_human` never happened.
  assert.deepEqual(started(leo), ["Draft the migration", "Approve the maintenance window", "Run the migration"]);
  assert.equal(stopReason(leo), "plan_complete");
  assert.equal(events(leo).some((e) => e.event === "awaiting_human"), false,
    "awaiting_human is unreachable in a default run");
  assert.doesNotMatch(fs.readFileSync(path.join(leo, "PLAN.md"), "utf8"), /- \[ \]/, "the human node is marked done");
  assert.equal(stateOf(leo).awaiting_item, undefined);

  // The role was synthesized and ASSUMED: the session's system prompt carries it, with
  // the charter's rule attached verbatim.
  const ev = events(leo).find((e) => e.event === "persona")!;
  assert.equal(ev.synthesized, true);
  assert.equal(ev.name, "Dana Okafor");
  assert.equal(ev.role, "Release Engineer");
  const session = fake.sessions.find((s) => s.prompt.includes("Approve the maintenance window"))!;
  const append = String((session.options.systemPrompt as { append?: unknown }).append ?? "");
  assert.match(append, /YOU ARE DANA OKAFOR — Release Engineer/);
  assert.match(append, /Never: Add a new runtime dependency\./, "the charter's rule binds the role, verbatim");
  assert.match(append, /You DECIDE; you do not ship/, "the git lock is stated to the persona, not moved");

  // The decision is on the trail: persona, fork, charter basis, decision, why, Reversal.
  const decisions = fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8");
  assert.match(decisions, /Persona:\s+Dana Okafor — Release Engineer/);
  assert.match(decisions, /Fork:\s+a @human node/);
  assert.match(decisions, /Decision:\s+approve the window for Sunday 02:00 UTC/);
  assert.match(decisions, /Reversal:\s+revert window\.txt and re-open the item in PLAN\.md/);

  // The lock did not move: a persona decided, and nothing was committed.
  assert.equal(sh(root, ["log", "--oneline"]).trim().split("\n").length, 1, "no commit was made");
});

test("a @human node whose persona cannot be synthesized still runs, under the default worker prompt", async () => {
  const { root, leo } = briefRepo(HUMAN_PLAN);
  const fake = installFake();
  fake.personaJson = null; // synthesis answers something unusable
  await drive(root, BASE);

  assert.equal(events(leo).find((e) => e.event === "persona")!.synthesized, false);
  assert.equal(stopReason(leo), "plan_complete", "the run does not die over a persona it could not build");
  assert.ok(fake.sessions.some((s) => s.prompt.includes("Approve the maintenance window")),
    "the item still ran");
  const decisions = fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8");
  assert.match(decisions, /Reversal:\s+\S/, "a decision without a Reversal line is never written");
});

test("`autonomy: ask` stops the run with awaiting_human, names the item, and stages everything", async () => {
  const { root, leo } = briefRepo(HUMAN_PLAN);
  // Uncommitted work sitting in the tree — the human must inherit it staged.
  fs.writeFileSync(path.join(root, "migration.sql"), "ALTER TABLE t ADD COLUMN c int;\n");
  const fake = installFake();
  await drive(root, [...BASE, "--autonomy", "ask"]);

  assert.deepEqual(started(leo), ["Draft the migration"], "nothing was dispatched for the human node");
  assert.equal(stopReason(leo), "awaiting_human");

  const ev = events(leo).find((e) => e.event === "awaiting_human")!;
  assert.equal(ev.item, 2, "the event names the item by index");
  assert.equal(ev.text, "Approve the maintenance window");
  assert.equal(ev.label, "ops", "the @human node's label survives");

  const st = stateOf(leo);
  assert.equal(st.stopped_reason, "awaiting_human");
  assert.equal(st.awaiting_item, 2);
  assert.equal(st.awaiting_text, "Approve the maintenance window");

  // Everything is STAGED and nothing committed — the run never takes the seat.
  assert.match(sh(root, ["diff", "--cached", "--name-only"]), /migration\.sql/);
  assert.equal(sh(root, ["log", "--oneline"]).trim().split("\n").length, 1, "no commit was made");

  // The item stays open, and no session was ever opened for it.
  assert.match(fs.readFileSync(path.join(leo, "PLAN.md"), "utf8"), /- \[ \] \(after: 1\) @human ops Approve/);
  assert.ok(!fake.sessions.some((s) => s.prompt.includes("Approve the maintenance window")),
    "not one model turn was spent on the @human node");
});

test("`autonomy: ask` in GUARDRAILS.md is honored with no flag at all", async () => {
  const { root, leo } = briefRepo(HUMAN_PLAN);
  fs.appendFileSync(path.join(leo, "GUARDRAILS.md"), "- autonomy: ask\n");
  installFake();
  await drive(root, BASE);
  assert.equal(stopReason(leo), "awaiting_human", "the brief sets the posture; no flag required");
});

test("the --parallel scheduler executes a @human node too, and stops at one under `ask`", async () => {
  const executed = briefRepo(HUMAN_PLAN);
  installFake();
  await drive(executed.root, [...BASE, "--parallel", "2"]);
  assert.equal(stopReason(executed.leo), "plan_complete");
  assert.ok(started(executed.leo).includes("Approve the maintenance window"), "the human node ran");
  assert.ok(started(executed.leo).includes("Run the migration"), "the item behind it ran too");

  const asked = briefRepo(HUMAN_PLAN);
  installFake();
  await drive(asked.root, [...BASE, "--parallel", "2", "--autonomy", "ask"]);
  assert.equal(stopReason(asked.leo), "awaiting_human");
  assert.equal(events(asked.leo).find((e) => e.event === "awaiting_human")!.item, 2);
  assert.ok(!started(asked.leo).includes("Run the migration"), "the item behind the human node never ran");
});

// --- @tool: a command, no model turn --------------------------------------------

test("a @tool node runs its command, turns the exit status into a signal, and spends no model turn", async () => {
  const { root, leo } = briefRepo(
    "# Plan\n\n- [ ] @tool `printf ran > tool.out`\n- [ ] (after: 1) Ship it\n",
  );
  const fake = installFake();
  await drive(root, BASE);

  assert.equal(fs.readFileSync(path.join(root, "tool.out"), "utf8"), "ran", "the declared command actually ran");
  const run = events(leo).find((e) => e.event === "tool_run")!;
  assert.equal(run.command, "printf ran > tool.out");
  assert.equal(run.exit, 0);
  assert.deepEqual(readSignals(leo), { exit: "0" }, "the exit status is on the state channel");
  assert.equal(fake.sessions.length, 1, "only the work item opened a session — the tool node spent none");
  assert.equal(stopReason(leo), "plan_complete");
  assert.doesNotMatch(fs.readFileSync(path.join(leo, "PLAN.md"), "utf8"), /- \[ \]/);
});

test("an UNBACKTICKED @tool node runs its whole command, first word included", async () => {
  // The bare-label shorthand used to eat `printf` here, running `ran > tool.out`.
  const { root, leo } = briefRepo(
    "# Plan\n\n- [ ] @tool printf ran > tool.out\n- [ ] (after: 1) Ship it\n",
  );
  installFake();
  await drive(root, BASE);
  assert.equal(events(leo).find((e) => e.event === "tool_run")!.command, "printf ran > tool.out");
  assert.equal(fs.readFileSync(path.join(root, "tool.out"), "utf8"), "ran");
});

test("the git lock sees an unbackticked @tool git command: `git push --force` is refused", async () => {
  const { root, leo } = briefRepo("# Plan\n\n- [ ] @tool git push --force origin main\n      @on fail -> 2\n- [ ] Report it\n");
  installFake();
  await drive(root, BASE);
  const block = events(leo).find((e) => e.event === "guard_block")!;
  assert.equal(block.tool, "tool_node");
  assert.match(String(block.reason), /force-push/i);
  assert.equal(events(leo).filter((e) => e.event === "tool_run").length, 0, "the command never ran");
});

test("a failing @tool node routes on its exit status instead of retrying", async () => {
  const { root, leo } = briefRepo(
    "# Plan\n\n- [ ] @tool `exit 3`\n      @on exit=3 -> 3\n- [ ] (after: 1) Ship it\n- [ ] Roll it back\n",
  );
  installFake();
  await drive(root, BASE);

  assert.equal(events(leo).find((e) => e.event === "tool_run")!.exit, 3);
  assert.deepEqual(readSignals(leo), { exit: "3" });
  assert.deepEqual(started(leo), ["`exit 3`", "Roll it back"], "the run took the exit=3 edge, not the static order");
  const route = events(leo).find((e) => e.event === "route")!;
  assert.equal(route.from, 1);
  assert.equal(route.to, 3);
  assert.match(String(route.why), /signal exit="3" matches @on exit=3/);
});

test("the git lock holds inside a @tool node: `git commit` is refused, not run", async () => {
  const { root, leo } = briefRepo("# Plan\n\n- [ ] @tool `git commit -am sneaky`\n      @on fail -> 2\n- [ ] Report it\n");
  fs.writeFileSync(path.join(root, "seed.txt"), "changed\n");
  installFake();
  await drive(root, BASE);

  const block = events(leo).find((e) => e.event === "guard_block")!;
  assert.equal(block.tool, "tool_node");
  assert.match(String(block.reason), /git commit is locked/);
  assert.equal(events(leo).filter((e) => e.event === "tool_run").length, 0, "the command never ran");
  assert.equal(sh(root, ["log", "--oneline"]).trim().split("\n").length, 1, "no commit exists");
  assert.equal(bashDenial(leo, "git push --force origin main"), "Leopold guard: force-push is forbidden in autonomous mode.");
});

test("a @tool node with nothing to run fails by name instead of running the empty string", async () => {
  const { root, leo } = briefRepo("# Plan\n\n- [ ] @tool\n- [ ] Something else\n");
  installFake();
  await drive(root, BASE);
  const refused = events(leo).find((e) => e.event === "tool_refused")!;
  assert.match(String(refused.reason), /declares no command/);
  assert.equal(events(leo).filter((e) => e.event === "tool_run").length, 0);
});

// --- @gate / @verify: review-only ------------------------------------------------

const GATE_PLAN = `# Plan

- [ ] Change the auth flow
- [ ] (after: 1) @gate security Judge the auth diff
- [ ] (after: 2) Announce it
`;

test("a @gate node reviews the diff in a session that cannot edit — verdict pass", async () => {
  const { root, leo } = briefRepo(GATE_PLAN);
  const fake = installFake();
  await drive(root, BASE);

  assert.deepEqual(started(leo), ["Change the auth flow", "Judge the auth diff", "Announce it"]);
  const gate = events(leo).find((e) => e.event === "gate")!;
  assert.equal(gate.kind, "gate");
  assert.equal(gate.ok, true);

  const session = fake.sessions.find((s) => s.prompt.includes("Judge the auth diff"))!;
  assert.ok(session, "the gate opened its own session");
  assert.match(session.prompt, /you may NOT edit anything/);
  assert.doesNotMatch(session.prompt, /Make the edits in the repo|Do it completely and verify it/);
  assert.deepEqual(session.options.disallowedTools, [...EDIT_TOOLS], "editing tools are denied on the session");
  const sysAppend = (session.options.systemPrompt as { append: string }).append;
  assert.match(sysAppend, /GATE node/);
  assert.match(sysAppend, /labelled "security"/, "the gate's label reaches the node");

  // The guard the driver handed that session denies edits for real.
  const canUseTool = session.options.canUseTool as (t: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
  assert.equal((await canUseTool("Write", { file_path: "x" })).behavior, "deny");
  assert.equal((await canUseTool("Edit", { file_path: "x" })).behavior, "deny");
  assert.equal((await canUseTool("Read", { file_path: "x" })).behavior, "allow");

  // And nothing on disk moved because of it: only the seed commit, no gate artifacts.
  assert.equal(sh(root, ["log", "--oneline"]).trim().split("\n").length, 1);
  assert.equal(events(leo).filter((e) => e.event === "review_node_edited").length, 0);
});

test("a @gate node that writes to an ALREADY-DIRTY file is caught, not passed off as clean", async () => {
  // The hole this closes: `git status --porcelain` is byte-identical before and after a
  // write to a file that is already modified — exactly the files a gate reviews. A gate
  // whose shell ran `sed -i` or `>>` against the diff it was judging moved the tree while
  // the names-only signature never blinked, and the run reported a clean gate.
  const { root, leo } = briefRepo(GATE_PLAN);
  const seed = path.join(root, "seed.txt");
  installFake([], (s) => {
    const cwd = String(s.options.cwd ?? root);
    // The work node dirties a TRACKED file — no new path, no staged-ness change.
    if (s.prompt.includes("Change the auth flow")) fs.appendFileSync(path.join(cwd, "seed.txt"), "auth work\n");
    // The gate then appends to that same already-dirty file: the exact blind spot.
    if (s.prompt.includes("Judge the auth diff")) fs.appendFileSync(path.join(cwd, "seed.txt"), "gate snuck this in\n");
  });

  // Precondition for the test to mean anything: the sabotage really is invisible to the
  // old, names-only signature — so a passing assertion below can only come from content.
  await drive(root, BASE);
  assert.match(fs.readFileSync(seed, "utf8"), /gate snuck this in/, "the gate did edit the tree");

  const edited = events(leo).filter((e) => e.event === "review_node_edited");
  assert.equal(edited.length, 1, "the gate's edit to an already-dirty file was detected");
  assert.equal(edited[0].kind, "gate");
  assert.equal(edited[0].item, "Judge the auth diff");
});

test("taking a review-only node's tree signature stages nothing in the repo it measures", () => {
  const { root } = briefRepo("# Plan\n\n- [ ] x\n");
  fs.appendFileSync(path.join(root, "seed.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "new.txt"), "untracked\n");
  const before = sh(root, ["status", "--porcelain"]);
  const sig = treeStateSignature(root);
  assert.equal(sh(root, ["status", "--porcelain"]), before, "the index is exactly as it was");
  assert.match(sig, /dirty/, "the signature carries content, not just names");
  // And it is stable: same tree in, same signature out.
  assert.equal(treeStateSignature(root), sig);
});

test("a @gate node that blocks is a failed node: the plan's route decides what happens", async () => {
  const { root, leo } = briefRepo(
    "# Plan\n\n- [ ] Change the auth flow\n- [ ] (after: 1) @gate Judge the auth diff\n      @on fail -> 4\n" +
    "- [ ] (after: 2) Announce it\n- [ ] Revert the auth flow\n",
  );
  installFake(["Judge the auth diff"]);
  await drive(root, BASE);

  assert.deepEqual(started(leo), ["Change the auth flow", "Judge the auth diff", "Revert the auth flow"]);
  assert.equal(events(leo).find((e) => e.event === "gate")!.ok, false);
  assert.equal(events(leo).find((e) => e.event === "route")!.to, 4);
  // A blocked gate is NOT conducted into another attempt: one verdict, one outcome.
  assert.equal(
    events(leo).filter((e) => e.event === "worker_turn" && e.item === "Judge the auth diff").length, 1,
  );
});

test("a @verify node is a review-only node aimed at proof, not judgement", async () => {
  const { root, leo } = briefRepo("# Plan\n\n- [ ] Build it\n- [ ] (after: 1) @verify Prove the suite passes\n");
  const fake = installFake();
  await drive(root, BASE);
  const session = fake.sessions.find((s) => s.prompt.includes("Prove the suite passes"))!;
  assert.match(session.prompt, /^Verify this plan item now/m);
  const sysAppend = (session.options.systemPrompt as { append: string }).append;
  assert.match(sysAppend, /VERIFY node/);
  assert.match(sysAppend, /READ-ONLY/);
  assert.deepEqual(session.options.disallowedTools, [...EDIT_TOOLS]);
  assert.equal(events(leo).find((e) => e.event === "gate")!.kind, "verify");
  assert.equal(stopReason(leo), "plan_complete");
});

test("under --parallel a review-only node judges the MAIN tree, not an empty fork of HEAD", async () => {
  const { root } = briefRepo(GATE_PLAN);
  const fake = installFake();
  await drive(root, [...BASE, "--parallel", "2"]);

  const work = fake.sessions.find((s) => s.prompt.includes("Change the auth flow"))!;
  const gate = fake.sessions.find((s) => s.prompt.includes("Judge the auth diff"))!;
  assert.notEqual(work.options.cwd, root, "a work node is isolated in its own worktree");
  assert.equal(gate.options.cwd, root,
    "a gate forked off HEAD would review an empty diff and pass work it never saw");
});

test("the review gate never runs on a review-only node (no reviewing the reviewer)", async () => {
  const { root, leo } = briefRepo("# Plan\n\n- [ ] Build it\n- [ ] (after: 1) @gate Judge it\n");
  installFake();
  // Review ON this time: the work item is reviewed, the gate node is not.
  await drive(root, ["--no-hypotheses", "--no-literal-reset"]);
  const reviews = events(leo).filter((e) => e.event === "review").map((e) => String(e.item));
  assert.deepEqual(reviews, ["Build it"]);
});

// --- backward compatibility ------------------------------------------------------

test("a plan of only work items behaves exactly as before kinds existed", async () => {
  const plan = "# Plan\n\n- [ ] Add the API layer\n- [ ] (after: 1) Wire the UI to the API\n- [ ] Independent docs pass\n";
  const { root, leo } = briefRepo(plan);
  const fake = installFake();
  await drive(root, BASE);

  assert.deepEqual(started(leo), ["Add the API layer", "Wire the UI to the API", "Independent docs pass"]);
  assert.equal(stopReason(leo), "plan_complete");
  // Not one kind-specific event, not one kind-specific field, and the worker prompt is
  // still the one buildWorkerPrompt has always produced for a plain item.
  const kinded = ["tool_run", "tool_refused", "gate", "awaiting_human", "review_node_edited"];
  assert.deepEqual(events(leo).filter((e) => kinded.includes(String(e.event))), []);
  for (const e of events(leo).filter((e) => e.event === "item_start")) {
    assert.ok(!("kind" in e), "item_start carries no kind field for a work plan");
  }
  for (const s of fake.sessions) {
    assert.equal(s.options.disallowedTools, undefined, "a work session denies no tool");
    assert.equal(s.prompt, buildWorkerPrompt(s.prompt.match(/item now:\n\n([\s\S]*?)\n\n/)![1], []));
  }
  const st = stateOf(leo);
  assert.ok(!("awaiting_item" in st) && !("awaiting_text" in st));
});
