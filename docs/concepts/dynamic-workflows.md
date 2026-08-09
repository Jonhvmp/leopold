# Dynamic Workflows

Leopold sits on top of Claude Code's [dynamic workflows](https://code.claude.com/docs/en/workflows).
A dynamic workflow is a JavaScript script that orchestrates subagents at scale: the
plan lives in **code**, not in one growing context window, so a long run doesn't drift
into the failure modes a single context is prone to — agentic laziness (stopping at 35
of 50 items), self-preferential bias (grading its own work), and goal drift (losing the
charter across compactions). Leopold stays the governed autonomy layer — a durable
brief, a charter that decides, a locked git — and uses workflows as an execution
substrate.

There are three ways to run a Leopold brief as a workflow, sharing one compiled shape.

## The brief, compiled

`PLAN.md` becomes **dependency waves**: wave 1 is every item with no unmet dependency,
wave 2 is every item whose `(after: N)` dependencies are all in wave 1, and so on. Each
item is risk-classified with the same keyword rules the driver uses everywhere —
`effort` (`low` for a typo, `max` for a migration), `critical` (billing/auth/migrations,
which earn a wider review panel), and `sensitive` (security-touching diffs). The result
is the `args` the canonical workflow script consumes:

```json
{
  "mission": "…", "charter": "…", "maxReviewRounds": 2,
  "waves": [
    [{ "id": "i1", "text": "Add a health endpoint", "effort": "medium", "critical": false, "sensitive": false }],
    [{ "id": "i2", "text": "Migrate the payments table", "effort": "max", "critical": true, "sensitive": true }]
  ]
}
```

The canonical script runs each item **implement → diverse-lens adversarial verify →
fix**, looping up to `maxReviewRounds`, with the items in a wave run serially (safe on a
single working tree) and each item's review fan-out run in parallel (read-only). Git is
locked for free — a workflow can't commit; it stages, you commit.

## When the plan authors a graph

Waves can only say "this comes after that". A plan that declares
[graph grammar](../reference/driver-config.md#graph-pre-flight-leopold-graph) says more:
a node kind (`@gate`, `@human`,
`@tool`, `@verify`), a conditional edge (`@on <cond> -> <target>`), a signal
(`@emit key=value`, `@needs key`). For those, the compiler emits one extra key beside
the waves:

```json
{
  "waves": [ … ],
  "graph": {
    "nodes": [
      { "index": 2, "id": "i2", "text": "Run the database migration", "kind": "work",
        "deps": [1], "needs": [], "emits": [{ "key": "migrated", "value": "false" }],
        "routes": [{ "when": "migrated=false", "target": 4, "kind": "signal" }] }
    ]
  }
}
```

`graph` present flips the canonical script from its wave loop to its **routed loop**: it
dispatches from the same deterministic routing function `/leopold-run`'s scheduler uses,
so the same plan takes the same path on both engines. A node emits a signal, the state
channel carries it, the graph decides where it leads — no model call ever picks an edge.
A `@human` node is decided by a role the run synthesizes for it (or halts with
`awaiting_human` under [`autonomy: ask`](../reference/plan-grammar.md#autonomy)); a
`@tool` node routes on its command's exit status; a `@gate` or `@verify` node judges the
diff and may not edit it.

Two guarantees hold around that switch:

- **`graph` only appears when the plan actually authors one.** A checklist written
  before this grammar existed compiles to a byte-identical payload and runs the wave
  loop untouched — same prompts, same report shape.
- **A malformed graph is refused before the first agent runs.** A cycle, a route to an
  item that does not exist, an unreachable item, a `@needs` nobody emits, or an `@on`
  routing on a signal nobody emits fails the compile, naming the offending item by
  index and text.

Because waves cannot express a branch, a plan with graph grammar must be compiled by
`leopold workflow` rather than by hand — `/leopold-workflow` says so and defers to it.

## Three ways to run it

| Path | Who runs it | When |
| --- | --- | --- |
| **`/leopold-workflow`** (skill) | The native runtime, from a Claude Code session | Interactive; you watch it in `/workflows` |
| **`leopold-driver workflow`** | Emits `.claude/workflows/leopold-run.js` + `.leopold/workflow-args.json`, deterministically | CI/scripts that compile now and run later |
| **`leopold-driver workflow --run`** | The experimental in-driver runtime, headless | Cron/CI, no interactive session (alpha) |

The `/leopold-workflow` skill compiles the brief and launches it on the native runtime.
`leopold-driver workflow` does the **same compilation as tested code** (not model-driven)
and emits the script + args so the compilation is reproducible and CI-checkable. Its
`--run` flag executes the emitted script through an experimental SDK-side runtime that
implements the same `agent`/`pipeline`/`parallel`/`phase`/`log`/`budget` globals with a
real concurrency cap — the orchestration engine is unit-tested; the agent call is a thin
query-backed shim.

!!! note "Status"
    `--run` is experimental, consistent with the SDK driver's alpha posture: the
    orchestration is unit-tested, but the query-backed agent is not yet exercised
    end-to-end. The compile/emit path is deterministic and fully tested.

## Watching a run

The [watch dashboard](../getting-started/first-run.md) discovers the native runtime's own
run files and renders a live **phase tree**: each run with its status, agent count, and
token/tool totals; each phase with its done/running counts; each agent with a status dot
(running pulses), label, tokens, tool calls, and its last tool. When a project has no
workflow runs, the panel hides itself.

## Related patterns as skills

Leopold ships other dynamic-workflow harnesses beyond the run engine:

- **`/leopold-learn`** — mine a run's decisions, session transcripts, and git history for
  recurring judgment calls; a skeptic kills the weak candidates; survivors become proposed
  charter amendments. The SDK driver can run this automatically on a clean finish
  (`learn_on_finish`).
- **`/leopold-triage`** — triage a backlog with the *quarantine* pattern: agents that read
  untrusted content have no repo access and only emit structured fields.
- **Plan by tournament** in `/leopold-brief` — three drafters, two judges, one synthesizer.

See [Skills](../reference/skills.md) for each.
