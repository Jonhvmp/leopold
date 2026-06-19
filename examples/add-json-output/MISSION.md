# Mission

## Problem
Our CLI `statsy` prints a human table. Scripts that consume it have to scrape stdout,
which breaks every time we tweak the layout.

## Goal
Add a `--json` flag that prints the same data as a stable JSON object, so scripts can
parse it. Keep the default human output byte-for-byte unchanged.

## Non-goals
- New metrics or data sources.
- A streaming/NDJSON mode (one object is enough for now).
- Changing the default output.

## Definition of done
- [ ] `statsy --json` prints a single valid JSON object with the same fields as the table.
- [ ] Default output (no flag) is unchanged; a snapshot test proves it.
- [ ] `--json` has a test asserting shape + values.
- [ ] `README` documents the flag with one example.
- [ ] `make test` green; work staged, nothing committed.

## Constraints
- Node + commander. Match existing code style. English only.
