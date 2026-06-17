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
- token/time budget: none    # set if you want a hard ceiling

## Kill switch
- `/leopold-stop` (clean) or `touch .leopold/STOP` (blunt). Takes effect at the
  next turn boundary; nothing is interrupted mid-turn.
