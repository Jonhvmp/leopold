// An API error is not a spent turn, and the reseed must not treat it like a fresh run.
//
// hooks/stop-failure.sh is the only witness of a turn that died on the API (no `Stop`
// fires for a failed turn): it stops the run with `stopped_reason: api_error` and
// touches no budget. `leopold watch` then relaunches such a run automatically, up to
// five times on a doubling backoff -- so if /leopold-run Step 1 reseeded `iteration`
// and `windows` on that stop, a rate-limited run would get a FRESH purse on every
// retry: max_iterations, max_windows and the cross-window livelock gate would all be
// escaped, five times over, with nobody watching at 2am.
//
// This test RUNS the skill's own activation block (extracted from SKILL.md, never a
// copy of it -- the same technique as owner-parity.test.ts) against temp projects, and
// pins the CARRY condition in both directions: `api_error` and `context_budget` carry
// the run's budgets; every other stop still starts a fresh purse.
//
// MUTATION-VERIFIED: drop `api_error` from the `case` in SKILL.md Step 1 and the first
// two tests fail (iteration 0 instead of 17, windows absent instead of 3); drop
// `context_budget` and the roll regression fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SKILL = path.join(REPO, "skills", "leopold-run", "SKILL.md");

/** The bash block under "## Step 1" -- the activation the skill actually runs. */
function step1Block(): string {
  const text = fs.readFileSync(SKILL, "utf8");
  const start = text.indexOf("## Step 1");
  assert.ok(start >= 0, "SKILL.md has a Step 1");
  const fenceOpen = text.indexOf("```bash", start);
  const fenceClose = text.indexOf("\n```", fenceOpen + 7);
  assert.ok(fenceOpen > 0 && fenceClose > fenceOpen, "Step 1 has a bash block");
  return text.slice(fenceOpen + "```bash".length, fenceClose);
}

function toolsPresent(): string | false {
  const r = spawnSync("bash", ["-c", "command -v jq >/dev/null"], { stdio: "ignore" });
  if (r.error) return "bash is not available";
  if (r.status !== 0) return "jq is not installed (the skill's activation block requires it)";
  return false;
}
const MISSING = toolsPresent();

type State = Record<string, unknown>;

/** Seed a temp project with `prior` as its state, run Step 1, return the new state. */
function reseed(prior: State): State {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-api-carry-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(leoDir);
  fs.writeFileSync(path.join(leoDir, "state.json"), JSON.stringify(prior));
  fs.writeFileSync(path.join(leoDir, "PLAN.md"), "# Plan\n\n- [x] shipped\n- [ ] open item\n");
  const r = spawnSync("bash", ["-c", step1Block()], {
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "sess-api-1", CODEX_THREAD_ID: "", CLAUDE_PID: "", LEOPOLD_TAKEOVER: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `Step 1 block failed: ${r.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(leoDir, "state.json"), "utf8")) as State;
}

const apiErrorStop: State = {
  active: false,
  stopped_reason: "api_error",
  api_error: { type: "rate_limit", at: "2026-09-04T05:12:44Z", retryable: true, hint: "wait" },
  iteration: 17,
  windows: 3,
  window_plan_vector: "xxo",
  window_zero_streak: 1,
  window_progress: [2, 1, 0],
  failure_rescue_used: true,
};

test("an api_error stop reseeds with the RUN's budgets carried, never a fresh purse", { skip: MISSING || undefined }, () => {
  const st = reseed(apiErrorStop);
  assert.equal(st.active, true, "the reseed reactivates the run");
  assert.equal(st.iteration, 17, "iteration is carried: max_iterations is the RUN's ceiling");
  assert.equal(st.windows, 3, "windows is carried");
  assert.equal(st.window_plan_vector, "xxo", "the progress gate's snapshot is carried");
  assert.equal(st.window_zero_streak, 1, "the livelock gate's memory is carried");
  assert.deepEqual(st.window_progress, [2, 1, 0], "the per-window progress record is carried");
  assert.equal(st.failure_rescue_used, true, "spent one-shots stay spent");
});

test("the api_error reseed carries `windows` unchanged -- an API error is not a roll", { skip: MISSING || undefined }, () => {
  const st = reseed(apiErrorStop);
  assert.equal(st.windows, 3, "no window was consumed by a turn the API refused");
  assert.notEqual(st.windows, 4, "the reseed must never charge a window for an API error");
});

test("a context_budget roll still carries exactly what it always did", { skip: MISSING || undefined }, () => {
  const st = reseed({
    active: false,
    stopped_reason: "context_budget",
    iteration: 7,
    windows: 2,
    window_plan_vector: "xo",
    window_zero_streak: 1,
    window_progress: [1, 0],
    failure_rescue_used: true,
  });
  assert.equal(st.iteration, 7);
  assert.equal(st.windows, 2);
  assert.equal(st.window_plan_vector, "xo");
  assert.equal(st.window_zero_streak, 1);
  assert.deepEqual(st.window_progress, [1, 0]);
  assert.equal(st.failure_rescue_used, true);
});

test("every other stop still starts a fresh purse", { skip: MISSING || undefined }, () => {
  for (const reason of ["iteration_budget", "kill_switch", "no_progress", "plan_complete"]) {
    const st = reseed({ active: false, stopped_reason: reason, iteration: 50, windows: 4, failure_rescue_used: true });
    assert.equal(st.iteration, 0, `${reason}: iteration resets as it always did`);
    assert.equal("windows" in st, false, `${reason}: no window field rides along`);
    assert.equal(st.failure_rescue_used, true, `${reason}: the spent one-shot still carries`);
  }
});
