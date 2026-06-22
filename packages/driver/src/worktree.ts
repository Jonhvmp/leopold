// Git worktree isolation for a run (Path A / SDK driver). The orchestrator runs
// git directly here — NOT through the worker's Bash tool — so the worker's git
// lock is unaffected (the lock constrains the worker, not the orchestrator).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "./log.js";

export interface Worktree {
  path: string;
  branch: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** A worktree is "dirty" if it has staged, unstaged, or untracked changes.
 *  Git is locked, so a run stages (git add) but never commits — dirty means
 *  "there is work here the user should review", which we never destroy. */
export function isDirty(worktreePath: string): boolean {
  try {
    return git(worktreePath, ["status", "--porcelain"]).length > 0;
  } catch {
    return false;
  }
}

/** Provision an isolated worktree on a throwaway branch `leopold/run-<id>`,
 *  as a sibling of the repo (matches the manual flow in docs/guardrails.md).
 *  Returns null if the project is not a git repo — caller falls back to root. */
export function createWorktree(repoRoot: string, leoDir: string, runId: string): Worktree | null {
  if (!isGitRepo(repoRoot)) {
    logEvent(leoDir, { event: "worktree_skipped", reason: "not_a_git_repo" });
    return null;
  }
  const branch = `leopold/run-${runId}`;
  // sibling of the repo, one level (matches `../<proj>-leopold-2` in the docs)
  const dir = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-leopold-${runId}`);
  try {
    git(repoRoot, ["worktree", "add", "-b", branch, dir, "HEAD"]);
    logEvent(leoDir, { event: "worktree_created", path: dir, branch });
    return { path: dir, branch };
  } catch (e) {
    logEvent(leoDir, { event: "worktree_create_failed", error: String((e as Error).message ?? e) });
    return null;
  }
}

/** Remove a run's worktree — but ONLY if it's clean. A worktree with work is
 *  preserved (and logged) for the user to review/merge, since git is locked and
 *  the run never committed. A clean worktree (or one already gone) is pruned. */
export function cleanupWorktree(repoRoot: string, wt: Worktree, leoDir: string): void {
  if (!fs.existsSync(wt.path)) {
    try { git(repoRoot, ["worktree", "prune"]); } catch { /* ignore */ }
    try { git(repoRoot, ["branch", "-D", wt.branch]); } catch { /* ignore */ }
    return;
  }
  if (isDirty(wt.path)) {
    logEvent(leoDir, {
      event: "worktree_preserved",
      path: wt.path,
      branch: wt.branch,
      reason: "uncommitted_changes",
    });
    return;
  }
  try {
    git(repoRoot, ["worktree", "remove", "--force", wt.path]);
    git(repoRoot, ["branch", "-D", wt.branch]);
    logEvent(leoDir, { event: "worktree_removed", path: wt.path, branch: wt.branch });
  } catch (e) {
    logEvent(leoDir, { event: "worktree_remove_failed", path: wt.path, error: String((e as Error).message ?? e) });
  }
}
