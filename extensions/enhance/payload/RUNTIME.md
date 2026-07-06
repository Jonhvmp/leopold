# ~/.claude/enhance — leopold prompt enhancer (runtime)

This directory is the enhancer's runtime home. Everything here is **local**: your
prompts never leave this machine except through your own `claude` account when the
rewriter runs.

| file | what it is |
|---|---|
| `enhance.py` | the engine — one `UserPromptSubmit` hook (vendored by the installer; edits are overwritten on update) |
| `state.json` | `enabled`, `model`, `safe_mode`, thresholds. Toggled by `leopold menu` / `/leopold-enhance on\|off` |
| `PROMPT-PROFILE.md` | learned rules about how you write prompts, fed to the rewriter. Yours to edit; `/leopold-enhance learn` only proposes |
| `PROFILE-amendments.md` | proposals from the learn loop, awaiting your review (safe to delete) |
| `enhancements.jsonl` | the ledger — one line per enhancement (or failed attempt). Rotates at 2 MB to `enhancements.1.jsonl` |
| `sessions/` | per-session cooldown stamps (pruned automatically) |
| `enhance.log` | only written with `LEOPOLD_ENHANCE_DEBUG=1` |

## How the hook decides (short version)

Hard skips first: disabled, slash/`!`/`#` commands, short acks ("ok", "sim", "2"),
pasted code/logs, prompts > 60 words, an active Leopold autonomous run, a 120 s
per-session cooldown. Then a weakness score: short +2, no structure +1, vague opener
+1, **anchor (path / `symbol` / identifier) −2**, formed question −2. Only a score
≥ 4 pays the ~2–4 s Haiku call. Tune with `/leopold-enhance preview "your prompt"`.

## Env controls

```
LEOPOLD_ENHANCE_DISABLE=1     kill switch (stays wired, does nothing)
LEOPOLD_ENHANCE_DEBUG=1       log decisions to enhance.log
LEOPOLD_ENHANCE_MIN_SCORE     default 4      LEOPOLD_ENHANCE_MAX_WORDS   default 60
LEOPOLD_ENHANCE_COOLDOWN_S    default 120    LEOPOLD_ENHANCE_TIMEOUT_S   default 25
```

Full destroy (unwire + delete this directory): `leopold menu` → Uninstall → enhance.
