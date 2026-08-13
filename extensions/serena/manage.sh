#!/usr/bin/env bash
# serena extension — LSP-backed code intelligence (MCP) for every harness Leopold runs on.
#
# Serena gives the agent IDE-grade, symbol-level tools (find_symbol,
# find_referencing_symbols, replace_symbol_body, ...) instead of grep + whole-file
# reads. That means sharper edits AND far fewer tokens — which is exactly the lever
# Leopold needs to keep an autonomous run's context lean. Mandatory for quality.
#
# Setup is the OFFICIAL path (uv tool + the harness's own `mcp add`), NOT the MCP
# marketplace — the marketplace ships outdated commands (per the Serena maintainers).
#
# HARNESS PARITY. Everything below is done once per harness on this machine:
#   Claude Code  claude mcp add --scope user   + hooks in ~/.claude/settings.json (JSON)
#   Codex CLI    codex  mcp add                + hooks in ~/.codex/config.toml    (TOML)
# The format-specific writers live in ONE place (../lib/harness.sh); this file only
# decides WHAT to wire, never HOW to spell it.
#
# Verified against codex-cli 0.146.0 and serena-agent on this machine:
#   - `codex mcp add|get|remove` honor CODEX_HOME and write [mcp_servers.<name>];
#     `mcp get` on a missing server exits non-zero, and re-adding replaces in place.
#   - Serena ships a first-class `codex` context (resources/config/contexts/codex.yml).
#   - `serena-hooks {remind,auto-approve,activate,cleanup} --client codex` all exist,
#     and serena's hook code branches on the codex client (shell-call detection, and
#     it omits additionalContext, which Codex does not consume).
#   - Codex's PreToolUse payload carries tool_name / tool_input / permission_mode /
#     cwd / transcript_path — the fields these hooks read — and reports its shell
#     tool as "Bash", so the remind hook sees shell greps and reads there too.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "serena/manage.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"

BIN="$HOME/.local/bin"
PKG="serena-agent"                                   # PyPI package -> `serena` + `serena-hooks`
MCP_NAME="serena"
HOOK_COUNT=4                                         # remind + auto-approve + activate + cleanup

say()  { printf '\033[36m->\033[0m %s\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '   \033[33mwarn\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
sver() { serena --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

# ---- per-harness facts -------------------------------------------------------

# Serena's context tuning per client. `codex` is a built-in Serena context, not a
# guess: resources/config/contexts/codex.yml ships in the package.
serena_context() { case "$1" in claude) echo "claude-code" ;; codex) echo "codex" ;; esac; }
# The --client value serena-hooks expects (its own enum: claude-code|vscode|codex).
serena_client()  { case "$1" in claude) echo "claude-code" ;; codex) echo "codex" ;; esac; }

# The MCP launch command, as an argv (one element per line).
mcp_argv() { # <harness>
  printf '%s\n' serena start-mcp-server "--context=$(serena_context "$1")" --project-from-cwd
}

# Where each harness keeps the hooks we wire.
hooks_file() { # <harness>
  case "$1" in claude) leo_settings_file ;; codex) leo_config_file ;; esac
}

# The four hook specs for a harness: EVENT|MATCHER|COMMAND|TIMEOUT.
#
# The matcher differs on purpose. On Claude Code the auto-approve hook is narrowed
# to mcp__serena__* because that prefix is Claude's own MCP tool naming. Codex's MCP
# tool naming is not something this repo has verified end to end, so the Codex hook
# runs with an empty matcher (all tools) and lets serena-hooks do the filtering — it
# already gates on the tool name AND the permission mode and stays silent otherwise.
# A matcher guessed wrong would silently disable the hook; an empty one cannot.
hook_specs() { # <harness>
  local c; c="$(serena_client "$1")"
  printf '%s\n' "PreToolUse||serena-hooks remind --client=$c|"
  case "$1" in
    claude) printf '%s\n' "PreToolUse|mcp__serena__*|serena-hooks auto-approve --client=$c|" ;;
    *)      printf '%s\n' "PreToolUse||serena-hooks auto-approve --client=$c|" ;;
  esac
  printf '%s\n' "SessionStart||serena-hooks activate --client=$c|"
  printf '%s\n' "SessionEnd||serena-hooks cleanup --client=$c|"
}

hooks_count() { # <harness> -> how many serena hooks are declared there
  local f n; f="$(hooks_file "$1")"
  [ -f "$f" ] || { echo 0; return; }
  n="$(grep -c 'serena-hooks ' "$f" 2>/dev/null || true)"
  echo "${n:-0}"
}
hooks_wired() { [ "$(hooks_count "$1")" -ge "$HOOK_COUNT" ]; }

# ---- wiring ------------------------------------------------------------------

wire_hooks() { # <harness>
  local h="$1" specs=() line
  while IFS= read -r line; do specs+=("$line"); done < <(hook_specs "$h")
  case "$h" in
    claude)
      have jq || { warn "$(leo_harness_label "$h"): jq missing; skipping Serena hook wiring"; return 0; }
      leo_wire_hooks_json "$(leo_settings_file)" serena "${specs[@]}" >/dev/null || return 1
      ;;
    codex)
      LEO_TOML_COMMENT="# Serena (Leopold extension). Reminds the agent to use symbol-level tools
# instead of grep/whole-file reads, auto-approves Serena's own tools under a
# permissive permission mode, and activates/cleans up the project per session." \
      leo_wire_hooks_toml "$(leo_config_file)" serena "${specs[@]}" >/dev/null || return 1
      ;;
  esac
  ok "$(leo_harness_label "$h"): hooks wired ($HOOK_COUNT: remind + auto-approve + activate + cleanup)"
}

register_mcp() { # <harness>
  local h="$1" argv=() line
  while IFS= read -r line; do argv+=("$line"); done < <(mcp_argv "$h")
  if ! leo_mcp_cli "$h" >/dev/null 2>&1; then
    warn "$(leo_harness_label "$h"): its CLI is not on PATH — register manually once it is:"
    warn "  $(leo_mcp_add_cmd "$h" "$MCP_NAME" "${argv[@]}")"
    return 0
  fi
  if leo_mcp_present "$h" "$MCP_NAME"; then
    ok "$(leo_harness_label "$h"): Serena MCP already registered"
    return 0
  fi
  say "registering Serena MCP for $(leo_harness_label "$h")"
  if leo_mcp_add "$h" "$MCP_NAME" "${argv[@]}"; then
    ok "$(leo_harness_label "$h"): MCP registered"
  else
    warn "$(leo_harness_label "$h"): couldn't auto-register; run:"
    warn "  $(leo_mcp_add_cmd "$h" "$MCP_NAME" "${argv[@]}")"
  fi
}

# ---- the global Serena config (~/.serena/serena_config.yml) ------------------
#
# One writer for this surface, same rule as the hook wiring: every read and write of
# the YAML goes through these helpers, always a targeted single-key edit (temp + mv,
# comments and every other line preserved), never a template rewrite. The file is
# Serena's, not ours — Leopold adjusts exactly the keys the user asked about and
# leaves the rest alone.

serena_cfg() { echo "$HOME/.serena/serena_config.yml"; }

cfg_get() { # <key> -> value, or "(absent)" when the file has no such line
  local f line; f="$(serena_cfg)"
  [ -f "$f" ] || { echo "(absent)"; return; }
  line="$(grep -m1 -E "^$1:" "$f" 2>/dev/null || true)"
  [ -n "$line" ] || { echo "(absent)"; return; }
  printf '%s\n' "${line#*:}" | sed 's/#.*$//' | awk '{$1=$1; print}'
}

cfg_set() { # <key> <value>  (atomic; appends when the key has no line yet)
  local f tmp; f="$(serena_cfg)"
  [ -f "$f" ] || return 1
  tmp="$(mktemp)" || return 1
  if grep -qE "^$1:" "$f"; then
    sed "s|^$1:.*|$1: $2|" "$f" > "$tmp" || { rm -f "$tmp"; return 1; }
  else
    cat "$f" > "$tmp" && printf '\n%s: %s\n' "$1" "$2" >> "$tmp" || { rm -f "$tmp"; return 1; }
  fi
  mv "$tmp" "$f"
}

# ---- commands ----------------------------------------------------------------

install_cli() { # <install|update>
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
  #
  # THE DASHBOARD DEFAULT. `serena init` writes `web_dashboard_open_on_launch: true`
  # (verified against serena-agent on this machine), and both harnesses register Serena
  # as a stdio MCP server — so every new CLI session spawns its own Serena process and
  # every one of them opens a browser tab. A day of sessions is a browser full of
  # dashboards nobody asked for. So:
  #   - a config THIS install just created  -> set the key to false (the dashboard
  #     stays reachable; it just stops hijacking the browser),
  #   - a pre-existing config missing the key -> append false (no choice is overridden,
  #     because none was ever expressed),
  #   - a pre-existing config that HAS the key -> leave it alone, whatever it says.
  #     Install and update never silently flip a value someone may have chosen; the
  #     `configure` menu below is where a deliberate change is made, both ways.
  local cfg_was_missing=""
  [ -f "$(serena_cfg)" ] || cfg_was_missing=1
  if [ -n "$cfg_was_missing" ]; then
    serena init </dev/null >/dev/null 2>&1 || warn "serena init skipped (the MCP server creates the global config on first start)"
  fi
  if [ -f "$(serena_cfg)" ]; then
    if [ -n "$cfg_was_missing" ] || [ "$(cfg_get web_dashboard_open_on_launch)" = "(absent)" ]; then
      if cfg_set web_dashboard_open_on_launch false; then
        ok "dashboard auto-open disabled (web_dashboard stays on — open it at http://localhost:24282/dashboard/)"
      fi
    elif [ "$(cfg_get web_dashboard_open_on_launch)" = "true" ]; then
      warn "Serena opens a dashboard tab on every session (web_dashboard_open_on_launch: true)."
      warn "  flip it in: leopold menu -> serena -> Settings"
    fi
  fi
}

# ---- configure: the Serena settings submenu ----------------------------------
#
# The keys that matter day to day, read live from the config and written back one at
# a time. A key this Serena version does not ship (its line is absent) is not offered
# a toggle — writing a setting the server never reads would be a control that lies.
do_configure() {
  local f; f="$(serena_cfg)"
  [ -f "$f" ] || { warn "no Serena config at $f — run install first (or start one Serena session)"; return 1; }
  local a v
  while true; do
    echo
    say "Serena settings ($f)"
    printf '   1) web_dashboard_open_on_launch  = %s   (toggle — the browser-tab-per-session fix)\n' "$(cfg_get web_dashboard_open_on_launch)"
    printf '   2) web_dashboard                 = %s   (toggle the dashboard server entirely)\n' "$(cfg_get web_dashboard)"
    printf '   3) log_level                     = %s   (cycle 10 debug / 20 info / 30 warn / 40 error)\n' "$(cfg_get log_level)"
    printf '   4) tool_timeout                  = %s   (edit, seconds)\n' "$(cfg_get tool_timeout)"
    printf '   5) token_count_estimator         = %s   (cycle CHAR_COUNT / TIKTOKEN_GPT4O / ANTHROPIC_CLAUDE_SONNET_4)\n' "$(cfg_get token_count_estimator)"
    [ "$(cfg_get record_tool_usage_stats)" != "(absent)" ] \
      && printf '   6) record_tool_usage_stats       = %s   (toggle)\n' "$(cfg_get record_tool_usage_stats)"
    grep -qE '^web_dashboard_interface:' "$f" 2>/dev/null \
      && printf '   7) web_dashboard_interface       = %s   (edit: empty, browser or tray_manager)\n' "$(cfg_get web_dashboard_interface)"
    printf '   b) back\n\n   select: '
    read -r a || a="b"
    case "$a" in
      1) case "$(cfg_get web_dashboard_open_on_launch)" in
           true) cfg_set web_dashboard_open_on_launch false ;;
           *)    cfg_set web_dashboard_open_on_launch true ;;
         esac ;;
      2) case "$(cfg_get web_dashboard)" in
           true) cfg_set web_dashboard false ;;
           *)    cfg_set web_dashboard true ;;
         esac ;;
      3) case "$(cfg_get log_level)" in
           10) cfg_set log_level 20 ;; 20) cfg_set log_level 30 ;;
           30) cfg_set log_level 40 ;; *)  cfg_set log_level 10 ;;
         esac ;;
      4) printf '   tool_timeout (seconds): '; read -r v || v=""
         case "$v" in
           ''|*[!0-9]*) warn "not a number — unchanged" ;;
           *) cfg_set tool_timeout "$v" ;;
         esac ;;
      5) case "$(cfg_get token_count_estimator)" in
           CHAR_COUNT)     cfg_set token_count_estimator TIKTOKEN_GPT4O ;;
           TIKTOKEN_GPT4O) cfg_set token_count_estimator ANTHROPIC_CLAUDE_SONNET_4 ;;
           *)              cfg_set token_count_estimator CHAR_COUNT ;;
         esac ;;
      6) [ "$(cfg_get record_tool_usage_stats)" = "(absent)" ] && continue
         case "$(cfg_get record_tool_usage_stats)" in
           true) cfg_set record_tool_usage_stats false ;;
           *)    cfg_set record_tool_usage_stats true ;;
         esac ;;
      7) grep -qE '^web_dashboard_interface:' "$f" 2>/dev/null || continue
         printf '   web_dashboard_interface (empty / browser / tray_manager): '; read -r v || v=""
         case "$v" in
           ""|browser|tray_manager) cfg_set web_dashboard_interface "$v" ;;
           *) warn "not one of: (empty), browser, tray_manager — unchanged" ;;
         esac ;;
      b|B|"") return 0 ;;
      *) ;;
    esac
    echo "   (running Serena instances pick changes up on their next session)"
  done
}

do_install() {
  install_cli "${1:-install}" || return 1
  local h
  for h in $(leo_harness_targets); do
    register_mcp "$h"
    if hooks_wired "$h"; then ok "$(leo_harness_label "$h"): Serena hooks already wired"; else wire_hooks "$h" || true; fi
  done
  echo
  ok "Serena ready. Reconnect with /mcp (or restart the agent) to load its tools."
  if leo_has_harness codex; then
    echo "   Codex holds a config-declared hook untrusted until you approve it once:"
    echo "   open Codex and accept the Serena hooks to make them live in interactive sessions."
  fi
}

do_remove() {
  local h label
  for h in $(leo_harness_targets); do
    label="$(leo_harness_label "$h")"
    if leo_mcp_present "$h" "$MCP_NAME" && leo_mcp_remove "$h" "$MCP_NAME"; then
      echo "$label: unregistered Serena MCP"
    fi
    case "$h" in
      claude) leo_unwire_hooks_json "$(leo_settings_file)" serena 'serena-hooks ' >/dev/null 2>&1 \
                && echo "$label: unwired Serena hooks" ;;
      codex)  leo_unwire_hooks_toml "$(leo_config_file)" serena >/dev/null 2>&1 \
                && echo "$label: unwired Serena hooks" ;;
    esac
  done
  echo "left installed: the serena CLI. To remove it too: uv tool uninstall $PKG"
}

case "${1:-}" in
  detect) have serena ;;
  status)
    # One line (the menu renders it inline), but never one harness's truth passed
    # off as the machine's: every resolved harness gets its own segment.
    if have serena; then
      printf 'serena %s' "$(sver)"
      for h in $(leo_harness_targets); do
        printf ' · %s: ' "$(leo_harness_label "$h")"
        leo_mcp_present "$h" "$MCP_NAME" && printf 'MCP on' || printf 'MCP off'
        printf ', hooks %s/%s' "$(hooks_count "$h")" "$HOOK_COUNT"
      done
      echo
    else echo "not installed"; fi
    ;;
  install)   do_install install ;;
  update)    do_install update ;;
  remove)    do_remove ;;
  configure) do_configure ;;
  doctor)
    echo "serena:   $(have serena && serena --version 2>/dev/null | head -1 || echo missing)"
    echo "uv:       $(have uv && echo present || echo missing)"
    for h in $(leo_harness_targets); do
      label="$(leo_harness_label "$h")"
      echo "$label:"
      if leo_mcp_cli "$h" >/dev/null 2>&1; then
        if leo_mcp_present "$h" "$MCP_NAME"; then
          echo "  MCP:    registered"
        else
          argv_str="$(mcp_argv "$h" | tr '\n' ' ')"
          # shellcheck disable=SC2086  # intentional word-split: argv_str is an argv line
          echo "  MCP:    not registered — run: $(leo_mcp_add_cmd "$h" "$MCP_NAME" $argv_str)"
        fi
      else
        echo "  MCP:    the $h CLI is not on PATH — registration must be done manually"
      fi
      echo "  hooks:  $(hooks_count "$h")/$HOOK_COUNT in $(hooks_file "$h")"
      if [ "$h" = codex ]; then
        echo "  note:   Codex keeps a config-declared hook inert until you approve it once."
      fi
    done
    ;;
  *) echo "usage: manage.sh {detect|status|install|update|remove|doctor|configure}" >&2; exit 2 ;;
esac
