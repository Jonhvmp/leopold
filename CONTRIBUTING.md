# Contributing to Leopold

Thanks for wanting to help conduct the orchestra.

## Ground rules

- Leopold conducts Claude Code through its public surfaces (skills, hooks,
  environment). It does not fork Claude Code or patch gstack skills. Keep
  contributions inside that boundary.
- Guardrails are sacred. Any change that could let an autonomous run commit,
  push, or run a destructive command without an explicit opt-in is a bug, not a
  feature. Such changes need a test that proves the lock still holds.
- Prefer model-driven design: behavior lives in prompts, the charter, and
  natural-language tool descriptions, not in rigid coded routers.

## Working on hooks

The hooks are plain POSIX-ish bash with one dependency (`jq`). They must:

- fail open for continuity (a broken Stop hook must never trap a session), and
- fail safe for guarding (when in doubt about a destructive command, deny).

Run the hook behavior tests before sending a change (see `docs/`). Validate
syntax with `bash -n hooks/*.sh`.

## Style

- English only for code, comments, docs, and commit messages.
- No em dashes, no filler. Lead with the point. Name files and commands.

## Pull requests

Keep them focused. Describe what changed, why, and how you verified it. If it
touches guardrails, show the test.
