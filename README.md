# Leopold

**Brief it like a teammate. It conducts Claude Code in your seat.**

Leopold is an autonomous orchestration harness for [Claude Code](https://claude.com/claude-code). You sit down and debate the work with it the way you already debate with Claude Code: goals, constraints, taste, what "done" means. That conversation becomes a durable brief. Then Leopold takes the seat and drives Claude Code continuously, deciding the way you would, instead of stopping to ask you at every fork.

It is built to keep going: think, research, wait on long tasks, pick the next item, decide, log the decision, repeat, until the plan is done or a stop condition fires. Your git stays locked the whole time.

> The name is a tip of the hat to Bugs Bunny. In *Long-Haired Hare* (1949), Bugs takes the podium disguised as the great conductor **Leopold** and runs the whole orchestra with a wave of the baton. That is the job: you are the composer, Leopold is the conductor, Claude Code is the orchestra.

> Status: **alpha**. The in-session engine (skills + hooks) works today. The external SDK driver (`packages/driver/`) is built and typechecks against the Agent SDK (alpha). See [Roadmap](#roadmap).

---

## What is a harness, and why does this one matter

In current usage, an *agent harness* is everything wrapped around the model except the model itself: tool execution, memory and state, orchestration, guardrails, and observability. Put simply, `Agent = Model + Harness`. A good harness is what turns a general LLM into a system that can run long, complex workflows reliably, and it can be the difference between a model that quits after one turn and one that finishes the job.

Claude Code is already a strong harness for a *single interactive turn*. Leopold adds the layer it is missing for *unattended, long-running work*:

- a **decider** (your charter) so the agent has the authority to choose instead of asking, and
- **continuity** (a stop hook) so a finished turn rolls into the next item instead of halting,
- behind **guardrails** (a tool-call gate) so autonomy never touches your git.

---

## The problem

A normal Claude Code session is a conversation. It pauses at every decision: "approach A or B?", "should I commit?", "do the next item or stop?". That is the right default when a human is watching. It is the wrong default when you want a session to run for an hour while you do something else.

The pauses come from three different places, and each needs a different fix:

1. **Safety defaults** — commit, push, and destructive actions ask first. Correct, and Leopold keeps them locked.
2. **No designated decider** — "approach A or B" is a *product* call. Without your judgment encoded, the agent has no authority to choose, so it asks.
3. **No continuity** — when a batch finishes, stopping is the default. Nothing tells the session to pick up the next thing.

Leopold flips levers 2 and 3 while respecting lever 1.

---

## How it works

Two phases.

### Phase 1 — Brief (`/leopold-brief`)

A structured debate, not a form. You talk through the mission; Leopold pushes back, asks the sharp questions, and writes four durable artifacts:

- **`MISSION.md`** — what we are building, why, and the definition of done.
- **`CHARTER.md`** — your decision charter: priorities, taste, hard *never* / *always* rules, risk tolerance. This is the part that "becomes you."
- **`GUARDRAILS.md`** — what is autonomous vs gated, stop conditions, budgets, the kill switch.
- **`PLAN.md`** — the backlog the autonomous run will burn down.

You can debate, revise, and re-run this until the brief reflects how you actually think. The quality of the autonomous run is capped by the quality of the brief, so this phase matters.

### Phase 2 — Run (`/leopold-run`)

Leopold enters autonomous mode and conducts Claude Code in a loop:

1. Read `PLAN.md`, pick the next unchecked item.
2. Do the work, reaching for the right [gstack](https://github.com/garrytan/gstack) skill for the situation (`/spec` before building, `/code-review` after, `/verify` to confirm, `/investigate` when stuck).
3. Hit a fork? Consult `CHARTER.md`. If the call is reversible and the charter is clear, **decide, log it to `DECISIONS.md`, and keep going**. Only a genuinely irreversible *and* ambiguous fork stops the run.
4. Mark the item done, pick the next.

A **Stop hook** is what makes it continuous: when Claude finishes a turn, the hook checks the plan and the stop conditions, and if work remains it re-injects "continue". A **PreToolUse hook** keeps commit, push, and destructive commands locked even while autonomous.

Every decision Leopold makes on your behalf lands in `DECISIONS.md`, so you can review what "you" decided while you were away.

---

## Why it is built on gstack

[gstack](https://github.com/garrytan/gstack) is a battle-tested library of Claude Code skills (`/spec`, `/code-review`, `/qa`, `/ship`, `/investigate`, and more). Leopold does not replace it. It conducts it.

Two integration points make this clean:

- **Spawned-session protocol.** gstack skills already detect when they run inside an AI orchestrator and switch from "ask the user" to "auto-pick the recommended option and report". Leopold sets that environment, so the entire gstack toolchain runs autonomously without modification.
- **Decision principles.** gstack's `autoplan` encodes six principles for auto-answering review questions. Leopold generalizes that idea into a project-wide decision protocol grounded in *your* charter. See [`docs/decision-protocol.md`](docs/decision-protocol.md).

gstack is optional. Without it, Leopold still orchestrates plain Claude Code. With it, Leopold plays the full toolchain like a senior engineer would. The situation-to-skill map lives in [`docs/gstack-playbook.md`](docs/gstack-playbook.md).

---

## Quickstart

```bash
git clone https://github.com/Jonhvmp/leopold.git
cd leopold
./install.sh
```

`install.sh` copies the skills into `~/.claude/skills/`, the hooks into `~/.claude/leopold/hooks/`, and prints the `settings.json` snippet to merge (or merges it for you).

Then, in any project:

```
/leopold-brief    # debate the mission, write the brief
/leopold-run      # hand over the seat
/leopold-status   # see where it is
/leopold-stop     # take the seat back
```

---

## Safety

Leopold is autonomous by design, which makes guardrails the most important part of it, not an afterthought.

- **Git stays locked.** Commit, push, force-push, `reset --hard`, `rm -rf`, `gh pr create/merge`, and publish commands are blocked while autonomous, regardless of permission mode. You opt in explicitly, per session, or they never run. See [`docs/guardrails.md`](docs/guardrails.md).
- **Stop conditions.** The run ends on: plan complete, kill switch, repeated test failures, loop detection, or iteration/token budget exhausted.
- **Kill switch.** `/leopold-stop` (or `touch .leopold/STOP`) halts the loop at the next turn boundary.
- **Full audit trail.** Every autonomous decision is logged with its reasoning in `DECISIONS.md`.

Leopold never weakens Claude Code's own permission system. It adds a second lock on top.

---

## Architecture at a glance

Leopold maps onto the standard harness layers. The v0.1 in-session engine implements the orchestration, memory, guardrails, and observability layers entirely through Claude Code's own skills and hooks. The SDK driver (`packages/driver/`) adds the API and sandbox layers.

| Harness layer | v0.1 (in-session) | Roadmap (SDK driver) |
|---|---|---|
| Orchestration | Stop hook loop + `PLAN.md` | DAG executor, multi-worker waves |
| Memory / Context | Brief artifacts (the "System of Context") | + indexed long-term memory |
| Tooling / MCP | gstack skills + Claude Code tools | + dynamic MCP routing |
| Guardrails | PreToolUse gate + stop conditions | + per-tenant policy, budgets |
| Observability | `DECISIONS.md` + JSONL event log | SSE event stream + dashboard |
| Execution / Sandbox | Claude Code's own sandbox | E2B / Daytona runners |

Full design in [`docs/architecture.md`](docs/architecture.md).

---

## Roadmap

- [x] In-session engine: skills + Stop/PreToolUse hooks (the v0.1 you are reading)
- [ ] `leopold doctor` — verify install, hooks, and gstack wiring
- [x] SDK driver (v0.1 built — see `packages/driver/`): an external orchestrator on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) that spawns Claude Code as a worker, detects "asking" / "waiting" states, and auto-responds from a founder persona built off the charter
- [ ] gstack playbook router as a first-class config
- [ ] Multi-worker fan-out for large missions
- [ ] Web dashboard for the decision log and live run state

---

## Documentation

Full docs (Material + Mermaid): **https://jonhvmp.github.io/leopold/**

- [Quickstart](https://jonhvmp.github.io/leopold/getting-started/quickstart/)
- [What is a harness](https://jonhvmp.github.io/leopold/concepts/harness/)
- [Architecture](https://jonhvmp.github.io/leopold/architecture/)
- [Leopold vs Ralph](https://jonhvmp.github.io/leopold/comparisons/ralph/)

Run the docs locally: `pip install -r requirements-docs.txt && mkdocs serve`

---

## License

MIT. See [LICENSE](LICENSE).
