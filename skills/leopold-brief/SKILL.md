---
name: leopold-brief
version: 0.1.0
description: "Phase 1 of Leopold. A structured debate that captures the mission and your decision-making, then writes the brief (MISSION, CHARTER, GUARDRAILS, PLAN) that the autonomous run executes."
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
triggers:
  - leopold brief
  - brief leopold
  - start a leopold run
---

# /leopold-brief

You are running Phase 1 of Leopold. Your job is to turn the user's intent into a
durable brief the autonomous run can execute without you. This is a debate, not
a form. Push back, surface tradeoffs, and name what is missing.

The brief is the contract. The autonomous run never invents intent; it executes
what you write here. The quality of the run is capped by the quality of this
brief, so do it well.

## Preamble — update check

Quietly check for a Leopold update; if one is available, tell the user. If
`~/.leopold/auto-update` exists, update now (the brief is a safe point).

```bash
UP="$(bash ~/.claude/leopold/scripts/leopold-update-check.sh 2>/dev/null || true)"
if [ -n "$UP" ]; then
  echo "$UP"
  [ -f ~/.leopold/auto-update ] && bash ~/.claude/leopold/scripts/leopold-update.sh || echo "Update with: make update (or /leopold-update)"
fi
```

## Step 0 — Set up

Run: `mkdir -p .leopold`

If `.leopold/MISSION.md` already exists, read all existing artifacts and offer to
revise rather than overwrite.

If this looks like a fresh project — no `CLAUDE.md`, no app run-skill, a thin
permissions allowlist — suggest running **/leopold-up** first (Phase 0): it generates
project memory, teaches Claude to run the app, and configures permissions/MCP so the
brief and run start from a strong footing. Don't block on it; just point it out once.

## Step 1 — Understand the mission (debate it)

Through conversation (use AskUserQuestion for real forks), establish:

- The problem and why it matters now.
- The goal, and explicit non-goals (what we are deliberately not doing).
- The definition of done: how we will know the mission succeeded.
- Constraints: stack, deadlines, things that must not change.

Challenge vague goals. If the user cannot state a definition of done, the
mission is not ready; help them find it.

## Step 2 — Capture the charter (this is the part that "becomes them")

Elicit how the user makes decisions, so the run can decide as they would:

- Priorities and what they optimize for (speed, robustness, simplicity, ...).
- Technology and style preferences.
- Hard rules: what they will NEVER accept, what they ALWAYS want.
- Risk tolerance and how to break ties when principles conflict.

Ask for concrete examples. "I hate clever abstractions" is more useful as "prefer
a 10-line obvious function over a reusable helper unless it is used 3+ times."

## Step 3 — Confirm guardrails

Default posture (the recommended one): git commit, push, and publish stay
LOCKED; the run stages and reports, the human commits. Confirm or adjust:

- Which action classes are autonomous vs gated (default: all git write ops gated).
- Stop conditions: max consecutive failures (default 3), max iterations
  (default 50), token/time budget if any.

## Step 4 — Build the plan

Decompose the mission into an ordered, checkbox backlog in `PLAN.md`. Each item
should be independently completable and verifiable. Order by dependency, then by
value. Keep items small enough that one is a reasonable unit of autonomous work.

**Make it parallel-ready.** The run can execute independent items concurrently
(`leopold-driver run --parallel N`, each item in its own worktree). Help it: when an
item genuinely needs an earlier one finished first, declare it with an `(after: N)`
marker referencing the earlier item's 1-based position — `- [ ] (after: 2, 3) Wire
the UI to the API`. Items with no marker are treated as independent and may run at
the same time, so only add `(after: …)` for real dependencies, and prefer to split
work so that more items are independent. Items that all touch the same files should
depend on each other (or be one item) to avoid merge conflicts.

## Step 4a — Draft the plan by tournament (optional, workflow)

For a substantial mission (roughly: 6+ items, or architectural choices baked into
the ordering), a single draft inherits your first framing. If the `Workflow` tool
is available, offer to draft the plan by **tournament** instead:

- Copy `~/.claude/skills/leopold-brief/reference/plan-tournament.workflow.js` to
  `.claude/workflows/leopold-plan-tournament.js` and launch it with `args`:
  `{ mission, charter, projectDir, constraints }` — where `constraints` restates
  the format rules from Step 4 (checkbox lines, `(after: N)` markers, sizing,
  same-file items depend on each other).
- Three independent drafters plan from deliberate stances (MVP-first, risk-first,
  user-journey-first), each grounding items in the real repo; two judges score all
  drafts comparatively (delivery realism, mission fit); a synthesizer builds the
  final plan from the winner grafted with the runners-up's best ideas.
- The result comes back as an ordered item list — show the user the winning angle
  and ranking, then fold the list into `PLAN.md` as the Step 4 backlog.

Skip silently for small missions or when workflows are unavailable; the Step 4
plan is enough.

## Step 4b — Harden the plan with gstack (optional)

If gstack is installed (check for `~/.claude/skills/gstack/`, or whether the
`/spec` skill exists), offer to sharpen the plan before writing it. gstack's
planning skills are excellent here:

- Heavy or architectural plan -> offer `/autoplan` or `/plan-eng-review`.
- Product or scope decision -> offer `/plan-ceo-review`.
- A fuzzy item that needs an executable spec -> offer `/spec`.

Run them in spawned mode (prefix any gstack bash with `OPENCLAW_SESSION=1`) so
they auto-decide and report instead of prompting, then fold the result back into
`PLAN.md`. If gstack is not installed, skip this step silently; the plan you
already built is enough. gstack is optional and separate: https://github.com/garrytan/gstack

## Step 5 — Write the artifacts

Copy the templates from the Leopold install (`~/.claude/leopold/templates/`) and
fill them in, writing to:

- `.leopold/MISSION.md`
- `.leopold/CHARTER.md`
- `.leopold/GUARDRAILS.md`
- `.leopold/PLAN.md`

Then create an empty `.leopold/DECISIONS.md` with a header.

## Step 6 — Read it back

Summarize the brief to the user in a few lines: mission, the 3 sharpest charter
rules, the guardrail posture, and the first 3 plan items. Ask if it reflects how
they actually think. Iterate until they confirm.

End by telling them how to hand over the seat, and which engine fits:

- `/leopold-run` — the single-context conductor loop. Good for a short or highly
  interactive plan.
- `/leopold-workflow` — compiles this brief into a **dynamic workflow**: the plan runs
  as code (no context drift on a long plan), each item gets an independent adversarial
  review, and the run is resumable and visible in `/workflows`. Reach for it when the
  plan is large or parallelizable. Requires Dynamic workflows enabled (`/config`).

Both read the same `.leopold/` brief and keep git locked.
