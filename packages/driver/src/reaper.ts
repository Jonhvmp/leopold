// Orphan reaper: detect a prior run that crashed leaving state.active === true,
// using a PID-liveness probe (the file's "active" flag is not proof of life).
// Ported from paperclip's isZombieRun/reapOrphanedRuns, file-state edition.

import fs from "node:fs";
import path from "node:path";
import { logEvent } from "./log.js";
import { clearRunTokens } from "./config.js";
import { cleanupWorktree } from "./worktree.js";

/** True if a process with this pid is alive. `process.kill(pid, 0)` sends no
 *  signal: it throws ESRCH if the pid is dead, EPERM if it's alive but not ours. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort preflight before a new run starts: if the previous run is still
 *  flagged active but its orchestrator pid is dead, declare it orphaned — flip
 *  inactive, log, clean its (clean) worktree, and clear stale run tokens.
 *
 *  Conservative on purpose: we only reap when there IS a pid AND it is dead.
 *  An active state with no pid (e.g. a live in-session /leopold-run, which does
 *  not persist orchestrator_pid) is left untouched — never clobber a live run. */
export function reapOrphan(repoRoot: string, leoDir: string): void {
  const p = path.join(leoDir, "state.json");
  if (!fs.existsSync(p)) return;
  let prev: Record<string, unknown>;
  try {
    prev = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (prev.active !== true) return;
  const pid = typeof prev.orchestrator_pid === "number" ? prev.orchestrator_pid : undefined;
  if (pid === undefined || isProcessAlive(pid)) return;

  prev.active = false;
  prev.stopped_reason = "reaped_orphan";
  try { fs.writeFileSync(p, JSON.stringify(prev, null, 2)); } catch { /* ignore */ }
  logEvent(leoDir, {
    event: "run_reaped",
    prior_pid: pid,
    prior_started: (prev.started_at as string) ?? null,
  });

  const wtPath = typeof prev.worktree_path === "string" ? prev.worktree_path : undefined;
  const wtBranch = typeof prev.worktree_branch === "string" ? prev.worktree_branch : undefined;
  if (wtPath && wtBranch) cleanupWorktree(repoRoot, { path: wtPath, branch: wtBranch }, leoDir);
  clearRunTokens(leoDir);
}
