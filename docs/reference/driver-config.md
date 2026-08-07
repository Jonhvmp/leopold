# Driver Config

Configuration for the [SDK driver](../architecture/driver.md). It reads the
`.leopold/` brief from the current project and runs the orchestration loop.

## Usage

```bash
npm i -g leopold-driver      # or: cd packages/driver && npm install && npm run build

# from a project that has a .leopold/ brief, with Claude Code logged in:
leopold run                          # conduct the run (serial)
leopold run --dry-run                # load the brief, show the plan, do nothing
leopold run --parallel 3             # independent plan items concurrently, one worktree each
leopold run --worktree               # isolate the whole run in a git worktree
leopold run --budget-usd 5           # hard-stop at a USD cap
leopold workflow                     # compile the brief into a dynamic workflow (emit)
leopold workflow --print             # dump the compiled args JSON
leopold workflow --run               # execute it headlessly (experimental runtime)
leopold graph                        # print + validate the plan's graph (exit 1 if invalid)
leopold graph --mermaid              # the same graph as a fenced mermaid diagram
leopold insights                     # summarize the run's events.jsonl
```

## Graph pre-flight (`leopold graph`)

The command to run before you trust a plan. It parses `.leopold/PLAN.md` into the
same graph the scheduler routes on — node kinds (`@gate`, `@human`, `@tool`,
`@verify`), `(after:)` dependency edges, conditional `@on` routes, `@emit`/`@needs`
signals — prints it, and validates it. **A malformed graph fails here, before the
first agent runs**, with the offending items named:

```
✗ Cycle: item 4 ("Run the migration") -> item 9 ("Roll back") -> item 4 (…). …
✗ item 7 ("Ship it") routes to item 12, which does not exist (`@on fail`).
✗ item 5 ("Deploy") needs signal "approved", which no item emits.
✗ item 8 ("Clean up") is unreachable: no wave and no route can dispatch it.
```

| Flag | Purpose |
| --- | --- |
| *(none)* | ASCII tree: one line per node with its kind, checkbox, deps and signals; routes hang under their source as `→ on <cond> → item N` |
| `--mermaid` | a fenced `mermaid` diagram — one shape per node kind, dotted labelled arrows for routes |
| `--json` | the machine form: `{ plan, nodes, edges, diagnostics }` |
| `--quiet` | print nothing on success — for a pre-flight in a script |
| `--plan PATH` | validate a plan outside `.leopold/` |

Exit codes: `0` the graph is sound, `1` it is malformed (diagnostics on stderr),
`2` there was no plan to read. So a gate is just:

```bash
leopold graph --quiet || exit 1
```

A plan that uses none of the graph grammar can never fail this check: `(after:)`
edges only ever point at an earlier item, so they cannot cycle, dangle or strand
anything.

## Auth

Uses your existing Claude Code login for the worker, the conductor, and every
panel agent. **No API key required.** `ANTHROPIC_API_KEY` is only needed in a
headless environment with no Claude Code auth.

## Flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--parallel N` | `1` | run up to N independent plan items at once, each in its own worktree, replaying each diff onto the main tree as a staged patch |
| `--worktree` | off | isolate a serial run in a dedicated git worktree |
| `--budget-usd N` | none | stop the run once accumulated real spend reaches N |
| `--no-review` | review on | turn off the diverse-lens review panel |
| `--no-conformance` | conformance on | turn off the conformance lens (only active on items that declare `@scenario` acceptance lines) |
| `--max-review-rounds N` | `2` | review→fix rounds per item before it closes anyway |
| `--no-hypotheses` | panel on | turn off the root-cause panel on retried items |
| `--no-literal-reset` | reset on | stop restoring the pre-attempt snapshot on retry in an isolated run (falls back to reframing in a non-isolated run) |
| `--best-of-k N` | `1` | settle a critical, worktree-isolated item by a tournament of N independent attempts (bounded 2..6; opt-in, costs N×) |
| `--smart-routing` | off | research each item's real blast radius before routing effort (falls back to keywords; never lowers a critical floor) |
| `--slice-scope` | off | hand smart-routing's file set to the worker as a "start with these files" scope note (needs `--smart-routing`) |
| `--learn-on-finish` | off | on a clean finish, mine the run into proposed charter amendments |
| `--dry-run` | — | load the brief and report; run nothing |

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `LEOPOLD_CONDUCTOR_MODEL` | your Claude Code default | the conductor's (and panels') model |
| `LEOPOLD_WORKER_MODEL` | your Claude Code default | the worker's model |
| `LEOPOLD_MAX_TURNS_PER_ITEM` | `40` | worker turn budget per item |
| `LEOPOLD_WEBHOOK` | none | URL for JSON POST notifications (Slack/Discord/etc.) |
| `LEOPOLD_WORKTREE` | `0` | `1` = same as `--worktree` |
| `LEOPOLD_BUDGET_USD` | none | same as `--budget-usd` |
| `LEOPOLD_REVIEW` | `1` | `0` = same as `--no-review` |
| `LEOPOLD_CONFORMANCE` | `1` | `0` = same as `--no-conformance` |
| `LEOPOLD_MAX_REVIEW_ROUNDS` | `2` | same as `--max-review-rounds` |
| `LEOPOLD_PARALLEL` | `1` | same as `--parallel` |
| `LEOPOLD_HYPOTHESES` | `1` | `0` = same as `--no-hypotheses` |
| `LEOPOLD_LITERAL_RESET` | `1` | `0` = same as `--no-literal-reset` |
| `LEOPOLD_BEST_OF_K` | `1` | same as `--best-of-k` (>1 enables; bounded 2..6) |
| `LEOPOLD_SMART_ROUTING` | `0` | `1` = same as `--smart-routing` |
| `LEOPOLD_SLICE_SCOPE` | `0` | `1` = same as `--slice-scope` |
| `LEOPOLD_LEARN_ON_FINISH` | `0` | `1` = same as `--learn-on-finish` |
| `ANTHROPIC_API_KEY` | none | only for headless environments without Claude Code auth |

## Toggles in the brief (GUARDRAILS.md)

The orchestration posture can live with the brief instead of the command line.
`GUARDRAILS.md` may set any of these as `key: on|off`:

```markdown
## Quality & orchestration (SDK driver)
- review: on
- conformance: on
- hypotheses: on
- literal_reset: on
- best_of_k: 1
- smart_routing: off
- slice_scope: off
- learn_on_finish: off
```

Precedence: **explicit CLI flag / env var → GUARDRAILS.md → built-in default.**

## Stop conditions

Come from `.leopold/GUARDRAILS.md`, same as the in-session engine: plan complete,
kill switch (`touch .leopold/STOP`), repeated failures, and the iteration budget.

## Notifications

On completion or escalation, the driver writes to the terminal and `events.jsonl`,
and POSTs JSON to `LEOPOLD_WEBHOOK` if set:

```json
{ "title": "Leopold finished", "body": "Plan complete; everything staged.", "source": "leopold" }
```

When `learn_on_finish` is on, the completion notice also lists any proposed
charter amendments (written to `.leopold/CHARTER-amendments.md`; the charter
itself is never edited).
