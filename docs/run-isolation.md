# Run isolation & orphan reaping

Native port of two things paperclip does well — a git worktree per run and a
pid-liveness reaper — into the Leopold harness. No Postgres, no daemon; state stays
in `.leopold/`, git runs from the orchestrator (Node), signals go to process groups.

## Why

The SDK driver (`leopold-driver run`, "Path A") runs each plan item with a fresh
Claude Code worker via the Agent SDK `query()`, **in-process**, with `cwd: brief.root`
(`packages/driver/src/worker.ts`). Subagents the worker spawns inherit that cwd. Two gaps:

1. **No isolation.** A run mutates the user's working tree directly; two runs on the same
   checkout collide. The docs already tell users to `git worktree add` manually
   (`docs/guardrails.md`) — this automates it.
2. **No reaping.** If a run crashes, `state.json` keeps `active:true` forever, and any
   worktree it created is orphaned. Nothing detects or cleans it.

"Path B" (`/leopold-run`, the in-session skill) conducts the live session itself, so it
cannot switch its own cwd — worktree automation is Path A only. Both paths share `.leopold/`.

## What

1. **Worktree per run — opt-in, Path A.** `leopold-driver run --worktree` (or
   `LEOPOLD_WORKTREE=1`) provisions a dedicated worktree on a throwaway branch
   `leopold/run-<id>` and points the worker's `cwd` at it. The run and its subagents are
   isolated from the user's tree and from other runs. The driver runs git **directly via
   Node**, so the worker's git lock is unaffected — the lock constrains the worker, not the
   orchestrator. Falls back to `brief.root` if the project is not a git repo.
2. **Orphan reaper — both paths.** The driver persists `orchestrator_pid` in `state.json`.
   A startup preflight reaps a prior orphaned run: `active:true` but its pid is dead
   (`process.kill(pid, 0)` throws `ESRCH`) → flip `active:false`, log `run_reaped`, clean its
   worktree, clear stale run tokens. Path B keeps its existing ~10-min staleness check.
3. **State write hardening.** `writeState` becomes **read-merge-write**: the TS driver and the
   bash skill/Stop-hook are two writers with different schemas, and the old full-overwrite
   dropped each other's fields (`session_id`, `max_subagents`, `worktree_path`, …). The merge
   preserves unknown keys so the new fields survive across both writers.
4. **Cleanup is never destructive.** Git is locked, so a run *stages* but never *commits*. A
   worktree with uncommitted work is **preserved** and logged (`worktree_preserved`) for the
   user to review/merge. Only a clean worktree is removed (`worktree remove --force` +
   `branch -D leopold/run-<id>`).
5. **Guard.** `git worktree` is made explicitly allowed in `guard-irreversible.sh`, and the
   `git branch -D` block gains a narrow exception for the harness's own throwaway
   `leopold/run-*` branches (any other branch deletion stays forbidden).

## Files

| File | Change |
|---|---|
| `packages/driver/src/types.ts` | `RunState += worktree_path?/worktree_branch?/orchestrator_pid?`; `Brief += worktreeRoot?`; `DriverConfig += worktree` |
| `packages/driver/src/config.ts` | `loadConfig` reads `--worktree`/`LEOPOLD_WORKTREE`; `writeState` read-merge-write; `initState` writes `orchestrator_pid` |
| `packages/driver/src/worktree.ts` *(new)* | `createWorktree`, `cleanupWorktree` (preserve-if-dirty), `isGitRepo`, `isDirty` |
| `packages/driver/src/reaper.ts` *(new)* | `reapOrphan` (active + dead pid), `isProcessAlive` |
| `packages/driver/src/loop.ts` | reaper preflight; provision worktree; persist `worktree_path`; cleanup in `stop()` |
| `packages/driver/src/worker.ts` | `cwd: brief.worktreeRoot ?? brief.root` |
| `hooks/guard-irreversible.sh` | allow `git worktree`; `branch -D` exception for `leopold/run-*` |
| `skills/leopold-run/SKILL.md` | note `--worktree`; reap an orphaned worktree in the staleness check |
| `packages/driver/test/worktree.test.ts`, `reaper.test.ts` *(new)* | unit tests against a temp git repo |

## Verification

- `make driver-check` (typecheck) + `make driver-test` (vitest) green.
- Temp git repo: `leopold-driver run --worktree` provisions `leopold/run-<id>`, the worker's
  cwd is the worktree, a clean run removes it, a dirty run preserves it (logged).
- Reaper: a `state.json` with `active:true` + a dead pid is flipped to `active:false` and its
  worktree pruned on next startup; a live pid is left untouched.
- `writeState` merge: a field written by bash (`max_subagents`) survives a subsequent driver
  write, and vice-versa.
- Guard: `git worktree add/remove` allowed; `git branch -D leopold/run-x` allowed;
  `git branch -D main` still denied; `git reset --hard` still denied.
