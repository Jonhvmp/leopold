# Contributing

Thanks for wanting to help conduct the orchestra.

## Ground rules

- Leopold conducts Claude Code through its public surfaces (skills, hooks,
  environment). It does **not** fork Claude Code or patch gstack skills. Keep
  contributions inside that boundary.
- **Guardrails are sacred.** Any change that could let an autonomous run commit,
  push, or run a destructive command without an explicit opt-in is a bug, not a
  feature. Such changes need a test that proves the lock still holds.
- Prefer model-driven design: behavior lives in prompts, the charter, and
  natural-language tool descriptions, not rigid coded routers.

## Working on hooks

The hooks are POSIX-ish bash with one dependency (`jq`). They must:

- fail **open** for continuity (a broken Stop hook must never trap a session), and
- fail **safe** for guarding (when in doubt about a destructive command, deny).

Validate syntax with `bash -n hooks/*.sh`.

## Working on the driver

```bash
cd packages/driver
npm install
npm run typecheck
npm run build
```

## Working on the docs

```bash
pip install -r requirements-docs.txt
mkdocs serve         # live preview at http://127.0.0.1:8000
mkdocs build --strict  # what CI runs
```

## Style

- English only for code, comments, docs, and commit messages.
- Lead with the point. Name files and commands. No filler.

## Pull requests

Keep them focused. Describe what changed, why, and how you verified it. If it
touches guardrails, show the test.
