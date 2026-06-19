#!/usr/bin/env bash
# serena extension — LSP-backed code intelligence (MCP) for Claude Code.
#
# Serena gives the agent IDE-grade, symbol-level tools (find_symbol,
# find_referencing_symbols, replace_symbol_body, ...) instead of grep + whole-file
# reads. That means sharper edits AND far fewer tokens — which is exactly the lever
# Leopold needs to keep an autonomous run's context lean. Mandatory for quality.
#
# Setup is the OFFICIAL path (uv tool + `claude mcp add`), NOT the MCP marketplace —
# the marketplace ships outdated commands (per the Serena maintainers).
set -euo pipefail

CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
SETTINGS="$CLAUDE/settings.json"
BIN="$HOME/.local/bin"
PKG="serena-agent"                                   # PyPI package -> `serena` + `serena-hooks`
MCP_ARGS="start-mcp-server --context=claude-code --project-from-cwd"

say()  { printf '\033[36m->\033[0m %s\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '   \033[33mwarn\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
sver() { serena --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
mcp_present()  { have claude && claude mcp get serena >/dev/null 2>&1; }
hooks_wired()  { [ -f "$SETTINGS" ] && grep -q 'serena-hooks ' "$SETTINGS" 2>/dev/null; }

wire_hooks() {
  have jq || { warn "jq missing; skipping Serena hook wiring (recommended for tool adherence)"; return 0; }
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  cp "$SETTINGS" "$SETTINGS.serena.bak"
  local rm="serena-hooks remind --client=claude-code" ap="serena-hooks auto-approve --client=claude-code"
  local ac="serena-hooks activate --client=claude-code" cl="serena-hooks cleanup --client=claude-code"
  local tmp; tmp="$(mktemp)"
  jq --arg rm "$rm" --arg ap "$ap" --arg ac "$ac" --arg cl "$cl" '
    .hooks //= {} | .hooks.PreToolUse //= [] | .hooks.SessionStart //= [] | .hooks.SessionEnd //= []
    | (if any(.hooks.PreToolUse[]?.hooks[]?;   .command==$rm) then . else .hooks.PreToolUse  += [{matcher:"",hooks:[{type:"command",command:$rm}]}] end)
    | (if any(.hooks.PreToolUse[]?.hooks[]?;   .command==$ap) then . else .hooks.PreToolUse  += [{matcher:"mcp__serena__*",hooks:[{type:"command",command:$ap}]}] end)
    | (if any(.hooks.SessionStart[]?.hooks[]?; .command==$ac) then . else .hooks.SessionStart += [{hooks:[{type:"command",command:$ac}]}] end)
    | (if any(.hooks.SessionEnd[]?.hooks[]?;   .command==$cl) then . else .hooks.SessionEnd   += [{hooks:[{type:"command",command:$cl}]}] end)
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  ok "Serena hooks wired: remind + auto-approve + activate + cleanup (backup at $SETTINGS.serena.bak)"
}

do_install() {
  if ! have uv; then
    say "installing uv (Serena's only prerequisite)"
    curl -LsSf https://astral.sh/uv/install.sh | sh || { warn "uv install failed"; return 1; }
    export PATH="$BIN:$PATH"
  fi
  if have serena && [ "${1:-install}" != update ]; then
    ok "serena already installed ($(sver))"
  else
    say "installing Serena (LSP code intelligence)"
    have serena || printf '   \033[2m(downloading serena-agent + deps — up to a minute on first install)\033[0m\n'
    uv tool install -p 3.13 "$PKG" || uv tool install "$PKG" \
      || { warn "uv tool install $PKG failed"; return 1; }
    export PATH="$BIN:$PATH"
  fi
  have serena || { warn "serena not on PATH after install (add $BIN to PATH)"; return 1; }
  ok "serena $(sver) ready"

  # Global config is created automatically on first run; only init if it is missing.
  if [ ! -f "$HOME/.serena/serena_config.yml" ]; then
    serena init </dev/null >/dev/null 2>&1 || warn "serena init skipped (the MCP server creates the global config on first start)"
  fi

  # Register the MCP server (user scope = all projects). claude mcp add is NOT idempotent,
  # so only add when it is not already present.
  if have claude; then
    if mcp_present; then ok "Serena MCP already registered (user scope)"
    else
      say "registering Serena MCP for Claude Code (user scope, all projects)"
      if claude mcp add --scope user serena -- serena $MCP_ARGS >/dev/null 2>&1; then ok "MCP registered"
      else warn "couldn't auto-register; run: claude mcp add --scope user serena -- serena $MCP_ARGS"; fi
    fi
  else
    warn "the 'claude' CLI is not on PATH — register manually once it is:"
    warn "  claude mcp add --scope user serena -- serena $MCP_ARGS"
  fi

  # Recommended hooks (counter Claude Code's bias toward its built-in tools).
  hooks_wired && ok "Serena hooks already wired" || wire_hooks
  echo
  ok "Serena ready. Reconnect with /mcp (or restart Claude Code) to load its tools."
}

case "${1:-}" in
  detect) have serena ;;
  status)
    if have serena; then
      printf 'serena %s' "$(sver)"
      mcp_present && printf ' · MCP connected' || printf ' · MCP not registered'
      hooks_wired && printf ' · hooks on'; echo
    else echo "not installed"; fi
    ;;
  install) do_install install ;;
  update)  do_install update ;;
  remove)
    if mcp_present; then claude mcp remove serena -s user >/dev/null 2>&1 && echo "unregistered Serena MCP"; fi
    if [ -f "$SETTINGS" ] && have jq; then
      cp "$SETTINGS" "$SETTINGS.serena.bak"
      tmp="$(mktemp)"
      jq 'if .hooks then .hooks |= ( to_entries
            | map(.value |= ( map(.hooks |= map(select((.command // "") | test("serena-hooks ") | not)))
                              | map(select((.hooks | length) > 0)) ))
            | from_entries ) else . end' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
      echo "unwired Serena hooks (backup at $SETTINGS.serena.bak)"
    fi
    echo "left installed: the serena CLI. To remove it too: uv tool uninstall $PKG"
    ;;
  doctor)
    echo "serena:   $(have serena && serena --version 2>/dev/null | head -1 || echo missing)"
    echo "MCP:      $(mcp_present && echo "registered (user scope)" || echo "not registered")"
    _hc="$(grep -c 'serena-hooks ' "$SETTINGS" 2>/dev/null || true)"; echo "hooks:    ${_hc:-0}/4 Serena hooks in settings.json"
    echo "uv:       $(have uv && echo present || echo missing)"
    have claude || echo "note:     'claude' CLI not found — MCP registration must be done manually"
    ;;
  *) echo "usage: manage.sh {detect|status|install|update|remove|doctor}" >&2; exit 2 ;;
esac
