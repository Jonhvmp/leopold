# Toolchain Manager

Leopold ships a small interactive menu to install and manage the toolchain it conducts
(gstack) and companion extensions (like ovmem) from one place. It generalizes the one-off
"install gstack?" prompt in the installer into a data-driven registry.

```bash
make menu
# or, from an install:
bash ~/.claude/leopold/scripts/leopold-menu.sh
```

```
========================================
  Leopold - toolchain manager
========================================
   1) Leopold   installed (v0.1.1)   — the harness (skills + hooks)
   2) gstack    installed            — planning / QA skill suite
   3) ovmem     not installed        — RAG long-term memory
   d) Doctor all     q) Quit
```

Pick a component to install, update, remove, or run its doctor.

## How the registry works

Every component lives under `extensions/<name>/` with two files:

- `extension.json` — metadata the menu renders (`name`, `title`, `summary`, `order`).
- `manage.sh` — the actions the menu calls: `detect | status | install | update | remove | doctor`.

The menu discovers everything in that folder, so **adding a component is dropping in a
folder** — no menu code changes. `detect` is the single source of truth for "installed?".
Each `manage.sh` must be idempotent, must never touch your git, and must never print secrets.

## Built-in extensions

### gstack

The planning + QA skill suite Leopold conducts (`/spec`, `/autoplan`, `/plan-*-review`, …).
A separate MIT project by Garry Tan; the extension clones it and runs its setup. Needs Bun.

### ovmem

Autonomous RAG long-term memory: it wires [OpenViking](https://github.com/volcengine/OpenViking)
to Claude Code through 4 native hooks (SessionStart, UserPromptSubmit, PreCompact, SessionEnd),
so sessions stay optimized without destructive `/compact` or `/clear`. Distillation, dedup and
reconsolidation happen server-side; a weekly hotness prune keeps the store from accumulating.

The installer ships the **OpenAI profile**:

- prompts for an OpenAI key, **validates it against chat + embeddings** before saving
  (it needs the `model.request` scope, not just embedding),
- writes `~/.openviking/ov.conf` (`chmod 600`), wires the 4 hooks idempotently, and
  verifies end-to-end with a commit → extract round-trip.

Everything is **local and private**: the OpenViking server binds to `127.0.0.1` (loopback) on
the user's own device — it is not exposed to the network, and nothing points to a central
server. The only outbound traffic is to OpenAI (with the user's own key) for embeddings and
extraction. A fully-local Ollama/GGUF profile (no key) is on the roadmap.

Supported on Linux and macOS. On native Windows, run it inside WSL.
