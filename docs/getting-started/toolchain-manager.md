# Toolchain Manager

Leopold ships a small interactive menu to install and manage the toolchain it conducts
(gstack) and companion extensions (like ovmem and enhance) from one place. It generalizes the one-off
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
- `manage.sh` — the actions the menu calls: `detect | status | install | update | remove | doctor`,
  plus optional verbs an extension may declare in its `extension.json`: `toggle` (an on/off
  switch), `dashboard` (a `watch` view), and `configure` (a settings submenu, rendered as
  `s) Settings` on the component's screen).

The menu discovers everything in that folder, so **adding a component is dropping in a
folder** — no menu code changes. `detect` is the single source of truth for "installed?".
Each `manage.sh` must be idempotent, must never touch your git, and must never print secrets.

## Uninstall

The menu's **`u`** option removes Leopold, granularly and **data-safe**. It asks exactly
what to take out and confirms each pick — Leopold core (skills + hooks + `~/.claude/leopold`),
the `leopold` CLI, serena, gstack, and ovmem's engine all **keep your data**. Deleting
ovmem's long-term memory (`~/.openviking`) is a separate item that requires typing `DELETE`,
so nothing precious is removed by accident. The exception is **enhance**, whose entry says so
in yellow: its removal deletes `~/.claude/enhance` including the enhancement ledger and the
learned prompt profile (they are useless without the engine). Each extension's own `remove`
(used here) unwires its hooks and deletes its engine while leaving your data and any shared
server in place.

## Built-in extensions

### serena (mandatory)

[Serena](https://github.com/oraios/serena) (MIT) gives the agent **LSP-backed, symbol-level
tools** over MCP — `find_symbol`, `find_referencing_symbols`, `replace_symbol_body` — instead
of grep + whole-file reads. Leopold's installer sets it up automatically: it installs
`serena-agent` via uv if missing, then registers the MCP server for all projects and wires
Serena's recommended hooks **once per harness on the machine** — `claude mcp add --scope
user serena -- serena start-mcp-server --context=claude-code --project-from-cwd` plus hooks
in `~/.claude/settings.json` for Claude Code, and `codex mcp add serena -- serena
start-mcp-server --context=codex --project-from-cwd` plus hooks in `~/.codex/config.toml`
for Codex CLI. `manage.sh status` and `doctor` report each harness separately, so a
two-harness box never sees one harness's state passed off as both. (On Codex, hooks stay
inert until you approve them once — doctor says so.) It is the biggest single lever
for **code quality** *and* **lean context** (symbol-level reads cost far fewer tokens — the
same discipline the [cost guardrails](../guardrails.md) enforce),
which is why it is mandatory rather than optional. Setup uses Serena's official path, not the
MCP marketplace (which ships stale commands). Manage with `make serena-install` /
`make serena-doctor`.

**The dashboard stays out of your browser.** Serena's own default opens a dashboard tab on
every launch — and since each harness registers Serena as a stdio server, every new CLI
session spawns its own Serena and its own tab. The installer turns that off
(`web_dashboard_open_on_launch: false`) on the config it creates, or when the key was never
set; a value you chose yourself is never overridden by install or update. The dashboard
itself stays on — open it at `http://localhost:24282/dashboard/` whenever you want it.
Flip it back, and adjust Serena's other day-to-day settings (`log_level`, `tool_timeout`,
`token_count_estimator`, …), under `leopold menu` → serena → **Settings** — each entry shows
the live value from `~/.serena/serena_config.yml`, writes back only the key you changed, and
running Serena instances pick changes up on their next session.

### gstack

The planning + QA skill suite Leopold conducts (`/spec`, `/autoplan`, `/plan-*-review`, …).
A separate MIT project by Garry Tan; the extension clones it and runs its setup. Needs Bun.

gstack skills are plain `SKILL.md` dirs, and **both harnesses discover them** — Claude Code
under `~/.claude/skills`, Codex CLI under `~/.codex/skills` — so the extension runs gstack's
own installer once per harness on this machine (`--host claude`, `--host codex`) and
`status`, `remove` and `doctor` report each one separately, counting the skills actually
visible in that skills root. A Codex-only box keeps the checkout in gstack's own
`~/.gstack/repos/gstack` (it refuses a checkout inside the Codex skills dir, which would
make every skill get discovered twice) and gets nothing under `~/.claude`. `make
gstack-install` / `make gstack-doctor`.

### ovmem

Autonomous RAG long-term memory: it wires [OpenViking](https://github.com/volcengine/OpenViking)
to your agent through 4 native hooks (SessionStart, UserPromptSubmit, PreCompact, SessionEnd),
so sessions stay optimized without destructive `/compact` or `/clear`. Distillation, dedup and
reconsolidation happen server-side; a weekly hotness prune keeps the store from accumulating.

Those four events exist on **Claude Code and Codex CLI**, and the installer declares them in
whichever harnesses are on the machine — `~/.claude/settings.json` in JSON, `~/.codex/config.toml`
in TOML. The memory store is a single one for the machine, so a decision recorded in a Codex
session comes back in a Claude Code one. Codex holds a config-declared hook inert until you
approve it once, and it caps `SessionEnd` at 3 seconds — so the end-of-session flush runs
detached there. `leopold doctor` and the extension's own doctor name every harness that is
still missing its wiring.

The installer ships the **OpenAI profile**:

- prompts for an OpenAI key, **validates it against chat + embeddings** before saving
  (it needs the `model.request` scope, not just embedding),
- writes `~/.openviking/ov.conf` (`chmod 600`), wires the 4 hooks idempotently into every
  harness present, and verifies end-to-end with a commit → extract round-trip.

Everything is **local and private**: the OpenViking server binds to `127.0.0.1` (loopback) on
the user's own device — it is not exposed to the network, and nothing points to a central
server. The only outbound traffic is to OpenAI (with the user's own key) for embeddings and
extraction. A fully-local Ollama/GGUF profile (no key) is on the roadmap.

Supported on Linux and macOS. On native Windows, run it inside WSL.

### enhance

The [global prompt enhancer](../reference/enhance.md): one `UserPromptSubmit` hook that has
Haiku — on your own connected account — produce a structured interpretation of genuinely weak
prompts ("fix login") and inject it next to the raw prompt, which always wins on conflict.
Charter-aware when the project has a Leopold brief, fail-open on any error, and self-learning
via `/leopold-enhance learn`. Unlike the other extensions it is installed (wired, but **off**)
by the main installer; the menu's `t) Toggle` action — or `/leopold-enhance on|off` — is the
switch. Needs python3 + jq; the rewriter uses your existing `claude` login, no extra key.
