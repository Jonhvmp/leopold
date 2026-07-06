# Hooks

Three hooks are wired into `settings.json` by `install.sh`. The two engine hooks
live in `~/.claude/leopold/hooks/` and are **no-ops unless a run is active**; the
prompt enhancer lives in `~/.claude/enhance/` and is a **no-op until you toggle it
on** — so all three are safe to leave installed in every session.

## `stop-continuity.sh` — the Stop hook

Runs when the agent finishes a turn. Contract: read JSON on stdin; print
`{"decision":"block","reason":"..."}` to keep going, or exit 0 to allow the stop.

```mermaid
flowchart TD
    In["Stop event (JSON on stdin)"] --> Active{run active?}
    Active -- no --> Allow([exit 0 · allow stop])
    Active -- yes --> Kill{STOP file?}
    Kill -- yes --> Allow
    Kill -- no --> Budget{budget / failures hit?}
    Budget -- yes --> Allow
    Budget -- no --> Plan{open plan items?}
    Plan -- no --> Allow
    Plan -- yes --> Block["increment iteration ·<br/>block · re-inject continue"]
```

Fail-open: any unexpected error allows the stop. Continuity is best-effort;
halting is always safe.

## `guard-irreversible.sh` — the PreToolUse hook

Runs before every tool call. Contract: read JSON on stdin; print a
`hookSpecificOutput` with `permissionDecision: "deny"` to block, or exit 0 to
allow. It only adds denials; it never loosens Claude Code's own permissions.

See the policy table in [Guardrails](../guardrails.md).

## `enhance.py` — the UserPromptSubmit prompt enhancer

Runs on every prompt you submit (the event takes no matcher, so all gating is
internal). Contract: read the hook JSON on stdin; plain text on stdout is injected
as context next to the raw prompt (plain text, not JSON, so it concatenates safely
with other `UserPromptSubmit` hooks); **always exit 0** — the prompt itself is
never modified or blocked.

```mermaid
flowchart TD
    In["UserPromptSubmit (JSON on stdin)"] --> Rec{recursion / kill-switch env?}
    Rec -- yes --> Silent([exit 0 · silent])
    Rec -- no --> On{enabled in state.json?}
    On -- no --> Silent
    On -- yes --> Skips{"command · ack · pasted code ·<br/>&gt;60 words · active run · cooldown?"}
    Skips -- yes --> Silent
    Skips -- no --> Score{weakness score ≥ 4?<br/>anchor vetoes}
    Score -- no --> Silent
    Score -- yes --> Call["claude -p haiku<br/>(charter + profile + transcript tail)"]
    Call -- failure --> Ledger2["ledger: injected=false"] --> Silent
    Call -- ok --> Inject["inject interpretation ·<br/>ledger · cooldown stamp"]
```

Fail-open: no `claude` on PATH, timeout, API error, malformed output — nothing is
emitted and the prompt goes through untouched. Full detail (gate table, state,
ledger, the learn loop): [Prompt Enhancer](enhance.md).

## Settings wiring

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "~/.claude/leopold/hooks/stop-continuity.sh" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "~/.claude/leopold/hooks/guard-irreversible.sh" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 ~/.claude/enhance/enhance.py --event user-prompt", "timeout": 30 } ] }
    ]
  }
}
```

## Event log

The two engine hooks append structured events to `.leopold/events.jsonl`
(`turn_start`, `stop`, `guard_block`), which `/leopold-status` reads. The enhancer
logs to its own global ledger instead — `~/.claude/enhance/enhancements.jsonl`,
one line per injection or failed attempt — which `/leopold-enhance learn` mines.
