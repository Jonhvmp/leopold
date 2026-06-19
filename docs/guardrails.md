# Guardrails

Autonomy is only safe when the dangerous actions cannot happen by accident. This
document defines what Leopold may do on its own, what it may never do without an
explicit human opt-in, and how a run ends.

Guardrails are enforced two ways:
- **By hook** (cannot be rationalized past): the `PreToolUse` gate
  (`guard-irreversible.sh`) blocks forbidden commands at the tool-call layer.
- **By protocol** (the agent's own discipline): the decision protocol and the
  stop conditions.

The hook is the real lock. The protocol is the steering.

**Default vs paranoid.** By default the hook is a **denylist** — everything is allowed
except the forbidden/gated ops below. That list is hardened against evasion (git global
options, absolute paths, long-form and split `rm` flags, `find -delete`/`-exec`,
whitespace/tab tricks) and covered by a red-team suite (`make test-guard`). For maximum
caution, set **`LEOPOLD_PARANOID=1`** to flip the hook into a **deny-by-default
allowlist**: only read/build/test/lint commands and `git add` / read-only `git` pass;
everything else is denied. Paranoid mode is opt-in and best-effort (it keys off the
leading command word); the hardened denylist is the default because it is the more
predictable lock.

---

```mermaid
flowchart TD
    Cmd["tool call during an active run"] --> Type{kind?}
    Type -- "read / edit / build / test / stage" --> Allow([allow])
    Type -- "commit / push / publish" --> Token{opt-in token?}
    Token -- yes --> Allow
    Token -- no --> Deny["deny · log guard_block"]
    Type -- "rm -rf / force-push / reset --hard" --> Deny
    classDef deny fill:#e63946,stroke:#9d0208,color:#fff;
    class Deny deny;
```

## Action classes

### Autonomous (decide and do)

Reversible work inside the repo working tree:

- Read, search, analyze any file.
- Create, edit, delete *untracked* working-tree files the run itself produced.
- Run builds, linters, type checkers, formatters, and test suites.
- Run any gstack skill that does not itself commit or push.
- Stage changes (`git add`) — staging is reversible and does not leave the
  machine.

### Gated (require an explicit per-session opt-in token)

Irreversible or outbound actions. Blocked by the hook unless `.leopold/ALLOW_GIT`
(or the relevant token) is present, which only the human creates:

- `git commit`
- `git push` (and force-push)
- `git reset --hard`, `git clean -fdx`, branch deletion
- `gh pr create`, `gh pr merge`, release creation
- Package publish (`npm publish`, `cargo publish`, `pip upload`, etc.)
- Deploy commands

This is the default-locked set. The user's standing rule — *never commit or push
without explicit confirmation* — is encoded here and enforced by the hook even
in fully autonomous mode.

### Forbidden (never, even with opt-in, autonomously)

- `rm -rf` on anything outside the run's own scratch.
- Editing files outside the target project root.
- Disabling or editing the guardrail hook, `GUARDRAILS.md`, or the permission
  settings.
- Writing secrets, tokens, or credentials to disk or to any outbound request.
- Sending project content to an external service not named in the brief.

---

## Cost — the expensive mistakes

Cost in an autonomous run blows up on **two axes**, and Leopold caps both. (One reported
run: 82 subagents and a 5.9MB session over 681 turns.)

**1. How much context each unit carries.**

- **The main session grows every turn.** On a big-context model it never auto-compacts, so
  each turn re-bills the whole accumulated transcript. `max_context_mb` (default **5**)
  stops the run when the transcript passes that size — the brief persists, so a fresh
  `/leopold-run` resumes from `PLAN.md` with clean context. Bounded, resumable runs beat
  one giant session. The protocol also keeps the orchestrator lean: bulk-output work
  (authoring content, generating files) is delegated to a subagent that **writes to a
  file**, so the output never accumulates in the orchestrator's context — the exact thing
  that blew up a real run (the orchestrator held every lesson it generated).
- **Forks clone the entire session — they ARE the per-subagent leak.** A fork carries the
  full multi-MB parent context into the spawn. `max_forks` is **0 by default (forbidden)**;
  a fresh subagent does the same work with a clean slate. Raise it only for a sub-task that
  genuinely needs the whole conversation.
- **Oversized subagent prompts** mean context is being pasted into the spawn (billed in
  full). The guard denies a subagent prompt over ~256KB — point subagents at file *paths*,
  don't paste files in.

**2. How many subagents are spawned.**

- The model loves to parallelize into bursts of 10+. `max_subagents` (default **8**) is the
  total spawn budget per run; the guard counts spawns in `state.json` and **denies** past
  the cap so the run continues serially. The `/leopold-run` protocol also steers it to work
  serially and never batch-spawn.

Belt and braces: set an **Anthropic spending cap** on your account before long autonomous
runs on large projects. Leopold has no billing limit of its own.

### Watching a run (live dashboard)

`/leopold-watch` (or `make watch`) starts a **local** dashboard at `http://127.0.0.1:4179`
that reads the run's own `.leopold/` files and updates live over SSE. It shows the run
status, the cost meters above (context MB, subagents, forks, iterations, failures — each
against its budget), the live event feed (turns, guard blocks, `subagent_spawn` with size +
fork flag, stops), the decisions log, and a **Stop** button that uses the kill switch. It is
zero-dependency (Python stdlib), read-only except that one button, and binds to loopback —
nothing leaves the machine.

---

## Stop conditions

The run ends, and the Stop hook allows the session to halt, when any of these is
true:

1. **Plan complete** — no unchecked items remain in `PLAN.md`.
2. **Kill switch** — `.leopold/STOP` exists (`/leopold-stop` or `touch`).
3. **Repeated failure** — the same test or build has failed N consecutive turns
   (default 3). Escalate, do not keep hammering.
4. **Loop detection** — if the set of open `PLAN.md` items is byte-identical for
   `max_no_progress` consecutive turns (default 6 — nothing checked off, nothing
   added), the run is thrashing and stops with reason `no_progress`.
5. **Budget exhausted** — the iteration counter or a token/time budget set in
   `GUARDRAILS.md` is reached.
6. **Context budget** — the transcript passed `max_context_mb` (default 5). Resume
   with a fresh `/leopold-run`; the brief continues it with clean context.
7. **Irreversible + ambiguous fork** — the decision protocol routed a fork to
   the human.

Every stop writes a final summary to the run output and a `stop` event to
`events.jsonl`, naming which condition fired.

---

## The kill switch

Two ways to stop a run at the next turn boundary:

- `/leopold-stop` — the clean way; flips `state.json` to inactive and writes a
  summary.
- `touch .leopold/STOP` — the blunt way; the Stop hook sees the file and halts.

Neither interrupts work mid-turn; both take effect when the current turn
finishes, so nothing is left half-done.

---

## Opting in to git (when you actually want commits)

If you want a run to commit checkpoints on its own, you opt in explicitly and
per session:

```bash
touch .leopold/ALLOW_GIT      # allow commit only
```

Push, force-push, PR creation, and publish remain blocked even with
`ALLOW_GIT`; those require their own tokens (`ALLOW_PUSH`, etc.) and are off by
default. The default posture, and the recommended one, is: Leopold stages and
reports, you commit and push.

---

## Defaults

| Setting              | Default | Where to change          |
|----------------------|---------|--------------------------|
| Commit               | locked  | `touch .leopold/ALLOW_GIT` |
| Push / PR / publish  | locked  | per-token, off by default  |
| Max consecutive fails| 3       | `GUARDRAILS.md`          |
| Max iterations       | 50      | `GUARDRAILS.md`          |
| Subagent spawns/run  | 8       | `max_subagents` in `GUARDRAILS.md` |
| Forks/run            | 0 (off) | `max_forks` in `GUARDRAILS.md` |
| Context budget       | 5 MB    | `max_context_mb` in `GUARDRAILS.md` |
| Edits outside root   | never   | not configurable         |

## Run hygiene and parallel runs

### What is cleared when a run stops

On every stop, Leopold clears the kill switch (`STOP`) and the git opt-in tokens
(`ALLOW_GIT` / `ALLOW_PUSH` / `ALLOW_PUBLISH`). This is a safety property: the
next run starts with git **re-locked** and is not halted by a stale `STOP`. The
durable record (the brief, `DECISIONS.md`, `events.jsonl`) is never deleted.

### on_finish: keep or archive

Set in `GUARDRAILS.md`:

- **`keep`** (default) — the brief, decisions, and events stay in `.leopold/`.
- **`archive`** — on a clean finish (plan complete), `DECISIONS.md` and
  `events.jsonl` move to `.leopold/runs/<timestamp>/`, so the next run starts
  with a clean log while the full history is preserved.

Auto-delete is never a default; if you want a fresh start, remove `.leopold/`
yourself.

### One run per checkout

A project supports **one active Leopold run at a time**. Parallel runs in the
same checkout share `.leopold/` (one `state.json`, one `PLAN.md`) and the same
working tree, so they would clobber each other's state and code. `/leopold-run`
refuses to start a second run while another is active (a run idle for 10+ minutes
is treated as stale and can be taken over).

### Running in parallel — use worktrees

True parallelism comes from isolation, not threads: two agents editing the same
files conflict no matter how concurrent the orchestrator is. To run Leopold in
parallel, give each run its own git worktree:

```bash
git worktree add ../proj-leopold-2 && cd ../proj-leopold-2
# now /leopold-brief + /leopold-run here, fully isolated from the first run
```

Each worktree has its own checkout and its own `.leopold/`, so N runs proceed
concurrently without collision. The SDK driver's coordinated multi-worker fan-out
(one worktree or sandbox per worker) is the roadmap path for automated parallel
execution.
