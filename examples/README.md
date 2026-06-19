# Examples

Reproducible Leopold runs. Each folder is a complete brief (`MISSION` / `CHARTER` /
`PLAN`) plus the `DECISIONS.md` an autonomous run produced from it. They do two things:

1. **Prove the loop works** — `DECISIONS.md` is what Leopold decided on its own, in
   the charter's voice, with the reversal noted for each.
2. **Teach the brief format** — the quality of a run is capped by the brief, so the
   fastest way to write a good one is to copy a working one.

To run an example yourself: copy its `MISSION/CHARTER/GUARDRAILS/PLAN` into a project's
`.leopold/`, then `/leopold-run`. (The `GUARDRAILS.md` is the standard one from
`/leopold-brief`; only the three shown here change per mission.)

| Example | What it shows |
|---|---|
| [`add-json-output/`](add-json-output/) | A small, multi-step feature run: decide reversible forks from the charter, stage the work, stop at git. |
