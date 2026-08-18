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
leopold recall "query"               # search this project's run archive (decisions + Reversals, offline)
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

Uses your existing harness login — Claude Code or Codex — for the worker, the
conductor, and every panel agent. **No API key required.** `ANTHROPIC_API_KEY` is only
needed in a headless environment with no Claude Code auth.

## Choosing a harness

Every command that reaches a model takes `--provider claude|codex` — `run` **and**
`workflow --run`. Resolution order:

1. `--provider claude|codex`
2. `LEOPOLD_PROVIDER`
3. the only harness installed, if just one is
4. **the harness whose session Leopold was launched from**
5. Claude Code

Step 4 is the one that matters on a machine with both. Each CLI marks its child
environment — Codex exports `CODEX_THREAD_ID` (and `CODEX_CI`), Claude Code exports
`CLAUDECODE` / `CLAUDE_CODE_SESSION_ID` — so a run launched from a Codex session
belongs to Codex instead of falling through to the tie-break. With no marker at all,
the Claude fallback is unchanged.

```bash
leopold run --provider codex
leopold workflow --run --provider codex
LEOPOLD_PROVIDER=codex leopold run
```

### Hybrid: a harness per role

One run can execute on one harness and review on the other:

```bash
leopold workflow --run --provider hybrid \
  --executor-provider codex \
  --review-provider claude
```

| Role | Covers |
| --- | --- |
| `executor` | the workers that do the plan items |
| `review` | review lenses, hypothesis panels, tournament judges |
| `conductor` | turn decisions and smart routing |

A role left unset inherits the resolved default, so `--provider hybrid` alone is every
role on the same harness rather than a half-configured run. Every agent's provider is
recorded in `.leopold/events.jsonl` (`run_start`, `wf_phase`, `wf_agent_start`), so the
audit trail says who ran what instead of leaving it to be inferred.

Env equivalents: `LEOPOLD_EXECUTOR_PROVIDER`, `LEOPOLD_REVIEW_PROVIDER`,
`LEOPOLD_CONDUCTOR_PROVIDER`. A flag beats the env for the same role.

A run with no hybrid flags gets no role assignment at all — that is what keeps a
single-provider run byte-for-byte unchanged.

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
| `--ask` | off | restore the halting `@human`: the run stops with `awaiting_human` instead of deciding the node under a synthesized role |
| `--autonomy full\|ask` | `full` | the same knob spelled out (`ask`, `halt` and `human` all mean `ask`) |
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
| `LEOPOLD_AUTONOMY` | `full` | `ask` = same as `--ask` (also honoured by the Stop hook and the workflow engine) |
| `ANTHROPIC_API_KEY` | none | only for headless environments without Claude Code auth |

## Toggles in the brief (GUARDRAILS.md)

The orchestration posture can live with the brief instead of the command line.
`GUARDRAILS.md` may set any of these as `key: on|off`:

```markdown
## Judgment posture
- autonomy: full             # full | ask

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

### `autonomy: full | ask` { #autonomy }

`autonomy` is the one toggle that is not `on|off`, and the one that changes what a plan
*means*.

| Value | What a `@human` node does |
| --- | --- |
| `full` *(default)* | Nothing halts for a judgment call. Leopold synthesizes the role the decision needs, takes it, completes the item, and records the call in `DECISIONS.md` with a **Reversal** line. Escalations, invalid graphs and repeated failures get the same treatment. |
| `ask` | Both engines stop at the node with `awaiting_human`, name the item and stage everything. Answer it, mark the item `[x]`, re-run to resume. |

`ask`, `halt` and `human` all spell the strict posture; an unrecognised value is ignored
and the default stands. The driver, `/leopold-workflow` and the in-session Stop hook read
this same key with the same precedence, so a plan means one thing on both engines.

**A persona decides; it never ships.** `git commit`, `push`, force-push, `tag`, `publish`
and opening an external PR stay denied under either posture, and no persona may raise a
budget, clear the kill switch or edit `GUARDRAILS.md`. See
[Personas](../concepts/personas.md).

## Stop conditions

Come from `.leopold/GUARDRAILS.md`, same as the in-session engine: plan complete,
kill switch (`touch .leopold/STOP`), repeated failures, the iteration budget, the USD
budget, and an escalation or invalid graph that the persona paths could not settle.

`awaiting_human` is **not** among them under the default posture — a `@human` node is
decided, not parked. Set `autonomy: ask` to get it back.

The complete, authoritative list of every remaining stop condition — and, for each one,
whether a persona can affect it — is
[What still stops the run](../concepts/personas.md#what-still-stops-the-run).

## Notifications

On completion or escalation, the driver writes to the terminal and `events.jsonl`,
and POSTs JSON to `LEOPOLD_WEBHOOK` if set:

```json
{ "title": "Leopold finished", "body": "Plan complete; everything staged.", "source": "leopold" }
```

When `learn_on_finish` is on, the completion notice also lists any proposed
charter amendments (written to `.leopold/CHARTER-amendments.md`; the charter
itself is never edited).
