# Decisions

Autonomous decisions, newest last. Written by Leopold during the run; the human reviews
them after.

---

**Fork:** Pretty-printed JSON or single line?
**Class:** reversible
**Charter:** "the smallest change"; the output is machine-facing.
**Decision:** Single line — `JSON.stringify(obj)` with no spacing.
**Why:** Humans already have the table; scripts want compact, stable output. Trivial to
change later.
**Reversal:** Add a second arg to `JSON.stringify` for indentation.

---

**Fork:** How to key a column whose header has a space, `Avg Latency`?
**Class:** reversible (charter is explicit)
**Charter:** "use the exact table column key, lowercased; log it."
**Decision:** `avg_latency`. Mapping for the run: `Requests→requests`,
`Errors→errors`, `Avg Latency→avg_latency`, `P99→p99`.
**Why:** Deterministic and matches the documented tie-breaker.
**Reversal:** Rename the key; it is only referenced in `toJSON` and its test.

---

**Fork:** The table renderer rounds latency to 1 decimal for display. Should `--json`
emit the rounded value or the raw number?
**Class:** reversible
**Charter:** "values equal to the table's" (DoD) vs "machine-facing" (charter).
**Decision:** Emit the **raw** number; document that the table rounds for display.
**Why:** Scripts want precision; "equal to the table" means the same datum, not the same
rounding. Logged here so the human can veto.
**Reversal:** Round in `toJSON` to match the table exactly.

---

## Final state (run ended: plan_complete)

- All 6 plan items checked off in `PLAN.md`.
- Changed: `src/render.js` (+`toJSON`), `src/cli.js` (+`--json`), `test/output.test.js`
  (snapshot + `--json` cases), `README.md` (flag docs).
- `make test`: green (snapshot proves the default output is byte-for-byte unchanged).
- **Staged, not committed.** Ready for the human:
  `git commit -m "feat(cli): add --json output"` then push.
