# Plan

- [ ] Add a `toJSON(stats)` helper next to the table renderer that returns a plain
      object keyed by the table's column keys (lowercased, spaces → `_`).
- [ ] Register a `--json` boolean flag on the `statsy` command; when set, print
      `JSON.stringify(toJSON(stats))` and skip the table.
- [ ] Snapshot-test the default output (no flag) so it can never silently change.
- [ ] Test `--json`: valid JSON, exact field set, values equal to the table's.
- [ ] Document `--json` in the README with a one-line example.
- [ ] Run `make test`; stage everything; report what is ready for the human to commit.
