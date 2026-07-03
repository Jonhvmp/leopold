# Quality & orchestration

Leopold doesn't just keep Claude Code running — it makes each item land at a higher
quality, runs independent work in parallel, and tunes how hard the model thinks per
item. These are the levers that turn "an agent that keeps going" into "an agent worth
trusting with the seat." They all lean on native Claude Code capabilities.

## The review gate — a panel of skeptics

The worker reporting `done` after build/lint/test isn't enough — nothing has *reviewed*
the change. And a single reviewer shares one failure mode with the worker: it can be
plausible-and-wrong in the same direction. So before an item can close, a **panel of
independent skeptics** (each its own Claude Code session, so it can invoke the native
`/code-review` and `/security-review` skills) reads the item's uncommitted diff — each
through a **distinct lens**:

| Item | Panel |
| --- | --- |
| ordinary | correctness |
| sensitive diff (`auth\|secret\|billing\|payment\|.env\|…`) | correctness + security |
| critical (billing, auth, migrations, …) | correctness + security + does-it-actually-work |

Diversity beats redundancy: three identical reviewers re-find the same bugs; three
different lenses catch failure modes the others structurally miss. The verdicts are
**unioned** (deduped by file+issue):

- **Clean panel** → the item closes.
- **Blocking findings** → handed straight back to the worker to fix, then re-reviewed. Up to
  `--max-review-rounds` (default 2) before the item is allowed through anyway (so a stubborn
  panel can't wedge the run).

An unparseable verdict **fails closed** — it never silently passes the gate. The gate is on
by default; `--no-review` / `LEOPOLD_REVIEW=0` / `review: off` in GUARDRAILS turns it off.

> Tip for the worker: self-review with `/code-review` *before* reporting done, so the gate
> passes first try. The `/leopold-run` skill tells it exactly that.

## Per-item effort — keywords or research

Every item is risk-classified by a cheap, deterministic keyword pass over the item text and
the charter (no extra LLM call). The class sets the worker's native SDK **reasoning effort**:

| Item looks like | Effort | Extra |
| --- | --- | --- |
| typo, rename, docs, formatting | `low` | — |
| ordinary feature work | `medium` | — |
| billing, auth, secrets, permissions, deploy | `high` | **critical** |
| migrations, schema, payment, crypto (sharp edges) | `max` | **critical** |
| (any item, if the charter declares the project high-risk) | `high` | — |

**Critical** items face the full three-lens review panel — the cheap items stay cheap, the
dangerous ones get scrutiny.

Keywords only see the item's *wording*. Opt into **smart routing** (`--smart-routing` or
`smart_routing: on` in GUARDRAILS) and a short read-only session researches the item's *real*
blast radius — which files, how many callers — before routing. It always falls back to the
deterministic classifier on any failure, and it can never lower a keyword-critical item below
critical (a safety floor: money/auth/migrations stay guarded even if the router relaxes).

## The root-cause panel — no doubling down

When the same item fails repeatedly, a single context tends to double down on its own theory
(self-preferential bias). On a retry, Leopold instead convenes a **root-cause panel**: three
investigators form hypotheses over **disjoint evidence** — the diff itself, the verification
output taken literally, and the item's assumptions checked against the codebase — then a
refuter tries to kill each one (unparseable refutations fail closed). The strongest surviving
hypothesis is handed to the next attempt as a **concrete lead**, with an explicit instruction
to verify the theory quickly and abandon it if wrong. On by default; `--no-hypotheses` /
`hypotheses: off` turns it off.

## The charter that learns you

Your recorded behavior beats your self-description. With `--learn-on-finish` (or
`learn_on_finish: on` in GUARDRAILS), a clean finish mines the run — the decision log it just
wrote, archived runs, and the repo's git history — for recurring judgment calls, puts a
kill-biased skeptic on every candidate, and writes the survivors to
`.leopold/CHARTER-amendments.md` as a **proposal**. It never edits `CHARTER.md`: you review and
fold in what sounds like you. The `/leopold-learn` skill is the richer, workflow-powered version
(it also mines your session transcripts). Each pass compounds — a sharper charter means fewer
escalations next run.

## Parallel execution

Independent plan items don't have to wait in line. Declare order in `PLAN.md` with an
`(after: N)` marker (1-based item position); items with no marker are independent:

```markdown
- [ ] Add the API layer
- [ ] (after: 1) Wire the UI to the API
- [ ] (after: 1) Add API metrics
- [ ] Refresh the docs
```

With `leopold-driver run --parallel 3`, a dependency-aware scheduler dispatches up to 3 ready
items at once, **each in its own git worktree** off the main tree. When an item finishes (and
passes the review gate), the driver **replays its diff onto the main tree as a staged patch** —
serialized so the shared tree stays consistent, and **never committed**, so the "human owns
git" guarantee holds exactly as in serial mode. Two items that touched the same lines produce a
conflict: that item's worktree is **preserved for manual merge** instead of losing the work.

Default is serial (`--parallel 1`). Split work so more items are independent, and only add
`(after: …)` for real dependencies — items that all edit the same files should depend on each
other (or be a single item) to avoid conflicts.

## One-command setup — `leopold up`

Most people use a fraction of Claude Code. `leopold up` (CLI) plus `/leopold-up` (in-session)
closes that gap in one move:

- **`leopold up`** (shell): installs the harness and seeds a sane per-project permissions
  allowlist so routine dev work stops prompt-flooding.
- **`/leopold-up`** (skill, Phase 0): generates project memory with `/init`, teaches Claude to
  build and run the app with `/run-skill-generator` (which makes the run-time `/verify` real),
  checks MCP/extensions (Serena, ovmem, gstack), suggests a default `/effort`, then hands off
  to `/leopold-brief`.

## Insights

After a run, `leopold-driver insights` turns `events.jsonl` into a report: items done vs.
incomplete vs. conflicted, the effort mix, review-panel pass rate (and how many were
security-sensitive or faced a multi-lens panel), root-cause panels run and leads produced,
charter amendments proposed, decisions logged, escalations, guard blocks, and real spend.
`--json` for machine output. It's the same data the watch dashboard streams live — read it
back to write sharper briefs next time.
