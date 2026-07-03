---
name: leopold-learn
version: 0.1.0
description: "The self-improving charter. Mines past Leopold decisions, session corrections, and git history for recurring judgment calls, skeptic-verifies each candidate, and proposes charter amendments. Never edits CHARTER.md itself — you review and apply."
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
  - leopold learn
  - improve the charter
  - mine my sessions
  - learn from the run
---

# /leopold-learn

The charter is written once, at brief time, from what the user *remembered* about
how they decide. Their actual behavior leaks better data: the calls Leopold logged
in `DECISIONS.md`, the corrections they keep typing in sessions, the reverts in git
history. This skill mines those sources, verifies every candidate with a skeptic,
and proposes amendments — so the charter gets closer to the real user with every run.

**Hard boundary: this skill never edits `CHARTER.md` itself.** The charter is the
user's identity; the output is a proposal file the user reviews. You may apply
accepted amendments only after the user explicitly picks them.

## Preflight

- The `Workflow` tool must be available (Dynamic workflows enabled in `/config`).
  If not, say so and stop — the mining fan-out is what makes this trustworthy;
  don't fake it with a single-context pass.
- `.leopold/CHARTER.md` must exist. If not, point to `/leopold-brief` and stop.
- Best after at least one Leopold run (some `DECISIONS.md` content), but session
  transcripts and git history alone are enough signal to be worth running.

## Step 1 — Gather the sources

Build the workflow's `args`:

- `projectDir`: the absolute repo root.
- `charter`: full text of `.leopold/CHARTER.md`.
- `decisionsPaths`: `.leopold/DECISIONS.md` **plus** every archived
  `.leopold/runs/*/DECISIONS.md` (glob for them). Only include files that exist.
- `transcriptDir`: this project's Claude Code session directory —
  `~/.claude/projects/<slug>/` where `<slug>` is the absolute project path with
  every `/` replaced by `-` (e.g. `/home/me/app` → `-home-me-app`). Verify the
  directory exists and contains `.jsonl` files; pass `''` if not.
- `outPath`: `.leopold/CHARTER-amendments.md` (absolute).
- `maxCandidates`: 12 unless the user asks for more/less.

## Step 2 — Run the mining workflow

Copy the canonical script from this skill's install
(`~/.claude/skills/leopold-learn/reference/leopold-learn.workflow.js`) to
`.claude/workflows/leopold-learn.js` in the project (create the dir if needed),
then launch it with the Workflow tool:

```
Workflow({ scriptPath: ".claude/workflows/leopold-learn.js", args: { …Step 1… } })
```

Do not rewrite the script — it encodes the trust structure: three miners over
**disjoint** sources (decision logs / session transcripts / git history, each blind
to the others), a cluster pass where a pattern surfacing in more than one
independent source is the strongest signal, one **skeptic per candidate** that
defaults to kill, and a distill pass that writes the proposal file only.

Pass `args` as real JSON, never stringified.

## Step 3 — Present the proposal

When the run finishes, read `.leopold/CHARTER-amendments.md` and show the user the
proposed rules (rule + evidence, compact). Two honest outcomes:

- **No survivors** — say so plainly: the charter already covers how this project
  runs. That is a good result, not a failure.
- **Survivors** — for each rule, the user decides: fold it into `CHARTER.md`
  (append to the section the proposal suggests — Always / Never / Tie-breakers /
  Preferences), or discard. Use AskUserQuestion (multiSelect) when there are
  several; apply exactly the accepted ones with Edit, keeping the charter's
  existing style. Delete the proposal file afterwards if everything was resolved.

## Cadence

Suggest running `/leopold-learn` after each substantial Leopold run finishes, or
whenever the user notices they keep correcting the same thing. Each pass compounds:
the better the charter, the fewer escalations and wrong-direction decisions the
next run makes.
