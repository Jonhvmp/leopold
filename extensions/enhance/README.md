# enhance — global prompt enhancer

Everyday prompts are naturally thin — speed becomes habit ("fix login", "arruma o
build"). This extension wires **one `UserPromptSubmit` hook per harness** — Claude Code
(`~/.claude/settings.json`) and Codex CLI (`~/.codex/config.toml`), through the one
shared writer in `../lib/harness.sh` — that scores every prompt you send; when a
prompt is genuinely weak (short, vague, unanchored), it has
**Haiku — on your own connected account** — produce a structured interpretation and
injects it as context *next to* your prompt:

```
[leopold-enhance — structured interpretation of the prompt above]
Objective: ... / Context: ... / Constraints: ... / Done when: ... / Assumptions: ...
Rule: ... If it conflicts with the user's raw prompt, THE RAW PROMPT WINS.
```

Your prompt is never replaced (the platform doesn't even allow it), and strong
prompts pass through untouched — an anchor like a file path or a `Symbol` vetoes
enhancement outright.

What makes it different from generic prompt enhancers:

- **Charter-aware.** If the project has a Leopold brief, the rewriter reads
  `.leopold/CHARTER.md` — it interprets the prompt the way *you* would.
- **Self-learning.** Every enhancement lands in a local ledger;
  `/leopold-enhance learn` mines it for prompts you had to correct and *proposes*
  rules for `<enhance dir>/PROMPT-PROFILE.md`. It never edits the profile itself.
- **Fail-open, always.** No `claude` on PATH, timeout, API error, weird output —
  the hook emits nothing and your prompt goes through untouched. Never blocks.
- **One switch, every harness.** The data dir (state, ledger, profile) is a single
  directory for the machine: turning the enhancer on inside Codex reads as on
  inside Claude Code, and there is one learned profile, not one per agent.

## Install / control

Installed **wired but OFF** by the main Leopold installer. Control plane:

```
leopold menu -> enhance      # t) Toggle on/off, doctor, full remove
/leopold-enhance on|off|status|preview "text"|learn
```

`remove` is the full destroy: unwires the hook from **every** harness and deletes
the enhance dir (engine, state, ledger, learned profile). Kill switch without
unwiring: `LEOPOLD_ENHANCE_DISABLE=1`.

On Codex, a config-declared hook stays **inert until you approve it once** (Codex's
hook-trust gate) — open Codex and accept it after installing.

### Where the data dir is

`LEOPOLD_ENHANCE_DIR` → `$LEOPOLD_HOME/enhance` → `$CLAUDE_HOME/enhance` → whichever
of `~/.claude/enhance` / `~/.codex/enhance` already exists → the home that exists →
`~/.claude/enhance`. Resolved identically by `leo_enhance_dir()` in
`../lib/harness.sh` and `_resolve_enhance_dir()` in the engine, so an existing
Claude Code install is never migrated and a Codex-only machine never touches
`~/.claude`.

### Two harnesses, two envelopes

Claude Code injects a `UserPromptSubmit` hook's plain stdout as context. Codex CLI
does not: its `user-prompt-submit.command.output` schema is strict JSON, and a
text-emitting hook is logged as `hook: UserPromptSubmit Failed` (verified live on
codex-cli 0.146.0). The engine emits the same block either way, wrapped in
`hookSpecificOutput.additionalContext` when the payload came from Codex.

The rewriter itself is `claude -p --model haiku` on **every** harness — a `codex
exec` turn takes minutes and this runs inside a 30 s prompt hook. Without the
`claude` CLI on PATH the hook is a permanent silent pass-through, and both
`manage.sh status` and `manage.sh doctor` say so rather than reporting a bare "on".

## Files

| file | role |
|---|---|
| `extension.json` | menu registry entry (`toggle` key enables the `t)` action) |
| `manage.sh` | `detect / status / install / update / remove / doctor / toggle` |
| `install.sh` | vendor engine, seed state (OFF) + profile, wire hook, background probe |
| `payload/enhance.py` | the engine (pure stdlib, fail-open) |
| `payload/RUNTIME.md` | installed as `<enhance dir>/README.md` |

Docs: [Prompt Enhancer reference](../../docs/reference/enhance.md).
