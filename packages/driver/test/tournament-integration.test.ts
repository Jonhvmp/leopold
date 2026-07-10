// Integration test for the best-of-k ORCHESTRATION against a real temp git repo.
// The pure winner-pick is covered in tournament.test.ts; this drives the whole
// runTournament flow — K real worktrees off HEAD, basePatch seeding, diff capture,
// a (injected) judge, winner selection, winner-diff apply, and worktree scrap — so
// the machinery is proven end-to-end without any SDK call.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runTournament, type Judge, type RunAttempt } from "../src/tournament.ts";
import { applyStaged, git, snapshotTree, restoreTree } from "../src/git.ts";
import type { Brief, DriverConfig } from "../src/types.ts";

function sh(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function tmpRepo(): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-tourney-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@example.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  // Ignore .leopold exactly as the real repo does, so restoreTree's `git clean -fd`
  // (which drops untracked, non-ignored files) never touches the run's own state.
  fs.writeFileSync(path.join(root, ".gitignore"), ".leopold/\n");
  sh(root, ["add", "-A"]);
  sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "events.jsonl"), "");
  return { root, leo };
}
const briefOf = (root: string, leo: string): Brief =>
  ({ mission: "", charter: "", guardrails: "", planPath: "", root, leoDir: leo } as Brief);
const CFG = {} as unknown as DriverConfig; // unused: the judge is injected

test("runTournament: K real worktrees, judge picks the winner, winner diff applies, worktrees scrapped", async () => {
  const { root, leo } = tmpRepo();
  const runAttempt: RunAttempt = async (cwd, index) => {
    fs.writeFileSync(path.join(cwd, "out.txt"), `attempt ${index}\n`);
    return { ok: true, detail: `did ${index}` };
  };
  const judge: Judge = async (_cwd, index) => ({ score: index === 1 ? 9 : 3, why: `s${index}` });

  const r = await runTournament(CFG, briefOf(root, leo), "build out.txt", [], 3, root, runAttempt, "", judge);

  assert.equal(r.attempts, 3);
  assert.equal(r.winner, 1, "highest-scored attempt wins");
  assert.deepEqual(r.scores, [3, 9, 3]);
  assert.ok(r.patch && r.patch.includes("attempt 1"), "winner's diff is returned");
  // the winner's diff cleanly applies onto the base tree (what the loop then stages)
  assert.equal(applyStaged(root, r.patch!).ok, true);
  assert.equal(fs.readFileSync(path.join(root, "out.txt"), "utf8"), "attempt 1\n");
  // every throwaway worktree was force-removed — only the main worktree remains
  const worktrees = git(root, ["worktree", "list"]).out.trim().split("\n").filter(Boolean);
  assert.equal(worktrees.length, 1, `only the main worktree should remain, got:\n${worktrees.join("\n")}`);
});

test("runTournament falls back (patch=null, winner=-1) when no attempt succeeds", async () => {
  const { root, leo } = tmpRepo();
  const runAttempt: RunAttempt = async () => ({ ok: false, detail: "boom" });
  const judge: Judge = async () => ({ score: 10, why: "irrelevant — attempt failed" });
  const r = await runTournament(CFG, briefOf(root, leo), "x", [], 2, root, runAttempt, "", judge);
  assert.equal(r.winner, -1);
  assert.equal(r.patch, null, "caller then falls back to a single attempt");
});

test("basePatch seeds every attempt with prior uncommitted work", async () => {
  const { root, leo } = tmpRepo();
  // "prior items' work" sitting in the tree, then captured and wiped to prove seeding.
  fs.writeFileSync(path.join(root, "prior.txt"), "prior work\n");
  const basePatch = snapshotTree(root);
  restoreTree(root, ""); // clean back to HEAD; only the seed can bring prior.txt back
  assert.equal(fs.existsSync(path.join(root, "prior.txt")), false);

  const sawPrior: boolean[] = [];
  const runAttempt: RunAttempt = async (cwd, index) => {
    sawPrior[index] = fs.existsSync(path.join(cwd, "prior.txt"));
    fs.writeFileSync(path.join(cwd, `a${index}.txt`), "x\n");
    return { ok: true, detail: "" };
  };
  const judge: Judge = async (_cwd, index) => ({ score: index, why: "" }); // index 1 wins

  const r = await runTournament(CFG, briefOf(root, leo), "x", [], 2, root, runAttempt, basePatch, judge);
  assert.ok(sawPrior[0] && sawPrior[1], "each attempt started from the seeded prior work");
  assert.ok(r.patch!.includes("prior work") && r.patch!.includes("a1.txt"), "winner carries prior work + its own change");
});
