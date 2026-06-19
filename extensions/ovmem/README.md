# ovmem extension

**ovmem** gives Claude Code autonomous, self-managing long-term memory: it wires
[OpenViking](https://github.com/volcengine/OpenViking) (a hierarchical context DB) to
Claude Code through 4 native hooks, so any session stays optimized without destructive
`/compact` or `/clear`. Distillation, dedup and reconsolidation happen server-side; a
weekly hotness prune keeps the store from accumulating.

The installer is a **provider + model picker**. It runs `detect / status / install /
update / remove / doctor` like every extension; `install` walks you through:

```
Provider:  1) openai   2) bedrock
chat model:   gpt-4o-mini  $0.15 in / $0.60 out per 1M · ctx 128k · cheap default
              ...
embed model:  text-embedding-3-small  $0.02 per 1M · 1536d · default
              ...
```

Prices and the model lineup live in [`models.json`](models.json) — the single source the
picker reads (USD per 1M tokens, approximate, sourced from the LiteLLM price map). For
ovmem the real cost is **cents**: extraction only runs at PreCompact / SessionEnd.

## Providers

### OpenAI

One API key (needs the **embedding** and **`model.request`/chat** scopes). The installer
validates the key against both before saving it to `~/.openviking/ov.conf` (`chmod 600`).

- chat: `gpt-4o-mini` (default) · `gpt-4.1-mini` · `gpt-4o`
- embed: `text-embedding-3-small` (1536d, default) · `text-embedding-3-large` (3072d)

### AWS Bedrock

Routed through OpenViking's LiteLLM backends. Auth is a **Bedrock API key (bearer token)**
plus a **region** — that is all the user passes. The installer:

- adds `boto3` to the OpenViking tool venv (`uv tool install --with boto3 …`),
- writes the bearer token + region into the server's launch env (`openviking-start`, `chmod 700`),
- sets `vlm.provider` / `embedding.dense.provider` to `litellm` with `bedrock/…` model ids.

- chat: `nova-lite` (cheapest) · `claude-3-5-haiku` · `claude-3-5-sonnet` · `claude-sonnet-4-5`
- embed: `titan-embed-v2` (1024d) · `cohere-embed-v3` (1024d) · `titan-embed-v1` (1536d)

> The chat model ids use the `us.` cross-region inference profile. The model must be
> **enabled in your AWS account** (Bedrock → Model access). The installer's round-trip
> step surfaces a clear error if access/region/token is wrong. The Bedrock path is
> implemented against OpenViking's verified config shape but has not been run against a
> live AWS account in CI — treat it as beta.

## Switching providers / reconfiguring

Run `install` (or `update`) from the toolchain menu again — it is also the reconfigure
path. It detects the current setup, **offers to reuse the existing credential**, defaults
every prompt to your current choice, and:

- **Chat-only change** (or new model, same embedding) → just rewrites `ov.conf` and
  restarts. Your memories are untouched.
- **Embedding change** (e.g. OpenAI → Bedrock, where the dimension goes 1536 → 1024) →
  the vector index is **rebuilt**: it backs up and drops the index, lets the server
  recreate it at the new dimension, then re-embeds every memory (`content/reindex`). Your
  memory **content is preserved** — only the index is rebuilt. If the rebuild fails, the
  previous index **and** config are restored automatically.

Server restarts are lock-aware (one OpenViking process per data dir — a kill+restart race
on the data-dir lock is exactly what breaks otherwise).

## Notes that bite

- **The embedding model sets the vector dimension** (1536 / 3072 / 1024), baked into the
  vectordb. Changing it is handled by the reindex above, but it re-embeds the whole store
  (cents + a few seconds), so don't flip it casually.
- **`vlm.max_tokens`**: 16384 for OpenAI gpt-4o-mini (its cap), 8192 for Bedrock.
- **`output_language_override: "en"`** pins memory + summaries to English.

## Headless / CI install

No terminal? Set the choices via env (the picker reads `/dev/tty` interactively, or these
when there is none):

```bash
OVMEM_PROVIDER=openai  OVMEM_CHAT_MODEL=gpt-4o-mini  OVMEM_EMBED_MODEL=text-embedding-3-small \
  OPENAI_API_KEY=sk-... bash install.sh
# or
OVMEM_PROVIDER=bedrock OVMEM_CHAT_MODEL=claude-3-5-haiku OVMEM_EMBED_MODEL=titan-embed-v2 \
  AWS_BEARER_TOKEN_BEDROCK=... AWS_REGION=us-east-1 bash install.sh
```

## Runtime model (reference)

4 hooks → OpenViking REST:
- **SessionStart** — bootstrap the server + rehydrate (session summary + long-term memory)
- **UserPromptSubmit** — recall: inject memory relevant to the prompt (token-budgeted)
- **PreCompact** — flush the transcript delta + commit *before* compaction destroys it
- **SessionEnd** — flush + commit, then the weekly hotness prune (`ovmem-cleanup.py`)

Dedup and obsolescence are handled natively by OpenViking on commit. Cold-memory
accumulation is pruned by `ovmem-cleanup.py` (hotness = frequency × recency decay).
Everything is local: the server binds `127.0.0.1` only. The lone outbound call is to the
chosen provider (OpenAI or Bedrock, with the user's own credential) for embeddings/extraction.
