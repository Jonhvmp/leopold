// Thin git plumbing for the parallel scheduler. These run from the DRIVER (not a
// worker), so the canUseTool/hook guard does not apply — and they never commit or
// push: the scheduler isolates each item in a worktree, then replays the item's
// diff onto the main tree as a STAGED patch. Nothing is committed; the run still
// leaves everything staged for the human, exactly like the serial loop.

import { spawnSync } from "node:child_process";

export interface GitResult { ok: boolean; out: string; err: string; }

export function git(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync("git", ["--no-pager", ...args], { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Current commit the work tree is on (the base every item's worktree forks from). */
export function headSha(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).out.trim();
}

/** The full uncommitted diff in a worktree against a base ref (default HEAD). */
export function diffAgainst(cwd: string, base = "HEAD"): string {
  return git(cwd, ["diff", "--no-color", base]).out;
}

/** Apply a patch onto the main tree and stage it (`git apply --index --3way`).
 *  Returns false on conflict/rejection so the caller can preserve the worktree
 *  for manual integration instead of losing the work. Empty patch = no-op ok. */
export function applyStaged(cwd: string, patch: string): GitResult {
  if (!patch.trim()) return { ok: true, out: "", err: "" };
  // --3way lets git fall back to a real merge when context drifted; --index stages.
  return git(cwd, ["apply", "--index", "--3way", "--whitespace=nowarn"], patch);
}

/** A complete snapshot of the working tree vs HEAD as a single patch — staged,
 *  unstaged, AND untracked (non-ignored) changes, captured as additions. This is
 *  the "state before an item's first attempt" that R2 restores to on a retry.
 *  Orchestrator-only: it stages with `git add -A` but never commits or pushes. */
export function snapshotTree(cwd: string): string {
  git(cwd, ["add", "-A"]); // stage everything incl. untracked so the diff captures it
  return git(cwd, ["diff", "--cached", "--binary", "HEAD"]).out;
}

/** Restore the working tree to a `snapshotTree` patch: discard everything back to
 *  HEAD, then re-apply the snapshot (staged). FAIL-SAFE — the current state is
 *  rescued first, so a corrupt/unapplyable patch leaves the tree exactly as it was
 *  and returns not-ok, never losing work. Gated by the caller to worktree-isolated
 *  runs; the user's live repo is never handed to this. Empty patch = reset to HEAD. */
export function restoreTree(cwd: string, patch: string): GitResult {
  const rescue = snapshotTree(cwd); // full current state, same capture (incl. untracked)
  const wipe = (): void => {
    git(cwd, ["reset", "--hard", "HEAD"]);
    git(cwd, ["clean", "-fd"]); // remove untracked; -d not -x, so .gitignored stays
  };
  wipe();
  if (!patch.trim()) return { ok: true, out: "", err: "" }; // snapshot was a clean HEAD
  const r = git(cwd, ["apply", "--index", "--binary", "--whitespace=nowarn"], patch);
  if (!r.ok) {
    // Re-apply failed (corrupt/unapplyable) — put the rescued state back untouched.
    wipe();
    if (rescue.trim()) git(cwd, ["apply", "--index", "--binary", "--whitespace=nowarn"], rescue);
    return { ok: false, out: r.out, err: r.err };
  }
  return { ok: true, out: r.out, err: r.err };
}
