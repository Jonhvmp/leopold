# Harnesses: Claude Code and Codex

Leopold is not a Claude Code plugin that happens to run elsewhere. It is a harness
layer that sits on top of whichever coding agent you use, and today that means
**Claude Code** and **OpenAI Codex CLI**.

The reason this works is not clever abstraction on Leopold's side. It is that Codex
reimplemented Claude Code's hook contract almost verbatim — same event names, same
payload keys, same reply shapes. Leopold's two hooks run on both harnesses as the
exact same shell scripts, unmodified.

## What is already portable

The brief is the whole point of Leopold, and it was never harness-specific:

```
.leopold/
  MISSION.md      what we are doing and why
  CHARTER.md      how to decide when nobody is watching
  GUARDRAILS.md   the budgets and stop conditions
  PLAN.md         the checklist the run burns down
  DECISIONS.md    what got decided, and on what basis
  state.json      run state (active, iteration, budgets)
  events.jsonl    the append-only event log
```

Plain markdown and one JSON file. Nothing in there knows or cares which agent is
reading it. A brief written in Claude Code runs on Codex and vice versa.

## What actually differs

| | Claude Code | Codex CLI |
|---|---|---|
| Home | `~/.claude` | `~/.codex` |
| Skills | `~/.claude/skills/` | `~/.codex/skills/` (same `SKILL.md` format) |
| Settings | `settings.json` (JSON) | `config.toml` (TOML) |
| Project memory | `CLAUDE.md` | `AGENTS.md` |
| Plugin manifest | `.claude-plugin/` | `.codex-plugin/` |
| Headless seam | `@anthropic-ai/claude-agent-sdk` | `codex exec --json` |
| Hooks need trust | no | **yes, once** |

That last row is the only real behavioral difference, and the rest of this page is
mostly about it.

## The hooks are the same scripts

Leopold rides on exactly two hooks.

**`guard-irreversible.sh` (PreToolUse) — the git lock.** It denies `git commit` and
`git push` while a run is active, so the run stages work and you ship it. Codex
delivers PreToolUse with the same keys Claude Code does — `tool_name` (its shell tool
is reported as `Bash`), `tool_input.command`, `cwd`, `transcript_path` — and honors the
same reply:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
 "permissionDecision":"deny","permissionDecisionReason":"…"}}
```

**`stop-continuity.sh` (Stop) — the autonomous engine.** When the agent finishes a
turn it reads `state.json` and `PLAN.md`, and if work remains with no stop condition
met it blocks the halt and re-injects the next instruction. Codex delivers Stop with
`cwd`, `transcript_path` and `stop_hook_active`, and honors the same reply:

```json
{"decision":"block","reason":"…"}
```

So autonomy is not a Claude-only feature. `/leopold-run` keeps a Codex session going
the same way it keeps a Claude Code session going, with the same budgets, the same
no-progress detection, and the same context ceiling.

## The one manual step on Codex

Codex will not execute a hook declared in `config.toml` until you have trusted it
once. Until then it is silently inert — no error, it just does not run.

Leopold does not try to forge that approval. Two ways through it:

1. **Open Codex once and approve the Leopold hooks.** After that the git lock and the
   continuity engine are live in every interactive session.
2. **Install Leopold as a Codex plugin.** Plugin-provided hooks are trusted through
   the plugin install, so there is no separate step.

Headless workers started by `leopold run --provider codex` arm themselves, so a
driver-conducted run is locked from its first turn whether or not you have approved
anything.

`leopold doctor` tells you which state you are in.

## Installing

```bash
./install.sh                     # every harness found on this machine
./install.sh --harness claude    # Claude Code only
./install.sh --harness codex     # Codex only
./install.sh --harness all       # both, installed or not
```

The skills go into each harness's skills directory. The hooks, templates, docs and
extensions go into one shared asset home — `~/.claude/leopold` when Claude Code is in
play (so existing installs keep working), otherwise `~/.codex/leopold`. Override it
with `LEOPOLD_HOME`.

The Codex wiring is written into `config.toml` as a marker-delimited block:

```toml
# >>> leopold (managed) >>>
[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/home/you/.claude/leopold/hooks/guard-irreversible.sh"
timeout = 5

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "/home/you/.claude/leopold/hooks/stop-continuity.sh"
timeout = 15
# <<< leopold (managed) <<<
```

Re-installing replaces the block and nothing else. Your config is backed up first,
and the merged file is validated — if it would not parse, the install rolls back and
prints the block for you to paste yourself.

## Extensions install on every harness you have

The four bundled extensions — `serena`, `enhance`, `ovmem`, `gstack` — are not
Claude-only either. Each one installs, reports and cleans up **per harness**:

| Extension | Claude Code | Codex CLI |
|---|---|---|
| serena | `claude mcp add --scope user` + 4 hooks in `settings.json` | `codex mcp add` + the same 4 hooks in `config.toml`, `--context=codex`, `serena-hooks --client=codex` |
| enhance | `UserPromptSubmit` in `settings.json`, plain-text injection | `UserPromptSubmit` in `config.toml`, JSON `hookSpecificOutput.additionalContext` |
| ovmem | 4 hooks in `settings.json`, in-process 25s flush | the same 4 in `config.toml`; `SessionEnd` declared at 3s and the flush detached, because Codex hard-caps that hook at 3 seconds |
| gstack | `./setup --host claude` → `~/.claude/skills` | `./setup --host codex` → `~/.codex/skills` (checkout in `~/.gstack/repos/gstack`) |

Two rules hold across all four. **One writer per format:** the JSON and TOML
wiring lives in a single shared helper, `extensions/lib/harness.sh`, so the two
harnesses cannot silently drift apart. And **nothing reports per machine:**
`status`, `remove` and `doctor` answer one line per harness, so a two-harness box
never sees one harness's state passed off as both, and Codex's hook-trust gate is
named instead of being shown as a green that is not live yet.

```bash
bash extensions/serena/manage.sh doctor   # or ovmem / gstack / enhance
leopold doctor                            # every harness present, in one pass
```

The engine data is shared even though the wiring is not: ovmem keeps one memory
directory for the machine, so a decision recorded in a Codex session comes back in
a Claude Code one, and the enhancer's ledger and prompt profile are the same files
from either seat.

Each suite is hermetic — temp `HOME`/`CLAUDE_HOME`/`CODEX_HOME`, stubbed CLIs, no
network: `make serena-test`, `make ovmem-test`, `make gstack-test`,
`make enhance-test`, plus `make codex-install-test` for the whole Codex install
end to end.

## The dashboard reads Codex runs

`leopold watch` shows real tokens, cost and context on a Codex run — the panel is
not blank and, more importantly, never a zero.

It finds the transcript the same way on both harnesses: the path the hook reported
in `state.json`, or else the newest session for this project — a Claude Code
transcript under `~/.claude/projects/`, or a Codex rollout under
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose `session_meta.cwd` is this
project. It then sniffs which one it is and parses accordingly: Claude Code's
per-message `usage` + `model`, or Codex's `event_msg` lines with
`payload.type == "token_count"` (`info.total_token_usage`, including
`cached_input_tokens` and `reasoning_output_tokens`).

Codex reports tokens and never dollars, so cost is priced from a built-in
per-model table, cached input billed at 0.1x. An unrecognized model falls back to
a non-zero default rate: a run priced at zero would silently disable
`--budget-usd`, the one failure a budget cannot have. And a live rollout that has
not reported usage yet says **"waiting for session data…"** rather than quoting
`$0.00`.

Extension dashboard tabs follow the same rule. An `extension.json`
`dashboard.module` may be a path relative to the asset home (`ovmem/dashboard.py`),
resolved Claude-first exactly like the installers do — so the Memory tab shows up
on a machine with no `~/.claude` instead of silently vanishing.

Covered by `make watch-test` (stdlib only, no network), which asserts Codex
detection, pricing, discovery by `cwd`, the unknown-model fallback and the
no-usage-yet case.

## Choosing a harness for a run

```bash
leopold harness                    # what is here, and what each one can do
leopold run                        # conduct on the default harness
leopold run --provider codex       # conduct on Codex
LEOPOLD_PROVIDER=codex leopold run # same, from the environment
```

Precedence is `--provider` → `LEOPOLD_PROVIDER` → whatever is installed → Claude Code
as the tie-break. A name Leopold does not recognize is an error, not a silent
fallback — conducting a run on the wrong harness because of a typo is not a failure
mode worth having.

## How the driver reaches each harness

Everything in the driver — worker turns, conductor decisions, review lenses,
hypothesis panels, routing, tournament judges — goes through one seam,
`packages/driver/src/sdk.ts`, and consumes one small message shape. The provider
behind that seam is swappable:

- **claude** — the Agent SDK's `query`, on your own Claude Code auth.
- **codex** — `codex exec --json`, on your own Codex login. Multi-turn items use
  `codex exec resume <thread_id>`, which gives the worker the same property that
  matters: fresh context per plan item, continuous context within one.

Because the shape is identical, no call site knows which harness answered. The
mapping the Codex side has to do is small and lives in one file:

| Driver concept | Codex |
|---|---|
| `cwd` | `-C <dir>` |
| `model` | `-m <model>` |
| `effort` | `-c model_reasoning_effort=…` (`max` → `xhigh`) |
| read-only session (`disallowedTools`) | `--sandbox read-only` |
| `canUseTool` guard | the PreToolUse hook + `--dangerously-bypass-hook-trust` |
| `total_cost_usd` | token usage priced by model |

That last one is worth knowing about: Codex reports token counts, never a dollar
figure, so `--budget-usd` prices the run from a built-in table. An unrecognized model
falls back to a default rate rather than zero — pricing a run at zero would silently
disable the budget, which is the one failure mode a budget cannot have.
