---
name: leopold-workflow
version: 0.1.0
description: "Compile a Leopold brief into a dynamic workflow and run it. The plan lives in code instead of one growing context window, every item gets an independent adversarial review, and git stays locked — nothing is committed. The workflow is resumable and shows up in /workflows."
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Workflow
  - AskUserQuestion
triggers:
  - leopold workflow
  - compile the brief
  - run leopold as a workflow
  - conduct with a workflow
---

# /leopold-workflow

Phase 2, the workflow way. You compile the durable Leopold brief into a **dynamic
workflow** — a JavaScript harness Claude Code's runtime executes in the background —
and run it. Same brief, same charter, same git lock; a different, stronger engine.

**Why compile the brief into a workflow.** `/leopold-run` conducts the plan inside one
session's context window. That is fine for a short plan, but a long one accumulates
context every turn and drifts into the three failure modes Anthropic names for
long single-context runs:

- **Agentic laziness** — declaring done at 35 of 50 items.
- **Self-preferential bias** — grading its own work as fine.
- **Goal drift** — losing charter constraints across compactions.

A workflow moves the plan into **code**: the loop, the branching, and the intermediate
results live in the script, so each agent gets a clean, focused context and Claude's
own context holds only the final report. Every plan item gets an **independent**
reviewer that did not write the code it judges. The run is **resumable** and streams a
live phase tree into `/workflows`. Git is locked for free: a workflow never commits —
its agents stage work and you commit what you approve.

This does **not** replace `/leopold-run`. Use `/leopold-run` for a short or highly
interactive plan; use `/leopold-workflow` when the plan is large, parallelizable, or
you want the run to be a readable, versionable, re-runnable artifact. Both read the
same `.leopold/` brief.

## Preflight — is this even the right tool?

Confirm dynamic workflows are available: the `Workflow` tool must be present in this
session (Claude Code v2.1.154+, enabled in `/config`). If it is not, tell the user to
enable Dynamic workflows in `/config` (or run `/leopold-run` instead) and stop.

Confirm the brief exists: `.leopold/MISSION.md`, `.leopold/CHARTER.md`,
`.leopold/GUARDRAILS.md`, `.leopold/PLAN.md`. If any is missing, stop and tell the user
to run `/leopold-brief` first. Do not improvise a brief.

Read all four artifacts in full — they are the authority for everything below.

## Step 1 — Parse the plan into dependency waves

Read `.leopold/PLAN.md`. Each unchecked `- [ ]` line is an item; already-checked
`- [x]` items are done, skip them. Items may carry an `(after: N, …)` marker naming the
1-based positions they depend on.

Build **waves**: wave 1 is every item with no unmet dependency; wave 2 is every item
whose dependencies are all in wave 1; and so on (a topological layering). Items in the
same wave are independent of each other. If two items with no marker touch the same
files, treat them as dependent (put the later one in a later wave) so they don't clash.

If the markers form a cycle, stop and tell the user which items cycle — the plan is
malformed.

## Step 2 — Classify each item (effort + risk)

For each item, derive `effort`, `critical`, and `sensitive` with the **same keyword
rules Leopold's driver uses** (keep it deterministic — no guessing):

- **critical** (→ `critical: true`, panel of reviewers) if the text matches:
  `billing|payment|invoice|charge|checkout|subscription|stripe|paywall|auth|authn|authz|login|signup|session|password|credential|secret|token|api key|oauth|jwt|crypto|encrypt|decrypt|signing|security|permission|access control|rbac|migrat|schema|ddl|drop table|database|destruct|irreversible|delete|deploy|release|production|infra|terraform|kubernetes|dns`
- **sharp** (→ `effort: 'max'`) if a critical item also matches:
  `migrat|schema|ddl|drop table|irreversible|destruct|payment|billing|crypto|security|auth` — otherwise a critical item is `effort: 'high'`.
- **sensitive** (→ `sensitive: true`, security lens in review) if it matches:
  `auth|login|session|password|credential|secret|token|oauth|jwt|crypto|encrypt|sign|security|permission|access|rbac|billing|payment|checkout|stripe|.env`
- **trivial** (→ `effort: 'low'`) if it matches:
  `typo|rename|comment|docs?|readme|changelog|format|lint|whitespace|wording|copy edit|label|spelling|punctuation|bump version` — unless it's also critical (critical wins).
- Everything else → `effort: 'medium'`, `critical: false`, `sensitive: false`.

If `.leopold/CHARTER.md` declares the whole project high-risk (`high-risk`,
`security-critical`, `handles money/PII/secrets`), raise any otherwise-medium item to
`high`.

Give each item a short stable `id` (e.g. `i1`, `i2`, … by original plan position).

## Step 3 — Read the guardrails for the review budget

From `.leopold/GUARDRAILS.md`, read `max_review_rounds` if present (else default `2`).
Note the git posture — it should be locked (stage-and-report). If the guardrails
explicitly unlock git, tell the user a workflow still won't commit (that's inherent);
they commit after.

## Step 4 — Compile and launch the workflow

Copy the reference script `reference/leopold-run.workflow.js` from this skill's folder
(installed at `~/.claude/skills/leopold-workflow/reference/leopold-run.workflow.js`) to
`.claude/workflows/leopold-run.js` in the project — creating `.claude/workflows/` if
needed. Do **not** rewrite the script logic; it is the canonical, tested harness. You
only supply data through `args`.

Then run it with the **Workflow** tool, passing `scriptPath` and `args` built from the
steps above:

```
Workflow({
  scriptPath: ".claude/workflows/leopold-run.js",
  args: {
    mission:  <full text of .leopold/MISSION.md>,
    charter:  <full text of .leopold/CHARTER.md>,
    waves:    [[{ id, text, effort, critical, sensitive }, …], …],   // Step 1 + 2
    maxReviewRounds: <from Step 3, default 2>,
  },
})
```

Pass `args` as real JSON (arrays/objects), never as a stringified blob — the script
calls array methods on `waves` directly.

Saving the script to `.claude/workflows/leopold-run.js` also makes it a reusable
`/leopold-run` **command** (native workflow command) that anyone who clones the repo
can re-run, and that you can read and diff. That is the artifact: the brief, compiled
into a harness you can version.

## Step 5 — Watch and report

The run executes in the background. Tell the user they can watch it with `/workflows`
(phase tree: Plan → Execute → Verify → Report, with per-agent token counts). When it
finishes, the workflow returns a report object: items done, items left incomplete with
their blocking findings, and the reminder that **everything is staged, nothing was
committed**. Relay that to the user and point out what is ready to commit.

Do **not** mark items `[x]` in `PLAN.md` yourself mid-run — the workflow owns execution.
After it finishes, update `PLAN.md` to check off the items the report lists as done, so
a re-run or a later `/leopold-run` continues from the right place.

## Advanced — worktree-parallel execution (opt-in)

By default the script runs the items within a wave **serially** (correct for repos
where items may touch overlapping files, since workflow agents edit the real tree). For
a plan whose independent items touch **strictly disjoint** files (e.g. one file per
component migration), you get a large speedup by isolating each item's implement agent
in its own worktree and running the wave with `parallel`. The reference script documents
the exact one-line change inline. Only suggest this when the plan's independence is real
— a wrong call here causes cross-item conflicts.

## Notes

- **Cost.** A workflow spawns many agents and uses meaningfully more tokens than a
  single-context run. For a big plan, offer to run one wave first (slice `waves` to
  `[waves[0]]`) to gauge spend before committing to the whole thing. Add a token budget
  by prompting the run with a cap if the user wants one.
- **Resumability.** If the run is interrupted, relaunch with the same `scriptPath` and
  `args` plus `resumeFromRunId` — completed agents return cached results.
- **Git stays locked** the entire time. This is not a policy the script enforces; it is
  inherent to workflows — they cannot commit. That is exactly the Leopold guarantee.
