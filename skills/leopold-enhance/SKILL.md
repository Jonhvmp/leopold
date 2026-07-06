---
name: leopold-enhance
version: 0.1.0
description: "Control plane for the global prompt enhancer: status, on/off, preview a prompt against the gate, and the learn loop that mines your enhancement ledger into proposed prompt-profile rules. Never edits PROMPT-PROFILE.md itself — you review and apply."
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
  - leopold enhance
  - prompt enhancer
  - enhance my prompts
  - tune the enhancer
---

# /leopold-enhance

The enhancer is a global `UserPromptSubmit` hook: weak prompts (short, vague,
unanchored) get a structured interpretation from Haiku — on the user's own account —
injected next to the raw prompt; strong prompts pass through untouched. Everything
lives in `~/.claude/enhance/` (engine, `state.json`, ledger, `PROMPT-PROFILE.md`).
This skill is its control plane. Dispatch on the user's argument:

- `status` (or no argument) → **Status**
- `on` / `off` → **Toggle**
- `preview <text>` → **Preview**
- `learn` → **Learn loop**
- anything else → **it's a task brief, not a control verb.** The hook has already
  gated the argument and, when it scored weak, injected the interpretation above
  (by design: `/skill <brief>` prompts are gated on the ARGUMENT). Don't run the
  control plane — just do the task the argument describes, honoring the injected
  interpretation if one is present.

If `~/.claude/enhance/enhance.py` does not exist, the enhancer isn't installed —
point at `leopold menu` (enhance → Install) or re-running the Leopold installer,
and stop.

## Status

Run `python3 ~/.claude/enhance/enhance.py --event status` and read
`~/.claude/enhance/state.json`. Report: enabled/off, model, mode (safe/normal),
consecutive failures (if any, mention the self-heal downgrade), and the ledger —
total lines plus the last ~5 entries of `~/.claude/enhance/enhancements.jsonl`
(show `prompt_excerpt`, `score`, `injected`, `latency_ms`). If the ledger has 20+
injected entries and the learn loop has never run, suggest `/leopold-enhance learn`.

## Toggle

Prefer the extension manager so the menu and the skill stay one control plane:
`bash ~/.claude/leopold/extensions/enhance/manage.sh toggle on|off`.
If that path doesn't exist (driver-only install), fall back to
`python3 ~/.claude/enhance/enhance.py --event toggle on|off`.
Echo the resulting state. Turning on for the first time also runs a capability
probe (safe vs normal mode) — relay what it printed.

## Preview

Run `python3 ~/.claude/enhance/enhance.py --event preview "<the user's text>"`
and show the output as-is: the per-signal breakdown, the score against the
threshold, and — when it passes — the exact block that would be injected.
This is the tuning tool: if the user disagrees with a verdict, point at the
threshold env vars (`LEOPOLD_ENHANCE_MIN_SCORE`, `_MAX_WORDS`, `_COOLDOWN_S`) or
the `thresholds` object in `~/.claude/enhance/state.json`. Preview never writes
the ledger.

## Learn loop

**Hard boundary: this skill never edits `PROMPT-PROFILE.md` itself.** The profile
shapes every future interpretation; the output is a proposal file the user
reviews. You may apply accepted amendments only after the user explicitly picks
them.

### Preflight

- The `Workflow` tool must be available (Dynamic workflows enabled in `/config`).
  If not, say so and stop — the independent-miners-plus-skeptic structure is what
  makes this trustworthy; don't fake it with a single-context pass.
- `~/.claude/enhance/enhancements.jsonl` must exist with at least ~10
  `"injected":true` lines. Fewer → say the ledger is too thin to mine yet.

### Step 1 — Gather the sources

Build the workflow's `args`:

- `ledgerPaths`: `~/.claude/enhance/enhancements.jsonl` plus
  `enhancements.1.jsonl` if it exists (absolute paths).
- `transcriptDirs`: the unique `cwd` values of the last ~200 ledger lines, each
  mapped to `~/.claude/projects/<slug>/` where `<slug>` is the absolute path with
  every `/` replaced by `-` (e.g. `/home/me/app` → `-home-me-app`). Keep only
  dirs that exist and contain `.jsonl` files; pass `[]` if none.
- `profile`: full text of `~/.claude/enhance/PROMPT-PROFILE.md`.
- `outPath`: `~/.claude/enhance/PROFILE-amendments.md` (absolute).
- `maxCandidates`: 10 unless the user asks for more/less.

### Step 2 — Run the mining workflow

Copy the canonical script from this skill's install
(`~/.claude/skills/leopold-enhance/reference/leopold-enhance-learn.workflow.js`)
to `.claude/workflows/leopold-enhance-learn.js` in the current project (create the
dir if needed), then launch it:

```
Workflow({ scriptPath: ".claude/workflows/leopold-enhance-learn.js", args: { …Step 1… } })
```

Do not rewrite the script — it encodes the trust structure: two miners with
disjoint lenses (transcript reactions vs ledger statistics, so a pattern surfacing
in both is real signal), one kill-biased skeptic per candidate, and a distill pass
that writes the proposal file only. Pass `args` as real JSON, never stringified.

### Step 3 — Present the proposal

Read `~/.claude/enhance/PROFILE-amendments.md` and show the proposed rules
(rule + kind + evidence, compact). Two honest outcomes:

- **No survivors** — say so plainly: the enhancer is reading the user's prompts
  the way they mean them. That is a good result, not a failure.
- **Survivors** — use AskUserQuestion (multiSelect). For each accepted
  `interpretation` rule, append a `- rule` line to
  `~/.claude/enhance/PROMPT-PROFILE.md` with Edit. For each accepted `gate`
  rule, apply the suggested threshold change to the `thresholds` object in
  `~/.claude/enhance/state.json`. Delete the proposal file afterwards if
  everything was resolved.

## Cadence

Suggest `/leopold-enhance learn` once the ledger has a few dozen injected entries,
and again whenever the user mentions the interpretations feel off. Each pass
compounds: the better the profile, the closer every future interpretation reads
to what they actually meant.
