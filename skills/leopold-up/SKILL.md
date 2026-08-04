---
name: leopold-up
version: 0.1.0
description: "Phase 0 of Leopold. One-shot setup that makes a project extract the most from the harness (Claude Code or Codex CLI): generates the project memory file (/init), teaches the agent how to build/run the app (/run-skill-generator), verifies MCP + permissions, then hands off to /leopold-brief. Run this once per project."
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Skill
  - AskUserQuestion
triggers:
  - leopold up
  - set up leopold
  - leopold setup
  - bootstrap leopold
---

# /leopold-up

You are running **Phase 0 of Leopold**: the one-command onboarding. Most people use
a fraction of what their harness offers — no project memory, no run-skill, a permission
flood, MCP unconfigured. Your job is to fix all of that in one pass so the autonomous
run (and the human's normal sessions) start from the strongest possible footing.

First, note which harness you are: **Claude Code** or **Codex CLI**. Every step below
names both equivalents; do the one that matches. Skills written `/name` are slash
commands on Claude Code; on Codex invoke the same skill as `$name` or by naming it in
plain text.

Work top to bottom. Skip a step only if it is already done; say so and move on. Do not
ask the user to do anything you can do yourself.

## 1. Project memory — the agent memory file

Claude Code reads `CLAUDE.md` (or `.claude/CLAUDE.md`); Codex CLI reads `AGENTS.md`.
If the one for your harness is missing at the project root, run the native **`/init`**
command — both harnesses have it, and each writes its own file — so the build, test and
architecture are documented and every future session starts informed. If one already
exists, read it and offer to enrich any obvious gaps (test command, conventions, key
directories) — don't rewrite what's there. If the *other* harness's file exists and
yours doesn't, offer to derive yours from it instead of starting blank.

## 2. Teach the agent to run the app — the run-skill

Run **`/run-skill-generator`** (`$run-skill-generator` on Codex) so the agent learns how
to build, start, and drive *this*
project's app from a clean environment (build command, env vars, ports). This is what makes
the run-time review gate real: with a run-skill present, the autonomous run can `verify` a
change by actually exercising the app, not just passing tests. If the project is a pure
library/CLI with nothing to "run", note that and skip.

## 3. Permissions — kill the prompt flood

**Claude Code.** If `leopold up` was run from the CLI it already seeded a per-project
allowlist. Confirm `.claude/settings.json` has a sensible `permissions.allow` for routine
dev (read/grep, the build/test/lint commands, read-only git, `git add`). If it's missing
or thin, add it with the **update-config** skill (or edit `.claude/settings.json`
directly).

**Codex CLI.** There is no per-command allowlist; approvals are a mode. Point the user at
**`/permissions`** in the TUI to pick what Codex may do without asking, or set
`approval_policy` / `sandbox_mode` in `config.toml` under the Codex home
(`${CODEX_HOME:-$HOME/.codex}`) — `sandbox_mode = "workspace-write"` plus
`approval_policy = "on-request"` is the sane dev default. Say which you recommend and
why; don't edit their `config.toml` unasked.

Either way the Leopold guard still locks `git commit`/`push` during a run, so a generous
allowlist or a permissive approval mode is safe.

## 4. MCP + extensions

Check which power tools are connected and offer the ones that aren't:
- **Serena** (LSP code navigation) — by far the biggest token saver for real codebases.
- **ovmem** (long-term memory) and **gstack** (planning/QA skills the run conducts).

List the connected servers — `/mcp` on Claude Code, `codex mcp list` on Codex — plus what
`leopold-driver doctor` reports; install missing ones via
`leopold-driver serena|ovmem|gstack install` (ask first — these touch the home dir /
network). The extensions wire themselves into whichever harnesses are present, so this
step is the same product on both.

## 5. Effort default

Suggest a sensible default reasoning effort for the project (e.g. `medium` for app work,
`high` for a security/billing-heavy codebase): `/effort` on Claude Code, `/model` on Codex
(it picks model *and* reasoning effort) or `model_reasoning_effort` in the Codex
`config.toml`. Per-item effort is set automatically during a run, but the human's
own sessions benefit from a good default.

## 6. Hand off

Finish with a short summary of what you set up and what was already in place, then point the
user at the next step:

> Setup done. Run **/leopold-brief** to debate the mission and write the brief, then
> **/leopold-run** to hand Leopold the seat (autonomous, reviewed, git-locked). Use
> `leopold-driver run --parallel 3` for independent plan items, and `leopold-driver insights`
> to see where a run spent its effort.

Do not start a brief or a run yourself — Phase 0 ends at the hand-off.
