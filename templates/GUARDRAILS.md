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

## Quality & orchestration (SDK driver)
> Toggles the SDK driver reads from here. A CLI flag or env var overrides the brief.
- review: on                 # diverse-lens review panel before an item closes
- hypotheses: on             # root-cause panel hands a stuck retry a concrete lead
- smart_routing: off         # research each item's blast radius before routing effort
- learn_on_finish: off       # on a clean finish, mine the run into proposed charter
                             # amendments (.leopold/CHARTER-amendments.md; never edits CHARTER)

## On finish
- on_finish: keep            # keep | archive
> keep: brief, DECISIONS, and events stay in place. archive: on a clean finish,
> DECISIONS.md and events.jsonl move to .leopold/runs/<timestamp>/. Either way,
> the kill switch and git opt-in tokens are always cleared when a run stops.

## Kill switch
- `/leopold-stop` (clean) or `touch .leopold/STOP` (blunt). Takes effect at the
  next turn boundary; nothing is interrupted mid-turn.
