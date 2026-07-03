<p align="center">
  <img src="assets/demo.svg" alt="Leopold conducting a run: brief → run → decisions logged → staged, awaiting your commit" width="760" />
</p>

# Leopold

**Brief it like a teammate. It conducts Claude Code in your seat.**

<p align="center">
  <a href="https://github.com/Jonhvmp/leopold/actions/workflows/ci.yml"><img src="https://github.com/Jonhvmp/leopold/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/leopold-driver"><img src="https://img.shields.io/npm/v/leopold-driver?label=leopold-driver" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Jonhvmp/leopold" alt="license" /></a>
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/works%20with-Claude%20Code-d97757" alt="works with Claude Code" /></a>
  <a href="https://github.com/Jonhvmp/leopold/stargazers"><img src="https://img.shields.io/github/stars/Jonhvmp/leopold?style=social" alt="stars" /></a>
</p>

<p align="center">
  <img src="assets/leopold.gif" alt="Leopold the conductor (Bugs Bunny, Long-Haired Hare, 1949)" width="380" />
</p>

Leopold is an autonomous orchestration harness for [Claude Code](https://claude.com/claude-code). You debate the work with it — goals, constraints, taste, what "done" means — and that becomes a durable brief. Then it takes the seat and drives Claude Code continuously, deciding the way you would instead of stopping at every fork, until the plan is done or a stop condition fires — **with your git locked the whole time.**

> The name nods to Bugs Bunny: in *Long-Haired Hare* (1949) he seizes the podium as the conductor **Leopold** and runs the orchestra with a wave of the baton. You are the composer, Leopold the conductor, Claude Code the orchestra.

> **Status: alpha.** The in-session engine (skills + hooks) works today; the SDK driver (`packages/driver/`) typechecks against the Agent SDK. See [Roadmap](#roadmap).

---

## Quickstart

```bash
# from npm — no clone, no make. `leopold up` installs the harness + sets up the project.
npm i -g leopold-driver && leopold up
```

```bash
# or the one-line installer
curl -fsSL https://raw.githubusercontent.com/Jonhvmp/leopold/main/install.sh | bash
```

Either way, the skills + hooks land in `~/.claude/` and the `settings.json` snippet is
merged. With the npm package, the bundled `leopold` CLI runs the whole toolchain **without
the repo**:

```bash
leopold up                   # install + project setup in one (then /leopold-up in a session)
leopold menu                 # toolchain manager (serena / gstack / ovmem)
leopold watch                # live dashboard at http://127.0.0.1:4179
leopold run --parallel 3     # conduct the run, independent items in parallel
leopold insights             # summarize a run (effort mix, review pass-rate, spend)
leopold doctor               # health check
```

<details><summary>Other ways to install</summary>

```bash
# clone (transparent)
git clone https://github.com/Jonhvmp/leopold.git && cd leopold && ./install.sh
# as a Claude Code plugin (auto-wires skills + hooks)
claude plugin marketplace add Jonhvmp/leopold && claude plugin install leopold@leopold
```
</details>

Then, in any project:

```
/leopold-brief    # debate the mission, write the brief (plan by tournament on big missions)
/leopold-run      # hand over the seat (single-context loop)
/leopold-workflow # compile the brief into a dynamic workflow and run it
/leopold-learn    # mine your decisions + sessions → proposed charter amendments
/leopold-triage   # triage a backlog (quarantined classifiers, dedupe, fix plans)
/leopold-watch    # live web dashboard: cost meters, events, decisions, Stop
/leopold-status   # see where it is (terminal)
/leopold-stop     # take the seat back
```

> The cast at the top is a scripted walkthrough ([regenerate it](scripts/record-demo.sh)).
> For a full reproducible run — a real brief and the `DECISIONS.md` it produced — see
> [`examples/add-json-output/`](examples/add-json-output/).

---

## How it works

**Phase 1 — Brief (`/leopold-brief`).** A structured debate, not a form. Leopold pushes back and writes four durable artifacts: `MISSION.md` (what + definition of done), `CHARTER.md` (your priorities, taste, hard *never*/*always* rules — the part that "becomes you"), `GUARDRAILS.md` (autonomous vs gated, stop conditions, kill switch), and `PLAN.md` (the backlog). The run's quality is capped by the brief's, so this phase matters.

**Phase 2 — Run (`/leopold-run`).** Leopold loops: pick the next `PLAN.md` item → do the work, reaching for the right [gstack](https://github.com/garrytan/gstack) skill → at a fork, consult `CHARTER.md`; if the call is reversible and the charter is clear, **decide, log it to `DECISIONS.md`, and keep going** → mark it done, pick the next. A **Stop hook** re-injects "continue" while work remains; a **PreToolUse guard** keeps `git commit`/`push` locked. Everything it decided for you is in `DECISIONS.md` to review.

**Phase 2, the workflow way (`/leopold-workflow`).** Same brief, stronger engine. Leopold **compiles the brief into a [dynamic workflow](https://code.claude.com/docs/en/workflows)** — a JavaScript harness Claude Code's runtime runs in the background. The plan lives in *code* instead of one growing context window, so the run doesn't drift into agentic laziness, self-preferential bias, or goal drift on a long plan. `PLAN.md` becomes dependency-ordered waves; each item gets an **independent** adversarial reviewer (a panel with a security lens on critical items) that did not write the code it judges. The run is **resumable** and streams a live phase tree into `/workflows`. Git is locked for free — a workflow can't commit; it stages, you commit. Saving the compiled script (`.claude/workflows/leopold-run.js`) turns the brief into a harness you can read, diff, and re-run. Use `/leopold-run` for a short or interactive plan; reach for `/leopold-workflow` when the plan is large or parallelizable.

---

## Quality & orchestration

Leopold extracts the most from Claude Code's native power, in one command. See [Quality & Orchestration](docs/quality-and-orchestration.md).

- **A panel of skeptics on every item.** Before an item closes, a diverse-lens review panel passes over its diff — correctness always, +security on sensitive diffs, +does-it-actually-work on critical items. Each panelist is an independent session that did *not* write the code; blocking findings are unioned and go back to the worker until the panel is clean. Diversity beats redundancy: different lenses catch failure modes identical reviewers structurally miss.
- **Root-cause panel when an item is stuck.** A failed item isn't just retried: three investigators form hypotheses over *disjoint* evidence (the diff, the verification output, the item's assumptions vs the codebase), refuters try to kill each one, and the surviving theory becomes a concrete lead for the next attempt — the structural fix for an agent doubling down on its own wrong theory.
- **Effort by risk — keywords or research.** Each item is classified and the worker's reasoning effort is set automatically — `low` for a typo, `max` for a migration or payment change. `--smart-routing` upgrades this: a short read-only session researches the item's *real* blast radius (how many callers, what it touches) before routing; it always falls back to the deterministic classifier and never lowers a critical floor.
- **A charter that learns you (`/leopold-learn`).** Your recorded behavior beats your self-description: independent miners sweep the decision log, your session corrections, and git history for recurring judgment calls; a skeptic kills the weak candidates; the survivors become proposed charter amendments you review. Each pass makes the next run decide more like you. The SDK driver can close this loop automatically — `learn_on_finish: on` (or `--learn-on-finish`) mines each clean run into `CHARTER-amendments.md` the moment it finishes, without ever editing the charter itself.
- **Parallel items.** `leopold-driver run --parallel N` runs independent plan items at once, each in its own worktree, replaying each diff onto the main tree (staged, never committed). Declare order with `- [ ] (after: 2) …`.
- **One-command setup.** `leopold up` + `/leopold-up` wire the things people skip — `CLAUDE.md` (`/init`), an app run-skill (`/run-skill-generator`), a permissions allowlist, MCP — so a project starts at full power.
- **Insights.** `leopold-driver insights` summarizes a run: effort mix, review pass-rate, decisions, escalations, real spend.

---

## Safety — autonomy you can trust

Because Leopold sells autonomy, guardrails are the product, not an afterthought.

- **Git stays locked.** `git commit` and `git push` (force-push always) are blocked while autonomous — regardless of permission mode. That's the whole lock: the run stages and reports, you commit and push. You opt in explicitly, per run (`ALLOW_GIT` / `ALLOW_PUSH`), or they never run. Everything else — edits, builds, tests, `rm`, refactors, subagents — is the run's own call; isolate with `--worktree` if you want a filesystem boundary.
- **Red-teamed.** The guard ships a bypass-attempt test suite (`make test-guard`), plus unit tests for the TS driver guard, covering evasion tricks like `git -c user.name=x commit`, `/usr/bin/git push`, `env git commit`, and whitespace/tab splitting. Think you can slip a commit or push past it? [Open an issue](https://github.com/Jonhvmp/leopold/issues) — break it.
- **Cost-capped.** A long autonomous run runs up a bill because the main session re-bills its growing context every turn. Leopold's dependable ceiling is the **`--budget <usd>` hard-stop** (stops the moment real spend crosses it), backed by a bounded, resumable loop (`max_iterations`, resume fresh from the brief). The protocol keeps the orchestrator lean — bulk-output work is delegated to subagents that **write to files**, so output never piles up in the main context.
- **Fails closed.** A malformed run-state file blocks loudly; it never silently lets autonomy through.
- **Kill switch + audit.** `/leopold-stop` (or `touch .leopold/STOP`) halts at the next turn boundary; every autonomous decision is logged with its reasoning.

Leopold never weakens Claude Code's own permissions — it adds a second lock on top. Details: [`docs/guardrails.md`](docs/guardrails.md).

---

## What is a harness?

`Agent = Model + Harness` — everything around the model: orchestration, memory, guardrails, observability. Claude Code is a great harness for one *interactive* turn. Leopold adds the layer it lacks for *unattended* work: a **decider** (your charter, so it chooses instead of asking), **continuity** (a stop hook, so a finished turn rolls into the next item), behind **guardrails** (the gate above). More in [What is a harness](https://jonhvmp.github.io/leopold/concepts/harness/).

## gstack + the toolchain manager

[gstack](https://github.com/garrytan/gstack) is a battle-tested suite of Claude Code skills (`/spec`, `/code-review`, `/qa`, `/ship`, `/investigate`, …). Leopold doesn't replace it — it **conducts** it: gstack skills auto-switch to "pick the recommended option and report" inside an orchestrator, so the whole toolchain runs autonomously. Optional, but it's where planning shines (`/autoplan`, `/plan-*-review`).

A small interactive menu installs and manages the toolchain + companion extensions:

```bash
make menu     # or: bash ~/.claude/leopold/scripts/leopold-menu.sh
```

Each component lives under [`extensions/`](extensions/) (an `extension.json` + a `manage.sh`). Built in:

- **serena** (mandatory) — [LSP code intelligence](https://github.com/oraios/serena) over MCP: symbol-level retrieval + editing instead of grep/whole-file reads. Set up automatically by the installer (`make serena-install`); it's the biggest lever for both code quality and lean context (fewer tokens per op).
- **gstack** — the planning/QA skill suite Leopold conducts.
- **ovmem** — autonomous RAG long-term memory (OpenViking + 4 hooks; OpenAI or AWS Bedrock; runs entirely on `127.0.0.1`).

Walkthrough: [Toolchain Manager](docs/getting-started/toolchain-manager.md).

---

## Architecture at a glance

| Harness layer | v0.1 (in-session) | Roadmap (SDK driver) |
|---|---|---|
| Orchestration | Stop hook loop + `PLAN.md` | DAG executor, multi-worker waves |
| Memory / Context | Brief artifacts (the "System of Context") | + indexed long-term memory |
| Tooling / MCP | gstack skills + Claude Code tools | + dynamic MCP routing |
| Guardrails | PreToolUse gate + stop conditions | + per-tenant policy, budgets |
| Observability | `DECISIONS.md` + JSONL event log | SSE event stream + dashboard |
| Execution / Sandbox | Claude Code's own sandbox | E2B / Daytona runners |

Full design in [`docs/architecture.md`](docs/architecture.md).

## Roadmap

- [x] In-session engine: skills + Stop/PreToolUse hooks
- [x] `leopold doctor` — verify install, hooks, gstack wiring
- [x] Guard red-team suite — bypass attempts blocked in CI
- [x] SDK driver — external orchestrator on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk), shipped on npm as `leopold-driver`
- [x] SDK driver unit tests (status parser + `canUseTool` guard)
- [ ] Multi-worker fan-out, web dashboard for the decision log

---

## Documentation

Full docs (Material + Mermaid): **https://jonhvmp.github.io/leopold/** — [Quickstart](https://jonhvmp.github.io/leopold/getting-started/quickstart/) · [What is a harness](https://jonhvmp.github.io/leopold/concepts/harness/) · [Architecture](https://jonhvmp.github.io/leopold/architecture/) · [Leopold vs Ralph](https://jonhvmp.github.io/leopold/comparisons/ralph/)

## License

MIT. See [LICENSE](LICENSE).

<p align="center">
  <a href="https://www.star-history.com/?type=date&repos=Jonhvmp%2Fleopold">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Jonhvmp/leopold&type=date&theme=dark&legend=top-left" />
      <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Jonhvmp/leopold&type=date&legend=top-left" width="600" />
    </picture>
  </a>
</p>
