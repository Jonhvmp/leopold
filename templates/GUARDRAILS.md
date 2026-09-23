# Guardrails

> The autonomy boundary for this run. Defaults are the recommended posture.

## Judgment posture
> Who decides a `@human` node, and what happens at an escalation, a deadlock or a
> third repeated failure. `full` (default): nobody is coming, so the run synthesizes
> the role that decision needs, decides it, and records the call in DECISIONS.md with
> a Reversal line. `ask`: both engines stop at the node with `awaiting_human` and wait
> for you. Override per run with `LEOPOLD_AUTONOMY=ask` or the driver's `--ask`.
> A persona DECIDES; it never ships — git stays locked either way, and no persona may
> raise a budget, clear the kill switch or edit this file.
- autonomy: full             # full | ask

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
- max_iterations: 50         # the RUN's ceiling — it carries across context windows
- max_failures: 3            # consecutive failures of the same kind
- token/time budget: none    # set if you want a hard ceiling

## Continuity
> Context pressure is maintenance, not death. When the window fills, the run writes
> `.leopold/CHECKPOINT.md` and stops as a window roll; the next window reseeds from it
> and re-reads this brief. `auto` (default): `leopold watch` relaunches the rolled
> window headless (`claude -p` / `codex exec`) with no human in the loop. `manual`:
> nothing relaunches — you resume with `/leopold-run`.
> The kill switch beats `continuity: auto`, always — the watcher checks
> `.leopold/STOP` BEFORE relaunching, and a relaunch never refreshes a budget.
> What still stops a run: the livelock gate (2 consecutive windows closing zero plan
> items), max_iterations, max_windows, max_failures, the kill switch, and the git lock
<!-- max_checkpoint_kb: 32   # optional: override the proportional checkpoint cap (default: min(32KB, 2% of max_context_mb)) -->
> waiting on you. A filled context window is no longer on that list.
> USD is deliberately NOT a governor: `total_cost_usd` lies on subscription billing,
> so autonomy is gated on durable progress (checked-off plan items), never on cost.
> API-billed users who want a hard cap can opt in with the driver's `--budget-usd`.
- continuity: auto           # auto | manual
- max_windows: 10            # total context windows one run may span

## Quality & orchestration (SDK driver)
> Toggles the SDK driver reads from here. A CLI flag or env var overrides the brief.
- review: on                 # diverse-lens review panel before an item closes
- hypotheses: on             # root-cause panel hands a stuck retry a concrete lead
- smart_routing: off         # research each item's blast radius before routing effort
- learn_on_finish: off       # on a clean finish, mine the run into proposed charter
                             # amendments (.leopold/CHARTER-amendments.md; never edits CHARTER)
- conformance: on            # verify the diff against an item's @scenario acceptance
                             # lines — active only when the item declares them
- literal_reset: on          # on a retry in a worktree-isolated run, restore the
                             # pre-item snapshot (discard the failed diff). Never a live repo
- best_of_k: 1               # >1 fans out K attempts on a critical/max item, judged,
                             # winner kept. 1 = off (opt-in; it costs)
- slice_scope: off           # feed smart_routing's researched file set to the worker
                             # as an explicit scope (needs smart_routing on)

## Verification commands
> OPTIONAL, and inert until you list something. What counts as evidence that an item is
> done: one of these ran after the item's last edit. `hooks/verify-receipt.sh` records a
> receipt (`verify_receipts`, `last_verify_at`) whenever a Bash command lexically matches
> an entry here — matched only where the entry BEGINS a command, so `cd sub && make test`
> and `echo $(make test)` match `make test`, while `make build # make test comes later`
> (a comment), `echo "- ran make test after the edit" >> notes.md` (an argument) and a
> heredoc whose body names it (data) match nothing — and stamps `last_edit_at` on every
> edit outside `.leopold/` (the run's own plan, decisions and journal are not the work a
> verification covers). With no entries below, nothing is recorded and
> nothing is claimed: the run behaves exactly as a project that predates the hook.
> Each receipt carries an `outcome`, and only `passed` or `ran` moves `last_verify_at`.
> On Claude Code a failing command usually arrives as `PostToolUseFailure` (`failed`), and
> a `PostToolUse` that was re-interpreted from a non-zero exit, interrupted, or
> backgrounded is recorded as `nonzero` / `incomplete` rather than as a pass; on Codex no
> payload carries a status at all, so a receipt there is `ran` — it proves the command RAN,
> not that it passed (hooks/hook-matrix.tsv, row `verify-receipt`).
<!-- - make test -->
<!-- - npm test -->

## On finish
- on_finish: keep            # keep | archive
> keep: brief, DECISIONS, and events stay in place. archive: on a clean finish,
> DECISIONS.md and events.jsonl move to .leopold/runs/<timestamp>/. Either way,
> the kill switch and git opt-in tokens are always cleared when a run stops.

## Kill switch
- `/leopold-stop` (clean) or `touch .leopold/STOP` (blunt). Takes effect at the
  next turn boundary; nothing is interrupted mid-turn.
