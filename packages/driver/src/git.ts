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
