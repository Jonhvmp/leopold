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
lives in the enhancer home `$ENH` below (engine, `state.json`, ledger,
`PROMPT-PROFILE.md`).
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

## Paths

Nothing here hardcodes a harness home. Resolve both paths first and reuse them in
every command below (`$ENH` is the enhancer's own dir under whichever harness home
has it; `$LEO` is the Leopold asset home):

```bash
ENH="${LEOPOLD_ENHANCE_DIR:-${LEOPOLD_HOME:+$LEOPOLD_HOME/enhance}}"
ENH="${ENH:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/enhance" ] && echo "${CLAUDE_HOME:-$HOME/.claude}/enhance" || echo "${CODEX_HOME:-$HOME/.codex}/enhance")}"
LEO="$(leopold home 2>/dev/null || echo "${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}" || echo "${CODEX_HOME:-$HOME/.codex}")/leopold}")"
```

If `$ENH/enhance.py` does not exist, the enhancer isn't installed —
point at `leopold menu` (enhance → Install) or re-running the Leopold installer,
and stop.

## Status

Run `python3 "$ENH/enhance.py" --event status` and read
`$ENH/state.json`. Report: enabled/off, model, mode (safe/normal),
consecutive failures (if any, mention the self-heal downgrade), and the ledger —
total lines plus the last ~5 entries of `$ENH/enhancements.jsonl`
(show `prompt_excerpt`, `score`, `injected`, `latency_ms`). If the ledger has 20+
injected entries and the learn loop has never run, suggest `/leopold-enhance learn`.

## Toggle

Prefer the extension manager so the menu and the skill stay one control plane:
`bash "$LEO/extensions/enhance/manage.sh" toggle on|off`.
If that path doesn't exist (driver-only install), fall back to
`python3 "$ENH/enhance.py" --event toggle on|off`.
Echo the resulting state. Turning on for the first time also runs a capability
probe (safe vs normal mode) — relay what it printed.

## Preview

Run `python3 "$ENH/enhance.py" --event preview "<the user's text>"`
and show the output as-is: the per-signal breakdown, the score against the
threshold, and — when it passes — the exact block that would be injected.
This is the tuning tool: if the user disagrees with a verdict, point at the
threshold env vars (`LEOPOLD_ENHANCE_MIN_SCORE`, `_MAX_WORDS`, `_COOLDOWN_S`) or
the `thresholds` object in `$ENH/state.json`. Preview never writes
the ledger.

## Learn loop

**Hard boundary: this skill never edits `PROMPT-PROFILE.md` itself.** The profile
shapes every future interpretation; the output is a proposal file the user
reviews. You may apply accepted amendments only after the user explicitly picks
them.

### Preflight

- The `Workflow` tool must be available (Dynamic workflows enabled in `/config`).
  If not, say so and stop — the independent-miners-plus-skeptic structure is what
  makes this trustworthy; don't fake it with a single-context pass. Dynamic workflows
  are a **Claude Code** runtime feature: on Codex CLI the tool does not exist, so name
  that as the reason and stop. The enhancer itself (status, toggle, preview) works on
  both harnesses — only this learn loop is Claude Code only.
- `$ENH/enhancements.jsonl` must exist with at least ~10
  `"injected":true` lines. Fewer → say the ledger is too thin to mine yet.

### Step 1 — Gather the sources

Build the workflow's `args`:

- `ledgerPaths`: `$ENH/enhancements.jsonl` plus
  `enhancements.1.jsonl` if it exists (absolute paths — expand `$ENH`, the
  workflow takes real paths, not shell).
- `transcriptDirs`: the unique `cwd` values of the last ~200 ledger lines, each
  mapped to `${CLAUDE_HOME:-$HOME/.claude}/projects/<slug>/` where `<slug>` is the
  absolute path with every `/` replaced by `-` (e.g. `/home/me/app` →
  `-home-me-app`). Keep only dirs that exist and contain `.jsonl` files; pass `[]`
  if none — on a Codex-only machine there are none, so the transcript miner is
  dropped and you say so rather than reporting a full pass.
- `profile`: full text of `$ENH/PROMPT-PROFILE.md`.
- `outPath`: `$ENH/PROFILE-amendments.md` (absolute).
- `maxCandidates`: 10 unless the user asks for more/less.

### Step 2 — Run the mining workflow

Copy the canonical script `reference/leopold-enhance-learn.workflow.js` from this
skill's own folder (the directory holding this SKILL.md, wherever the harness
loaded it from)
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

Read `$ENH/PROFILE-amendments.md` and show the proposed rules
(rule + kind + evidence, compact). Two honest outcomes:

- **No survivors** — say so plainly: the enhancer is reading the user's prompts
  the way they mean them. That is a good result, not a failure.
- **Survivors** — use AskUserQuestion (multiSelect). For each accepted
  `interpretation` rule, append a `- rule` line to
  `$ENH/PROMPT-PROFILE.md` with Edit. For each accepted `gate`
  rule, apply the suggested threshold change to the `thresholds` object in
  `$ENH/state.json`. Delete the proposal file afterwards if
  everything was resolved.

## Cadence

Suggest `/leopold-enhance learn` once the ledger has a few dozen injected entries,
and again whenever the user mentions the interpretations feel off. Each pass
compounds: the better the profile, the closer every future interpretation reads
to what they actually meant.
