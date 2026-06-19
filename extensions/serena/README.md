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
2. Registers the MCP server for **all** your projects (user scope):
   `claude mcp add --scope user serena -- serena start-mcp-server --context=claude-code --project-from-cwd`
3. Wires Serena's recommended **hooks** into `~/.claude/settings.json` (idempotent):
   `remind` (nudge toward symbolic tools), `auto-approve` (Serena tools in permissive
   modes), `activate` (project at session start), `cleanup`.

> Setup is the **official** path, *not* the MCP marketplace — the Serena maintainers warn
> the marketplace ships outdated install commands.

After install, reconnect with `/mcp` (or restart Claude Code) to load the tools.

## Manage

```bash
bash manage.sh {detect|status|install|update|remove|doctor}
# or via Leopold:  make serena-install  ·  make serena-doctor  ·  make menu
```

`remove` unregisters the MCP and unwires the hooks (keeps the `serena` CLI; remove it with
`uv tool uninstall serena-agent`).

## Notes

- Needs the `claude` CLI on PATH for automatic MCP registration; otherwise the installer
  prints the one command to run manually.
- Claude Code's built-in tool descriptions bias the model toward its own tools. If Serena's
  tools seem under-used, the `remind` hook (wired by default) nudges it; you can also start
  Claude with `claude --system-prompt="$(serena prompts print-cc-system-prompt-override)"`.
- Per-project config lands in `.serena/` on first activation; the global config is
  `~/.serena/serena_config.yml`.
