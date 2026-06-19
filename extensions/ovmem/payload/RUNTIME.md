# ovmem - autonomous RAG memory for Claude Code

Wires **OpenViking** (hierarchical context DB at `127.0.0.1:1933`) to Claude Code via
**4 native hooks**, so any session stays optimized without destructive `/compact` or
`/clear`. All reflection/distillation happens **server-side** (OpenViking calls the LLM),
so the hooks never spend an LLM call of their own.

## Flow

| Hook | What it does | OpenViking endpoint |
|---|---|---|
| **SessionStart** | start the server if down + rehydrate (session summary + long-term memory) | `GET /sessions/{id}/context`, `POST /search/find` |
| **UserPromptSubmit** | recall: inject memory relevant to the prompt (token-budgeted) | `POST /search/find` |
| **PreCompact** | flush: send the transcript delta to the OV session and commit **before** compaction destroys it | `messages/batch` + `commit` |
| **SessionEnd** | flush + commit on session end, then maybe run the weekly cleanup | `messages/batch` + `commit` |

`commit` archives the session and kicks off **long-term memory extraction**
(preferences / entities / events / agent) asynchronously, using the VLM configured
in OpenViking (`gpt-4o-mini`).

Read-hook output is **plain text** (not JSON) so it concatenates cleanly with other hooks
on the same event (e.g. `skill-activator.sh`). The hooks **never** exit non-zero - they
fail silently (fail-open) and never block the session.

## Files

- `ovmem.py` - single engine, dispatched by `--event {session-start|user-prompt|pre-compact|session-end}`. Pure stdlib, no deps.
- `ovmem-cleanup.py` - hotness-based lifecycle prune (see below).
- `state/<session_id>.json` - transcript offset already committed (avoids re-sending).
- `state/access.json` - local access signal (frequency + recency) feeding the cleanup.
- `ovmem.log` - debug log (only with `OVMEM_DEBUG=1`).

Registered in `~/.claude/settings.json` under `hooks`.

## Controls (env vars)

```
OVMEM_DISABLE=1        turn everything off (immediate no-op)
OVMEM_DEBUG=1          log to ~/.claude/ovmem/ovmem.log
OVMEM_RECALL_LIMIT=5   max memories injected (default 5)
OVMEM_RECALL_SCORE=0.28 minimum score to inject (default 0.28)
OVMEM_CHAR_BUDGET=2200 char cap on the injected block (default 2200)
OVMEM_TIMEOUT=4        timeout (s) for critical-path calls
OVMEM_ACCOUNT=default  OVMEM_USER=$USER  OVMEM_AGENT=claude-code
```

## Accumulation / lifecycle (dedup, reconsolidation, pruning)

The biggest risk for long-term memory is accumulation: duplicates, stale notes, and cold
episodes polluting retrieval. Division of responsibility:

| Problem | Mechanism | Where |
|---|---|---|
| **Duplication** | `MemoryDeduplicator` (LLM) - updates the existing note instead of creating another | **native OpenViking**, on commit |
| **Obsolescence / contradiction** | `contradicts` / `evolved_from` / `supersedes` relations during extraction | **native OpenViking**, on commit |
| **Cold-memory accumulation** | `ovmem-cleanup.py` - hotness pruning | **ovmem** (the engine has `MemoryArchiver` but never triggers it) |

Verified empirically: committing the same preference across N sessions yields **1** leaf
(updated), not N duplicates. Dedup and reconsolidation already work - do not rebuild them.

**Hotness pruning** (`ovmem-cleanup.py`), faithful to the native `MemoryArchiver`:

```
hotness = sigmoid(log1p(freq)) * exp(-ln2/half_life * age_days)
freq    = max(OpenViking active_count, local recall count)
age     = from the more recent of updated_at and last local recall
archive L2 leaves with hotness < threshold AND age >= min_age  ->  {parent}/_archive/
```

- The frequency signal comes from **recall**: every memory the hook injects is recorded in
  `state/access.json` (`record_access`). We do not rely on OpenViking's `active_count` -
  it does not increment reliably via the REST `used` endpoint in this version.
- Runs **dry-run by default**; `--apply` moves to `_archive/` (reversible, nothing deleted).
- Auto-trigger: the **SessionEnd** hook calls `ovmem-cleanup.py --apply` at most **once a
  week** (gated by `state/last_cleanup`), detached. No cron.
- Protected (never archived): `identity.md`, `soul.md` (agent core identity).

```bash
python3 ~/.claude/ovmem/ovmem-cleanup.py            # dry-run: list cold candidates
python3 ~/.claude/ovmem/ovmem-cleanup.py --apply    # archive them
```

Tunables: `OVMEM_HOTNESS_THRESHOLD=0.1` `OVMEM_HALF_LIFE_DAYS=7` `OVMEM_MIN_AGE_DAYS=7`
`OVMEM_CLEANUP_PROTECT="identity.md,soul.md"`.

## Verify

```bash
# server alive?
curl -s http://127.0.0.1:1933/health

# manual recall
echo '{"prompt":"what is my preferred stack?","cwd":"'"$PWD"'"}' \
  | python3 ~/.claude/ovmem/ovmem.py --event user-prompt

# inspect long-term memory
curl -s -H "x-api-key: ov-local-dev-key" -H "X-OpenViking-User: $USER" \
  "http://127.0.0.1:1933/api/v1/fs/tree?uri=viking://user/$USER/memories&level_limit=4"
```

## OpenViking config dependencies

`~/.openviking/ov.conf` (backup in `ov.conf.bak`):
- `embedding.dense` -> OpenAI `text-embedding-3-small` (recall / semantic search).
- `vlm` -> OpenAI `gpt-4o-mini`, **`max_tokens: 16384`** (the model's cap; without it
  OpenViking requests 32768 and OpenAI rejects with 400).
- `output_language_override: "en"` -> forces memory extraction and summaries/overviews to
  English regardless of conversation language.
- The API key needs the **`model.request`** scope (chat), not just embedding - otherwise
  extraction fails with 401 and long-term memory never populates.

> Local alternative (no OpenAI): point `vlm.api_base` at an Ollama instance running a model
> that does real **tool-calling** (qwen2.5:7b+). `nemotron-3-nano:4b` does not follow
> OpenViking's "operations" protocol.

## Server persistence

- The **SessionStart** hook calls `~/.local/bin/openviking-start` (idempotent) if the
  server is down - auto-bootstrap.
- For full uptime independent of Claude Code, add `~/.local/bin/openviking-start` to
  `~/.bashrc`.
