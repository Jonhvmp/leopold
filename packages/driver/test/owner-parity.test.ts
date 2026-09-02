// A run's owner record has TWO writers -- /leopold-run Step 1 (bash, in-session) and
// initState in src/config.ts (the driver) -- and one reader contract: the Stop hook,
// scripts/leopold-owner.sh, doctor and the dashboard all read `owner.session_id`,
// `owner.engine`, `owner.pid`, `owner.transcript_path`. Two writers drift. This test
// RUNS the skill's own activation block (extracted from SKILL.md, never a copy of it)
// against a temp project with a fake harness env, runs the driver's initState against
// another, and fails the build the moment the two records stop having the same keys --
// the keys RunOwner declares (OWNER_KEYS).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initState } from "../src/config.ts";
import { OWNER_KEYS, type Brief } from "../src/types.ts";

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

test("the skill's activation and the driver's initState write the same owner keys", { skip: MISSING || undefined }, () => {
  // --- the skill, as a Claude Code session ---
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leo-parity-skill-"));
  const r = spawnSync("bash", ["-c", step1Block()], {
    cwd: skillRoot,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "sess-parity-1", CODEX_THREAD_ID: "", CLAUDE_PID: "4321", LEOPOLD_TAKEOVER: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `Step 1 block failed: ${r.stderr}`);
  const skillState = JSON.parse(fs.readFileSync(path.join(skillRoot, ".leopold", "state.json"), "utf8")) as { owner: Record<string, unknown>; session_id: string };
  // --- the driver ---
  const drvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leo-parity-driver-"));
  const leoDir = path.join(drvRoot, ".leopold");
  fs.mkdirSync(leoDir);
  const brief = { mission: "", charter: "", guardrails: "", planPath: path.join(leoDir, "PLAN.md"), root: drvRoot, leoDir } as Brief;
  const drv = initState(brief, { harness: "claude" });
  const drvOnDisk = JSON.parse(fs.readFileSync(path.join(leoDir, "state.json"), "utf8")) as { owner: Record<string, unknown> };

  const want = [...OWNER_KEYS].sort();
  assert.deepEqual(Object.keys(skillState.owner).sort(), want, "the skill writes exactly RunOwner's keys");
  assert.deepEqual(Object.keys(drvOnDisk.owner).sort(), want, "the driver writes exactly RunOwner's keys");
  assert.deepEqual(Object.keys(drv.owner ?? {}).sort(), want);

  // The values that make the two engines distinguishable to the hook.
  assert.equal(skillState.owner.engine, "skill");
  assert.equal(skillState.owner.session_id, "sess-parity-1", "the skill binds the run to the session that activated it");
  assert.equal(skillState.owner.harness, "claude");
  assert.equal(String(skillState.owner.pid), "4321", "the harness pid is a liveness signal");
  assert.equal(skillState.session_id, "sess-parity-1", "the legacy top-level field stays in step (older hooks read it)");
  assert.equal(drvOnDisk.owner.engine, "driver");
  assert.equal(drvOnDisk.owner.session_id, "", "no session ever matches a driver run");
});

test("on Codex the skill binds the run to the thread id", { skip: MISSING || undefined }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-parity-codex-"));
  const r = spawnSync("bash", ["-c", step1Block()], {
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "thread-parity-9", CLAUDE_PID: "", LEOPOLD_TAKEOVER: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `Step 1 block failed: ${r.stderr}`);
  const st = JSON.parse(fs.readFileSync(path.join(root, ".leopold", "state.json"), "utf8")) as { owner: Record<string, unknown> };
  assert.equal(st.owner.session_id, "thread-parity-9");
  assert.equal(st.owner.harness, "codex");
  assert.equal(st.owner.engine, "skill");
});
