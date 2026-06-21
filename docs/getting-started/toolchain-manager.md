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
   1) Leopold   installed             — the harness (skills + hooks)
   2) serena    installed             — LSP code intelligence (MCP, mandatory)
   3) gstack    installed             — planning / QA skill suite
   4) ovmem     not installed         — RAG long-term memory
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

## Uninstall

The menu's **`u`** option removes Leopold, granularly and **data-safe**. It asks exactly
what to take out and confirms each pick — Leopold core (skills + hooks + `~/.claude/leopold`),
the `leopold` CLI, serena, gstack, and ovmem's engine all **keep your data**. Deleting
ovmem's long-term memory (`~/.openviking`) is a separate item that requires typing `DELETE`,
so nothing precious is removed by accident. Each extension's own `remove` (used here) unwires
its hooks and deletes its engine while leaving your data and any shared server in place.

## Built-in extensions

### serena (mandatory)

[Serena](https://github.com/oraios/serena) (MIT) gives the agent **LSP-backed, symbol-level
tools** over MCP — `find_symbol`, `find_referencing_symbols`, `replace_symbol_body` — instead
of grep + whole-file reads. Leopold's installer sets it up automatically: it installs
`serena-agent` via uv if missing, registers the MCP server for all projects
(`claude mcp add --scope user serena -- serena start-mcp-server --context=claude-code
--project-from-cwd`), and wires Serena's recommended hooks. It is the biggest single lever
for **code quality** *and* **lean context** (symbol-level reads cost far fewer tokens — the
same discipline the [cost guardrails](../guardrails.md) enforce),
which is why it is mandatory rather than optional. Setup uses Serena's official path, not the
MCP marketplace (which ships stale commands). Manage with `make serena-install` /
`make serena-doctor`.

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
