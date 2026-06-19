# Guardrails

> The autonomy boundary for this run. Defaults are the recommended posture.

## Action classes
- Autonomous: reversible work in the repo (edit, build, lint, test, stage).
- Gated (locked): git commit, git push, PR create/merge, publish, deploy.
- Forbidden: rm -rf outside scratch, edits outside the project root, editing
  this file / the hooks / Claude Code settings.

## Git posture
> Default: LOCKED. The run stages and reports; the human commits and pushes.
> To allow commits this session: `touch .leopold/ALLOW_GIT` (push stays locked).
- Commit: locked
- Push / PR / publish: locked

## Stop conditions
- max_iterations: 50
- max_failures: 3            # consecutive failures of the same kind
- max_no_progress: 6         # turns with the open PLAN set unchanged -> loop, stop
- max_subagents: 8           # total Task/subagent spawns per run; past it the guard
                             # denies more (each subagent re-loads the full context =
                             # the #1 cost multiplier). Raise only if you must.
- max_forks: 0               # forks clone the WHOLE session context (the leak) — forbidden
                             # by default; raise only if a sub-task needs the full convo
- max_context_mb: 5          # stop when the transcript passes this; a long run re-bills
                             # its growing context every turn. Resume with a fresh run.
- token/time budget: none    # set if you want a hard ceiling

## On finish
- on_finish: keep            # keep | archive
> keep: brief, DECISIONS, and events stay in place. archive: on a clean finish,
> DECISIONS.md and events.jsonl move to .leopold/runs/<timestamp>/. Either way,
> the kill switch and git opt-in tokens are always cleared when a run stops.

## Kill switch
- `/leopold-stop` (clean) or `touch .leopold/STOP` (blunt). Takes effect at the
  next turn boundary; nothing is interrupted mid-turn.
