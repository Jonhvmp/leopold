# ovmem extension (WIP installer)

**ovmem** gives Claude Code autonomous, self-managing long-term memory: it wires
[OpenViking](https://github.com/volcengine/OpenViking) (a hierarchical context DB) to
Claude Code through 4 native hooks, so any session stays optimized without destructive
`/compact` or `/clear`. Distillation, dedup and reconsolidation happen server-side; a
weekly hotness prune keeps the store from accumulating.

Today this extension ships **detect / status / doctor** (which probe a live install).
`install` / `update` / `remove` are stubs — see why below.

## Why the installer is the hard part

gstack is a `git clone` + `./setup`. ovmem is not: it has real external dependencies.

| Dependency | What the installer must do |
|---|---|
| OpenViking server | `uv tool install openviking`, generate `~/.openviking/ov.conf`, start the daemon, keep it up (a SessionStart auto-bootstrap + optional bashrc line) |
| An LLM (for extraction/summaries) | needs the **`model.request`** scope. Either ask for an OpenAI key, **or** configure a local Ollama model that does real tool-calling (`qwen2.5:7b+` — `nemotron-3-nano:4b` is too weak for the "operations" protocol) |
| Config correctness | `vlm.max_tokens: 16384` (else OpenAI 400s on the 32768 default), `output_language_override: "en"` to pin memory language |
| Claude Code wiring | copy `ovmem.py` + `ovmem-cleanup.py` into `~/.claude/ovmem/`, wire the 4 hooks into `settings.json` (jq, idempotent, backup) |

So the installer juggles a **daemon + a secret + idempotent hook wiring** — more serious
than cloning a repo. It needs an interactive setup (key vs local) and a real `doctor`.

## Planned `install` flow

```
1. ensure uv + `uv tool install openviking`
2. write ~/.openviking/ov.conf (storage, server, embedding)
3. LLM choice:
     a) OpenAI: prompt for a key, verify chat + embedding scope before saving
     b) Local:  detect/pull an Ollama tool-calling model, point vlm.api_base at it
4. set vlm.max_tokens=16384 + output_language_override="en"
5. start the server (openviking-start), wait for /health
6. vendor ovmem.py + ovmem-cleanup.py into ~/.claude/ovmem/ (parameterize OVMEM_USER=$(whoami))
7. wire the 4 hooks into settings.json (jq merge, backup like Leopold's installer)
8. run doctor: server health, hooks count, ov.conf sanity, one round-trip extract
```

When this is built, `ovmem.py` / `ovmem-cleanup.py` / the runtime README get **vendored
into this folder** so the extension is self-contained and versioned with Leopold.

## Runtime model (reference)

4 hooks → OpenViking REST:
- **SessionStart** — bootstrap the server + rehydrate (session summary + long-term memory)
- **UserPromptSubmit** — recall: inject memory relevant to the prompt (token-budgeted)
- **PreCompact** — flush the transcript delta + commit *before* compaction destroys it
- **SessionEnd** — flush + commit, then the weekly hotness prune

Dedup and obsolescence are handled natively by OpenViking on commit. Cold-memory
accumulation is pruned by `ovmem-cleanup.py` (hotness = frequency × recency decay), which
the SessionEnd hook runs at most once a week.
