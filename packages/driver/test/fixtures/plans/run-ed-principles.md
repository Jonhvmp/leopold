# Plan

> Ordered, checkbox backlog for the harness deeper-levers mission (R1 spec-verify,
> R2 literal reset, R3 best-of-k, slice-scope). Each item is independently
> completable and verifiable. `(after: N)` = real dependency on item N (1-based).
> Writers of the same core file are chained so the plan is safe under --parallel;
> in practice run this SERIAL (`/leopold-run`), since 4 items touch loop.ts.
> Use Serena (LSP) for edits. Every new behavior gets a test — no claim without one.

- [x] Add the new driver toggles to `types.ts` (`DriverConfig`: conformance, literalReset, bestOfK:number, sliceScope) and resolve them in `config.ts` with the existing CLI/env > GUARDRAILS > default precedence; list them in `templates/GUARDRAILS.md`. — done when: `config.test.ts` covers each toggle's default (conformance on, literal_reset on, best_of_k 1/off, slice_scope off) and that a CLI flag + a GUARDRAILS line each override correctly; `npm run typecheck` is clean.

- [x] Extend `plan.ts` to parse `@scenario <text>` lines that follow a checkbox item into `PlanItem.scenarios: string[]`, whitespace/marker-tolerant and backward compatible. — done when: `plan.test.ts` proves an item with two `@scenario` lines yields `scenarios.length === 2` (text captured, item `text` unchanged), AND the existing PLAN fixture still parses to the identical `{index,text,done,deps}` with `scenarios: []` for every item.

- [x] (after: 1, 2) Add a `"conformance"` lens to `review.ts`: given an item's scenarios, verify the uncommitted diff satisfies each and return unmet ones as blocking findings; make `lensesFor` include it whenever the item has scenarios; phrase the blocking finding as the concrete unmet scenario. — done when: `review.test.ts` shows `lensesFor` includes `conformance` iff scenarios are present, and `parseReview` surfaces an unmet-scenario finding as blocking; typecheck clean.

- [x] (after: 3) Wire scenarios end-to-end: thread `item.scenarios` from the plan through `loop.ts` into both the worker prompt (as the definition of done) and the `reviewItem` call, so an item whose change violates a scenario cannot close. — done when: the worker prompt for an item with scenarios lists them as acceptance criteria, the review gate receives them, and an item with no scenarios takes the exact path it does today (verified by a focused test on the prompt/gate builder).

- [x] (after: 2) Teach the authoring path: update `leopold-brief` SKILL.md (Step 4) and `templates/PLAN.md` to document and show a real `@scenario` block, and have the brief write scenario lines for behavioral items. — done when: `templates/PLAN.md` shows a working `@scenario` example that `plan.ts` parses into scenarios, and the SKILL documents the grammar; docs build stays green.

- [x] Add `snapshotTree(cwd)` and `restoreTree(cwd, patch)` to `git.ts` (orchestrator-only, never commit/push): snapshot = uncommitted patch vs HEAD; restore = reset --hard HEAD then re-apply the patch staged, fail-safe on a bad patch. — done when: `git.test.ts` shows snapshot → mutate files → restore returns the tree exactly to the snapshot, and a corrupt patch leaves the tree unchanged and returns not-ok (prior work never lost).

- [x] (after: 4, 6) Literal fresh restart on serial retry (R2): in `loop.ts`, snapshot the tree before an item's first attempt; on a retry, if `literalReset` is on AND the run is worktree-isolated (`cwd !== brief.root`), restore the snapshot before dispatching the fresh worker (failed diff discarded, prior items intact); keep `retryLead` framing as the fallback for non-isolated runs. — done when: an isolated retry discards the failed diff while earlier items' staged work survives (asserted via a driver-level test/log), and the non-isolated path still uses framing only.

- [x] (after: 1) New `tournament.ts` for best-of-k (R3): given an item and K, run K attempts in parallel worktrees off HEAD, judge the diffs with a review-style panel, and select the winner's diff (or null); keep the winner-selection pure. — done when: a unit test on the pure winner-selection picks the highest-judged result deterministically, and the module typechecks.

- [x] (after: 7, 8) Route best-of-k in `loop.ts`: when `bestOfK > 1` AND the item is critical/max-effort, run the tournament instead of the single `processItem`, apply the winner staged, and fall back to the single path on any tournament failure; log K and the winner. — done when: with the toggle off the loop behaves identically to today, with it on a critical item emits a `tournament` event and a forced tournament failure falls back cleanly.

- [x] (after: 1, 9) Slice-scoped context (bonus): extend `route.ts` to return the researched file set on `ItemClass`, and in `loop.ts`, when `sliceScope` is on, add a scope note to the worker prompt listing those files. — done when: `route.test.ts` covers the file-set field, and the worker prompt includes the scope note only when the toggle is on and a non-empty set exists (off = unchanged).

- [x] (after: 4, 5, 7, 9, 10) Update docs honestly: README, driver README, `leopold-run`/`leopold-brief` SKILL.md, and the docs-site pages describe scenario verification, literal reset, best-of-k, and slice-scope — every new claim backed by a test. — done when: `mkdocs build --strict` (or the repo's docs check) is green, and a grep for the new toggle names finds them documented, none claiming untested behavior.

- [x] (after: 11) Final gate, staged: run the full `make test` (hooks + driver typecheck/build + docs strict + red-team) and `npm pack` dry-run, fix anything red, stage everything, and write the final summary. — done when: `make test` exits 0, `npm pack` dry-run is clean, and `git status` shows staged changes with zero commits made by the run.
