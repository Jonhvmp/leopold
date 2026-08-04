# serena — LSP code intelligence (MCP)

[Serena](https://github.com/oraios/serena) (MIT, by oraios) gives the agent **IDE-grade,
symbol-level tools** over your code: `find_symbol`, `find_referencing_symbols`,
`get_symbols_overview`, `replace_symbol_body`, `insert_after_symbol`, … backed by a real
language server (40+ languages).

**Why Leopold treats it as mandatory.** It is the biggest single lever for both:

- **Code quality** — cross-file renames, reference lookups, and refactors become one
  atomic, semantics-aware call instead of fragile grep + text surgery.
- **Lean context (cost)** — it reads the *symbol*, not the whole file. Far fewer tokens per
  operation, which is exactly the discipline that keeps a `/leopold-run` cheap.

## What the install does

`make serena-install` (run automatically by Leopold's installer; idempotent):

1. Installs Serena via uv: `uv tool install -p 3.13 serena-agent` (puts `serena` +
   `serena-hooks` on PATH; uv is the only prerequisite).
2. Registers the MCP server for **all** your projects, **once per harness on this machine**.
3. Wires Serena's recommended **hooks** — `remind` (nudge toward symbolic tools),
   `auto-approve` (Serena tools in permissive modes), `activate` (project at session
   start), `cleanup` — into that harness's own config, idempotently.

| | Claude Code | Codex CLI |
|---|---|---|
| MCP registration | `claude mcp add --scope user serena -- serena start-mcp-server --context=claude-code --project-from-cwd` | `codex mcp add serena -- serena start-mcp-server --context=codex --project-from-cwd` |
| Hooks live in | `~/.claude/settings.json` (JSON) | `~/.codex/config.toml` (TOML, in a marker-delimited `leopold:serena` block) |
| `serena-hooks --client` | `claude-code` | `codex` |

Both formats are written by the one shared helper in `extensions/lib/harness.sh` — the
same writer the Leopold installers use — so the two harnesses cannot drift apart. Set
`LEOPOLD_HARNESS=claude|codex|all` to override which ones are targeted; the default
(`auto`) takes whatever is actually on the machine.

> Setup is the **official** path, *not* the MCP marketplace — the Serena maintainers warn
> the marketplace ships outdated install commands.

After install, reconnect with `/mcp` (or restart the agent) to load the tools.

**Codex only:** Codex holds a config-declared hook *inert* until you approve it once. Open
Codex and accept the Serena hooks to make them live in interactive sessions. `manage.sh
doctor` says so on every run rather than reporting a green that isn't live yet.

## Manage

```bash
bash manage.sh {detect|status|install|update|remove|doctor}
# or via Leopold:  make serena-install  ·  make serena-doctor  ·  make menu
```

`status` and `doctor` report **one segment per harness** — on a two-harness box you see
Serena's MCP and hook state for Claude Code *and* Codex CLI, never one passed off as both.
`remove` unregisters the MCP and unwires the hooks on every harness (keeps the `serena`
CLI; remove it with `uv tool uninstall serena-agent`).

Behavior is covered by `make serena-test` (hermetic: temp `HOME`/`CLAUDE_HOME`/`CODEX_HOME`,
stubbed `serena`/`uv`, no network, no package install).

## Notes

- Needs the harness's own CLI (`claude` / `codex`) on PATH for automatic MCP registration;
  otherwise the installer prints the exact command to run manually, per harness.
- Claude Code's built-in tool descriptions bias the model toward its own tools. If Serena's
  tools seem under-used, the `remind` hook (wired by default) nudges it; you can also start
  Claude with `claude --system-prompt="$(serena prompts print-cc-system-prompt-override)"`.
- On Codex the `auto-approve` hook is wired with an **empty matcher** on purpose. Codex's
  MCP tool-naming prefix is not something this repo has verified end to end, and a matcher
  guessed wrong would silently disable the hook; `serena-hooks auto-approve` already gates
  on the tool name *and* the permission mode and stays silent otherwise.
- Per-project config lands in `.serena/` on first activation; the global config is
  `~/.serena/serena_config.yml`.
