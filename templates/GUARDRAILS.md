# Guardrails

> The autonomy boundary for this run. Defaults are the recommended posture.

## Action classes
- Autonomous: everything except the two gated git ops below — edit, build, lint,
  test, refactor, delete, stage, spawn. The run has full authority over the work.
- Gated (locked): git commit and git push (force-push included). That is the
  whole lock; nothing else is blocked.

## Git posture
> Default: LOCKED. The run stages and reports; the human commits and pushes.
> To allow commits this run: `touch .leopold/ALLOW_GIT`. To allow push:
> `touch .leopold/ALLOW_PUSH`. Force-push stays denied regardless.
- Commit: locked (ALLOW_GIT to unlock)
- Push: locked (ALLOW_PUSH to unlock; force-push always denied)

## Stop conditions
- max_iterations: 50
- max_failures: 3            # consecutive failures of the same kind
- token/time budget: none    # set if you want a hard ceiling

## On finish
- on_finish: keep            # keep | archive
> keep: brief, DECISIONS, and events stay in place. archive: on a clean finish,
> DECISIONS.md and events.jsonl move to .leopold/runs/<timestamp>/. Either way,
> the kill switch and git opt-in tokens are always cleared when a run stops.

## Kill switch
- `/leopold-stop` (clean) or `touch .leopold/STOP` (blunt). Takes effect at the
  next turn boundary; nothing is interrupted mid-turn.
