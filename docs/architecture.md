# Architecture

Leopold is an agent harness. A harness is everything wrapped around the model
except the model itself: tool execution, memory and state, orchestration,
guardrails, and observability. `Agent = Model + Harness`. Claude Code is already
a strong harness for a single interactive turn. Leopold extends it for
unattended, long-running work.

This document describes the design across the six standard harness layers, and
maps each layer to what the v0.1 in-session engine implements today versus what
the roadmap SDK driver will add.

---

## Design principles

1. **Conduct, do not replace.** Leopold drives Claude Code and the gstack skill
   library through their own public surfaces (skills, hooks, environment). It
   adds no fork of Claude Code and patches no skill.
2. **Model-driven, not hardcoded.** The orchestration logic lives in prompts,
   the charter, and natural-language tool descriptions, not in a rigid coded
   router. As the model improves, Leopold improves with it, no refactor needed.
3. **The brief is the contract.** Everything autonomous flows from four
   artifacts produced in the brief phase. The run never invents intent; it
   executes the brief.
4. **Guardrails are first-class.** Autonomy is only safe when the dangerous
   actions are gated by construction, not by good behavior. The git lock is
   enforced by a hook, not by a prompt the model could rationalize past.
5. **Every decision is auditable.** A decision the human did not make must be
   recoverable later, with its reasoning. `DECISIONS.md` is the trail.

---

## The two phases

### Phase 1 — Brief

A structured, adversarial conversation that ends with four files written to
`.leopold/` in the target project:

- **`MISSION.md`** — problem, goal, scope, explicit non-goals, and the
  definition of done. This is *what*.
- **`CHARTER.md`** — the decider. Priorities, taste, technology preferences,
  hard `never` and `always` rules, risk tolerance, and how to break ties. This
  is *how you would choose*. It is the part that "becomes you."
- **`GUARDRAILS.md`** — the autonomy boundary. Which action classes are
  autonomous, which are gated, the stop conditions, the budgets, and the kill
  switch. This is *what stays locked*.
- **`PLAN.md`** — an ordered, checkbox backlog. This is the *work queue* the run
  burns down.

The brief is re-runnable. You debate it until it reflects how you actually
think, because the autonomous run is capped by the quality of the brief.

### Phase 2 — Run

`/leopold-run` flips the project into autonomous mode and the loop begins:

```
              +-------------------------------------------------+
              |  turn N: read PLAN.md -> pick next open item     |
              |          do the work (gstack skill if it fits)   |
              |          fork? -> consult CHARTER -> decide+log   |
              |          mark item done                          |
              +-------------------------+-----------------------+
                                        |
                              Claude finishes the turn
                                        |
                                   Stop hook fires
                                        |
                  +---------------------+----------------------+
                  | stop condition met?                        |
                  |   yes -> allow stop, write final summary   |
                  |   no  -> re-inject "continue" -> turn N+1   |
                  +--------------------------------------------+
```

The loop is *state-coupled*: continuation is a function of `PLAN.md` and the
stop conditions, never an unconditional "keep going" flag. This is the single
most important reliability property; loose continuation flags are how agents
melt down.

---

## Layer-by-layer

### 1. Orchestration layer

**v0.1:** A Claude Code `Stop` hook (`stop-continuity.sh`). When the main agent
finishes a turn, the hook reads `.leopold/state.json` and `PLAN.md`. If autonomy
is active and the plan has open items and no stop condition is met, it returns a
`block` decision whose `reason` re-injects a compact instruction: read the plan,
take the next item, apply the decision protocol, log, do not ask. Each
continuation increments an iteration counter, which feeds the budget stop
condition.

**Roadmap:** an external DAG executor in the SDK driver that runs independent
plan items as parallel waves, with explicit dependencies and a replanning loop.

### 2. Memory and context layer

**v0.1:** The brief artifacts are Leopold's "System of Context": durable,
human-readable, version-controllable files. `DECISIONS.md` accumulates the
decision trail. `state.json` holds run state (active, iteration, counters,
timestamps). This is intentionally file-based so it survives compaction, can be
inspected with a text editor, and replays trivially.

**Roadmap:** an indexed long-term memory (gstack `gbrain` or equivalent) for
semantic recall across long missions, plus contradiction resolution.

### 3. Tooling and MCP layer

**v0.1:** Claude Code's native tools plus the gstack skill library. Leopold sets
the gstack spawned-session environment so skills auto-decide instead of
prompting. The situation-to-skill map is documented in `gstack-playbook.md` and
applied by the run skill.

**Roadmap:** dynamic MCP server routing and schema sanitization in the driver.

### 4. Guardrails layer

**v0.1:** A `PreToolUse` hook (`guard-irreversible.sh`) inspects every Bash
command and tool call while autonomy is active. Irreversible or destructive
operations (git commit/push, force-push, `reset --hard`, `rm -rf`, `gh pr
create`/`merge`, publish commands) are denied unless an explicit per-session
opt-in token file is present. Stop conditions live in `GUARDRAILS.md` and are
enforced by the Stop hook. See `guardrails.md` for the full model.

**Roadmap:** per-tenant policy, cost/time budgets enforced at the driver level,
and resource allow/deny lists.

### 5. Observability layer

**v0.1:** `DECISIONS.md` (human-readable decision log) and
`.leopold/events.jsonl` (structured event stream: `turn_start`, `decision`,
`item_done`, `stop`, `guard_block`). Enough to reconstruct a run after the fact.

**Roadmap:** an SSE event stream and a web dashboard showing live run state and
the decision log, plus OpenTelemetry spans for each turn and tool call.

### 6. Execution and sandbox layer

**v0.1:** Claude Code's own execution environment and permission system. Leopold
adds a lock on top; it never loosens the underlying sandbox.

**Roadmap:** pluggable E2B / Daytona runners for isolated, parallel worker
execution in the driver.

---

## State on disk

Everything Leopold needs for a run lives under `.leopold/` in the target
project (gitignored by default):

```
.leopold/
  MISSION.md        # what
  CHARTER.md        # how you would choose
  GUARDRAILS.md     # what stays locked
  PLAN.md           # the work queue
  DECISIONS.md      # the audit trail (append-only)
  state.json        # run state: active, iteration, counters, timestamps
  events.jsonl      # structured event stream
  STOP              # kill switch (presence halts the loop)
  ALLOW_GIT         # per-session opt-in token (absent by default)
```

Because state is plain files, a run is fully inspectable, resumable, and
reviewable without any Leopold-specific tooling.

---

## Why in-session first, SDK driver second

The in-session engine proves the hard part (a charter-driven decider plus
state-coupled continuity plus a hard git lock) with zero new infrastructure: it
is skills and hooks. It runs anywhere Claude Code runs. The SDK driver is a
strict superset that adds parallelism, an API surface, richer observability, and
sandboxed workers, for missions that outgrow a single session. Shipping the
in-session engine first means the decision protocol and guardrails are battle-
tested before we wrap them in more machinery.
