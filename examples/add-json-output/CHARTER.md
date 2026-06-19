# Charter

## What I optimize for
1. Backward compatibility — the default output must not change. A broken script in the
   wild is worse than a late feature.
2. The smallest change that satisfies the mission. No new abstractions.
3. Tests that would actually catch a regression, not coverage theater.

## Technology and style preferences
- Prefer: the existing commander setup; a single `toJSON()` helper next to the table
  renderer; `node:test`. English everywhere.
- Avoid: a config system, a plugin for output formats, new dependencies.

## Always
- Verify before done: `make test`, including a snapshot of the default output.
- Keep git locked: stage and report; the human commits.

## Never
- Change the default (no-flag) output.
- Add a dependency to format JSON (`JSON.stringify` is enough).
- Invent fields not already in the table.

## Tie-breakers
- Compatibility vs elegance: compatibility wins.
- A field's JSON name is ambiguous → use the exact table column key, lowercased; log it.
- Anything irreversible (commit/push/publish): stop, hand to the human.

## Examples of decisions I would make
- "Pretty-print the JSON or one line? One line — it's machine-facing; humans have the
  table. Reversible, charter favors the simplest thing. Decide and log."
- "Column header has a space (`Avg Latency`) → key `avg_latency`. Log the mapping."
