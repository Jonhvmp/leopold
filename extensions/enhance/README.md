# enhance — global prompt enhancer

Everyday prompts are naturally thin — speed becomes habit ("fix login", "arruma o
build"). This extension wires **one `UserPromptSubmit` hook** that scores every
prompt you send; when a prompt is genuinely weak (short, vague, unanchored), it has
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
  rules for `~/.claude/enhance/PROMPT-PROFILE.md`. It never edits the profile itself.
- **Fail-open, always.** No `claude` on PATH, timeout, API error, weird output —
  the hook emits nothing and your prompt goes through untouched. Never blocks.

## Install / control

Installed **wired but OFF** by the main Leopold installer. Control plane:

```
leopold menu -> enhance      # t) Toggle on/off, doctor, full remove
/leopold-enhance on|off|status|preview "text"|learn
```

`remove` is the full destroy: unwires the hook and deletes `~/.claude/enhance`
(engine, state, ledger, learned profile). Kill switch without unwiring:
`LEOPOLD_ENHANCE_DISABLE=1`.

## Files

| file | role |
|---|---|
| `extension.json` | menu registry entry (`toggle` key enables the `t)` action) |
| `manage.sh` | `detect / status / install / update / remove / doctor / toggle` |
| `install.sh` | vendor engine, seed state (OFF) + profile, wire hook, background probe |
| `payload/enhance.py` | the engine (pure stdlib, fail-open) |
| `payload/RUNTIME.md` | installed as `~/.claude/enhance/README.md` |

Docs: [Prompt Enhancer reference](../../docs/reference/enhance.md).
