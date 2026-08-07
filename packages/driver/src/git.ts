// Thin git plumbing for the parallel scheduler. These run from the DRIVER (not a
// worker), so the canUseTool/hook guard does not apply — and they never commit or
// push: the scheduler isolates each item in a worktree, then replays the item's
// diff onto the main tree as a STAGED patch. Nothing is committed; the run still
// leaves everything staged for the human, exactly like the serial loop.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult { ok: boolean; out: string; err: string; }

export function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync("git", ["--no-pager", ...args], {
    cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}),
  });
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

/** Stage everything (tracked, untracked, deletions) without committing. Used when the
 *  run stops at a `@human` node: whoever picks the item up finds the work so far in a
 *  reviewable index. Staging is the ONLY thing the driver ever does to git. */
export function stageAll(cwd: string): GitResult {
  return git(cwd, ["add", "-A"]);
}

/** The working tree's dirty-file signature (`git status --porcelain`): which paths are
 *  dirty and how they are staged. Names and states only — NOT content. */
export function treeSignature(cwd: string): string {
  return git(cwd, ["status", "--porcelain"]).out;
}

/** Everything a review-only node must leave exactly as it found it: which files are
 *  dirty, how they are staged, AND what is inside them.
 *
 *  `treeSignature` alone is not enough, and that gap was a real hole: `git status
 *  --porcelain` is byte-identical before and after a write to a file that is ALREADY
 *  dirty — precisely the files a `@gate` node reviews. A gate whose read-only shell ran
 *  `sed -i`, `>>` or a redirect against the diff it was judging moved the tree while the
 *  status output never blinked, so the run reported a clean gate over an edited diff.
 *
 *  Content comes from a patch of the whole tree vs HEAD, computed through a THROWAWAY
 *  index (`GIT_INDEX_FILE`) so that — unlike `snapshotTree` — taking the signature never
 *  stages anything in the repo it is measuring. Concatenating the porcelain status keeps
 *  staged-ness in scope too, which the patch alone flattens away. */
export function treeStateSignature(cwd: string): string {
  const status = treeSignature(cwd);
  const idx = join(tmpdir(), `leopold-idx-${process.pid}-${randomBytes(6).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    // Seed the scratch index from HEAD so `add -A` records deletions, not just writes.
    if (!git(cwd, ["read-tree", "HEAD"], undefined, env).ok) return status; // no HEAD yet
    git(cwd, ["add", "-A"], undefined, env);
    return `${status}\n${git(cwd, ["diff", "--cached", "--binary", "HEAD"], undefined, env).out}`;
  } finally {
    rmSync(idx, { force: true });
  }
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
