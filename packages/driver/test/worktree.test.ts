// Worktree isolation against a real temp git repo: provisioning, the
// non-destructive cleanup (preserve-if-dirty), and the non-git fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isGitRepo, isDirty, createWorktree, cleanupWorktree } from "../src/worktree.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function tmpRepo(): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-wt-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["commit", "--allow-empty", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  return { root, leo };
}

test("isGitRepo: true in a repo, false in a plain dir", () => {
  const { root } = tmpRepo();
  assert.equal(isGitRepo(root), true);
  assert.equal(isGitRepo(fs.mkdtempSync(path.join(os.tmpdir(), "leo-plain-"))), false);
});

test("createWorktree returns null when not a git repo (caller falls back to root)", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "leo-plain-"));
  const leo = path.join(plain, ".leopold");
  fs.mkdirSync(leo);
  assert.equal(createWorktree(plain, leo, "abc"), null);
});

test("createWorktree provisions an isolated worktree on a leopold/run-* branch", () => {
  const { root, leo } = tmpRepo();
  const wt = createWorktree(root, leo, "abc123");
  assert.ok(wt, "worktree should be created");
  assert.equal(wt!.branch, "leopold/run-abc123");
  assert.ok(fs.existsSync(wt!.path));
  assert.equal(isDirty(wt!.path), false);
  cleanupWorktree(root, wt!, leo); // tidy up
});

test("cleanupWorktree removes a clean worktree but preserves a dirty one", () => {
  const { root, leo } = tmpRepo();

  const clean = createWorktree(root, leo, "clean1")!;
  cleanupWorktree(root, clean, leo);
  assert.equal(fs.existsSync(clean.path), false, "clean worktree must be removed");

  const dirty = createWorktree(root, leo, "dirty1")!;
  fs.writeFileSync(path.join(dirty.path, "new.txt"), "uncommitted work");
  assert.equal(isDirty(dirty.path), true);
  cleanupWorktree(root, dirty, leo);
  assert.equal(fs.existsSync(dirty.path), true, "dirty worktree must be preserved");
  assert.match(fs.readFileSync(path.join(leo, "events.jsonl"), "utf8"), /worktree_preserved/);
});
