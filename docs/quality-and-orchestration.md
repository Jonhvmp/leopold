# Quality & orchestration

Leopold doesn't just keep Claude Code running — it makes each item land at a higher
quality, runs independent work in parallel, and tunes how hard the model thinks per
item. These are the levers that turn "an agent that keeps going" into "an agent worth
trusting with the seat." They all lean on native Claude Code capabilities.

## The review gate

The worker reporting `done` after build/lint/test isn't enough — nothing has *reviewed*
the change. So before an item can close, an **independent reviewer** (its own Claude Code
session, so it can invoke the native `/code-review` and `/security-review` skills) reads the
item's uncommitted diff and returns a verdict:

- **Clean** → the item closes.
- **Blocking findings** → handed straight back to the worker to fix, then re-reviewed. Up to
  `--max-review-rounds` (default 2) before the item is allowed through anyway (so a stubborn
  reviewer can't wedge the run).

Sensitive diffs (paths matching `auth|login|session|secret|token|billing|payment|.env|…`)
are reviewed with security rigor. An unparseable verdict **fails closed** — it never silently
passes the gate. The gate is on by default; `--no-review` (or `LEOPOLD_REVIEW=0`) turns it off.

> Tip for the worker: self-review with `/code-review` *before* reporting done, so the gate
> passes first try. The `/leopold-run` skill tells it exactly that.

## Per-item effort + the advisor analog

Every item is risk-classified by a cheap, deterministic keyword pass over the item text and
the charter (no extra LLM call). The class sets the worker's native SDK **reasoning effort**:

| Item looks like | Effort | Extra |
| --- | --- | --- |
| typo, rename, docs, formatting | `low` | — |
| ordinary feature work | `medium` | — |
| billing, auth, secrets, permissions, deploy | `high` | **critical** |
| migrations, schema, payment, crypto (sharp edges) | `max` | **critical** |
| (any item, if the charter declares the project high-risk) | `high` | — |

**Critical** items also get a **second, independent reviewer** and the union of both reviewers'
blocking findings. The Agent SDK has no "advisor"; criticality buys a real second opinion
instead — the cheap items stay cheap, the dangerous ones get scrutiny.

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
incomplete vs. conflicted, the effort mix, review-gate pass rate (and how many were
security-sensitive or got a second opinion), decisions logged, escalations, guard blocks, and
real spend. `--json` for machine output. It's the same data the watch dashboard streams live —
read it back to write sharper briefs next time.
