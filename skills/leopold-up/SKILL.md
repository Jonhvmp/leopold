---
name: leopold-up
version: 0.1.0
description: "Phase 0 of Leopold. One-shot setup that makes a project extract the most from Claude Code: generates CLAUDE.md (/init), teaches Claude how to build/run the app (/run-skill-generator), verifies MCP + permissions, then hands off to /leopold-brief. Run this once per project."
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
a fraction of what Claude Code offers — no project memory, no run-skill, a permission
flood, MCP unconfigured. Your job is to fix all of that in one pass so the autonomous
run (and the human's normal sessions) start from the strongest possible footing.

Work top to bottom. Skip a step only if it is already done; say so and move on. Do not
ask the user to do anything you can do yourself.

## 1. Project memory — CLAUDE.md

If there is no `CLAUDE.md` (or `.claude/CLAUDE.md`) at the project root, run the native
**`/init`** skill to generate one (it documents the build, test, and architecture so every
future session starts informed). If one already exists, read it and offer to enrich any
obvious gaps (test command, conventions, key directories) — don't rewrite what's there.

## 2. Teach Claude to run the app — the run-skill

Run **`/run-skill-generator`** so Claude learns how to build, start, and drive *this*
project's app from a clean environment (build command, env vars, ports). This is what makes
the run-time review gate real: with a run-skill present, the autonomous run can `/verify` a
change by actually exercising the app, not just passing tests. If the project is a pure
library/CLI with nothing to "run", note that and skip.

## 3. Permissions — kill the prompt flood

If `leopold up` was run from the CLI it already seeded a per-project allowlist. Confirm
`.claude/settings.json` has a sensible `permissions.allow` for routine dev (read/grep, the
build/test/lint commands, read-only git, `git add`). If it's missing or thin, add it with the
**update-config** skill (or edit `.claude/settings.json` directly). The Leopold guard still
locks `git commit`/`push` during a run regardless, so a generous allowlist is safe.

## 4. MCP + extensions

Check which power tools are connected and offer the ones that aren't:
- **Serena** (LSP code navigation) — by far the biggest token saver for real codebases.
- **ovmem** (long-term memory) and **gstack** (planning/QA skills the run conducts).

List what `/mcp` shows and what `leopold-driver doctor` reports; install missing ones via
`leopold-driver serena|ovmem|gstack install` (ask first — these touch the home dir / network).

## 5. Effort default

Suggest setting a sensible default reasoning effort for the project via `/effort` (e.g.
`medium` for app work, `high` for a security/billing-heavy codebase). Per-item effort is set
automatically during a run, but the human's own sessions benefit from a good default.

## 6. Hand off

Finish with a short summary of what you set up and what was already in place, then point the
user at the next step:

> Setup done. Run **/leopold-brief** to debate the mission and write the brief, then
> **/leopold-run** to hand Leopold the seat (autonomous, reviewed, git-locked). Use
> `leopold-driver run --parallel 3` for independent plan items, and `leopold-driver insights`
> to see where a run spent its effort.

Do not start a brief or a run yourself — Phase 0 ends at the hand-off.
