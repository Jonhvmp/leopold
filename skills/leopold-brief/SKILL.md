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

Leopold runs on either harness. Skills named `/x` below are slash commands on Claude
Code; on Codex CLI invoke the same skill as `$x` or by naming it in plain text. Where
a tool is named, use your harness's equivalent: `AskUserQuestion` (Claude Code) /
`request_user_input` (Codex) to ask, `Task` / `spawn_agent` to spawn a subagent.

The brief is the contract. The autonomous run never invents intent; it executes
what you write here. The quality of the run is capped by the quality of this
brief, so do it well.

## Preamble — update check

Quietly check for a Leopold update; if one is available, tell the user. If
`~/.leopold/auto-update` exists, update now (the brief is a safe point).

```bash
LEO="$(leopold home 2>/dev/null || echo "${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}" || echo "${CODEX_HOME:-$HOME/.codex}")/leopold}")"
UP="$(bash "$LEO/scripts/leopold-update-check.sh" 2>/dev/null || true)"
if [ -n "$UP" ]; then
  echo "$UP"
  [ -f ~/.leopold/auto-update ] && bash "$LEO/scripts/leopold-update.sh" || echo "Update with: make update (or /leopold-update)"
fi
```

## Step 0 — Set up

Run: `mkdir -p .leopold`

If `.leopold/MISSION.md` already exists, read all existing artifacts and offer to
revise rather than overwrite.

If this looks like a fresh project — no agent memory file (`CLAUDE.md` on Claude Code,
`AGENTS.md` on Codex), no app run-skill, a thin permissions allowlist — suggest running
**/leopold-up** first (Phase 0): it generates project memory, teaches the agent to run
the app, and configures permissions/MCP so the brief and run start from a strong
footing. Don't block on it; just point it out once.

## Step 1 — Understand the mission (debate it)

Through conversation (use `AskUserQuestion` / `request_user_input` for real forks),
establish:

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
- Quality & orchestration toggles the SDK driver reads from GUARDRAILS.md:
  `review` (on), `hypotheses` (on), `smart_routing` (off), and `learn_on_finish`
  (off — when on, a clean finish mines the run into proposed charter amendments via
  `/leopold-learn`'s logic, without touching CHARTER.md). A CLI flag overrides the brief.

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

**Make behavior checkable with `@scenario`.** For any item whose "done" is a
behavior (not a cosmetic change), write its acceptance cases as `@scenario` lines
directly under the checkbox — one per case, `given X → when Y → then Z`, phrased so
a caller or user could observe it (an output, a status code, a screen state — never
"the function sets `_cache`"). The run hands these to the worker as the definition
of done and to a **conformance** reviewer that verifies the diff satisfies every one
before the item closes; an unmet scenario comes back as the concrete fix. An item
with no `@scenario` lines is fine — it just relies on its prose done-check, exactly
as before (fully backward compatible). Example:

    - [ ] Register the `--json` flag — done when: `mycli --json` emits valid JSON
          @scenario no flag → the table prints unchanged
          @scenario `--json` set → stdout is valid JSON with the table's exact fields
          @scenario `--json` with no rows → prints `[]` and exits 0

**Route the plan when the work actually branches.** The plan is a graph, and every
construct below is optional — a plan that uses none of them runs exactly as it always
has, so only reach for one when the mission's own shape asks for it. In the debate,
listen for these four cues and offer the matching construct:

- *"and if that fails we'd have to roll it back"* → a **conditional edge**.
  `@on fail -> 7` routes on the item's own outcome; `@on migrated=false -> 7` routes
  on a signal. Put both branches statically after the deciding item (`(after: N)` on
  each) and give it one `@on` per branch: the branch that is not steered to is
  bypassed, so exactly one runs.
- *"a person has to sign this off"* → `@human`. Under the default posture nobody is
  coming: Leopold synthesizes the role that decision needs, takes it, does the item and
  records the call with its Reversal — git stays locked, so it decides and you ship. Put
  `autonomy: ask` in GUARDRAILS.md to have the run stop at those items instead, name the
  one it is on, stage everything and hand the seat back.
- *"that step is just running the suite / the migration"* → `@tool`, whose text IS the
  command. No model turn is spent, and the exit status lands on the channel as `exit`,
  so `@on exit!=0 -> 7` needs no `@emit` line. Git stays locked: `@tool git push` is
  refused, not run.
- *"someone should check this before we build on it"* → `@gate` (judge the diff) or
  `@verify` (re-run the build/tests and prove it). Both are review-only sessions that
  cannot edit what they judge.

A routing decision needs something to route on: `@emit key=value` declares a signal an
item may put on the state channel, `@needs key` holds an item back until that signal
exists. **The repository is the truth of what was built; the channel is the truth of
what was decided** — never a diff, a payload or a log, only a decision.

    - [ ] (after: 1) @tool make migrate
          @on exit=0  -> 3
          @on exit!=0 -> 4
    - [ ] (after: 2) @verify Prove the app boots against the migrated schema
          @emit migrated=true
          @emit migrated=false
          @on migrated=false -> 4
    - [ ] (after: 2) Roll the migration back — done when: the schema is at the previous revision

If you author any routing, run `leopold graph` in the project before handing over: it
prints the graph and exits non-zero on a dangling route, a cycle, an unreachable item,
a `@needs` nobody emits or an `@on` naming a signal nobody emits — naming the offending
item, before a single agent runs.
The full grammar is `docs/reference/plan-grammar.md` in the Leopold install.

## Step 4a — Draft the plan by tournament (optional, workflow)

For a substantial mission (roughly: 6+ items, or architectural choices baked into
the ordering), a single draft inherits your first framing. If the `Workflow` tool
is available, offer to draft the plan by **tournament** instead. Dynamic workflows
are a Claude Code runtime feature: on Codex CLI the `Workflow` tool does not exist,
so skip this step and say why — the Step 4 plan stands on its own, and
`leopold workflow --run` still executes the plan through the driver on either
harness.

- Copy `reference/plan-tournament.workflow.js` from this skill's own folder (the
  directory holding this SKILL.md, wherever the harness loaded it from) to
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

If gstack is installed (check for a `gstack` skill dir under the harness skills
home — `${CLAUDE_HOME:-$HOME/.claude}/skills` on Claude Code,
`${CODEX_HOME:-$HOME/.codex}/skills` on Codex — or whether the `/spec` skill
exists), offer to sharpen the plan before writing it. gstack's
planning skills are excellent here (invoke each as `/name` on Claude Code, `$name` or
by naming the skill on Codex):

- Heavy or architectural plan -> offer `autoplan` or `plan-eng-review`.
- Product or scope decision -> offer `plan-ceo-review`.
- A fuzzy item that needs an executable spec -> offer `spec`.

Run them in spawned mode (prefix any gstack bash with `OPENCLAW_SESSION=1`) so
they auto-decide and report instead of prompting, then fold the result back into
`PLAN.md`. If gstack is not installed, skip this step silently; the plan you
already built is enough. gstack is optional and separate: https://github.com/garrytan/gstack

## Step 5 — Write the artifacts

Copy the templates from the Leopold install (`$LEO/templates/`, with `$LEO`
resolved as in the preamble above) and fill them in, writing to:

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
  plan is large or parallelizable. Claude Code only — it needs Dynamic workflows
  enabled (`/config`). On Codex CLI, use `leopold workflow --run` instead: same
  compiled plan, executed by the driver through `codex exec`.

Both read the same `.leopold/` brief and keep git locked.
