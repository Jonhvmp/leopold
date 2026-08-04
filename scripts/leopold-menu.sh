#!/usr/bin/env bash
# Leopold - toolchain manager.
# A data-driven menu over the extension registry in ../extensions/. Each extension
# is a self-contained folder with an extension.json (metadata) and a manage.sh that
# implements: detect | status | install | update | remove | doctor.
#
# Works from a clone (./scripts/leopold-menu.sh) and from an install under any
# harness - ~/.claude/leopold/scripts/ on a Claude Code machine,
# ~/.codex/leopold/scripts/ on a Codex-only one. The registry is resolved relative
# to this script first, then against the asset home each harness would use, so a
# machine with no ~/.claude still finds all four extensions.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATES=(
  "$HERE/../extensions"
  "${LEOPOLD_HOME:-}/extensions"
  "${CLAUDE_HOME:-$HOME/.claude}/leopold/extensions"
  "${CODEX_HOME:-$HOME/.codex}/leopold/extensions"
)
EXT_DIR=""
for cand in "${CANDIDATES[@]}"; do
  if [ -n "$cand" ] && [ -d "$cand" ]; then EXT_DIR="$(cd "$cand" && pwd)"; break; fi
done
if [ -z "$EXT_DIR" ]; then
  echo "No extensions registry found. Looked in:" >&2
  for cand in "${CANDIDATES[@]}"; do [ -n "$cand" ] && echo "  $cand" >&2; done
  exit 1
fi

# The shared harness helper ships inside the registry, so it is found wherever the
# registry was. It answers which harnesses are on this machine and where their
# files live - the menu must never assume ~/.claude exists.
# shellcheck source=../extensions/lib/harness.sh
if [ -f "$EXT_DIR/lib/harness.sh" ]; then . "$EXT_DIR/lib/harness.sh"; else
  echo "Extensions registry at $EXT_DIR is missing lib/harness.sh - reinstall Leopold." >&2
  exit 1
fi

# ---- tiny helpers -----------------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""
fi

_jget() { # file key  -> value (jq preferred, python3 fallback)
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$2" '.[$k] // empty' "$1" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2" 2>/dev/null
  fi
}

list_exts() { # prints extension dirs, sorted by .order
  for d in "$EXT_DIR"/*/; do
    [ -f "${d}extension.json" ] || continue
    local order; order="$(_jget "${d}extension.json" order)"; [ -n "$order" ] || order=99
    printf "%03d\t%s\n" "$order" "${d%/}"
  done | sort -n | cut -f2
}

ext_installed() { bash "$1/manage.sh" detect >/dev/null 2>&1; }

# A status probe can be slow (it may ask an MCP server or the network), and the menu
# draws one per installed extension. Bound it so opening the menu is never a 30s
# freeze - and say so when it trips, because a blank status that reads as "fine" is
# exactly the silent degradation this tool must not do.
ext_status() { # dir -> one status line
  local out rc
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout "${LEOPOLD_MENU_STATUS_TIMEOUT:-8}" bash "$1/manage.sh" status 2>/dev/null)"; rc=$?
    [ "$rc" = 124 ] && { printf 'status check timed out'; return 0; }
  else
    out="$(bash "$1/manage.sh" status 2>/dev/null)"
  fi
  printf '%s' "$out"
}
ext_run()       { bash "$1/manage.sh" "$2"; }

ext_caps() { # extension.json -> space-separated capabilities (empty if none)
  if command -v jq >/dev/null 2>&1; then
    jq -r '(.capabilities // []) | join(" ")' "$1" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys;print(' '.join(json.load(open(sys.argv[1])).get('capabilities',[])))" "$1" 2>/dev/null
  fi
}

# Show an extension's declared capabilities and require explicit consent before
# install/update grants them. No declaration -> nothing to gate, proceed.
ext_consent() { # dir -> 0 if the user consents
  local caps; caps="$(ext_caps "$1/extension.json")"
  [ -n "$caps" ] || return 0
  printf "\n  %sThis extension requests:%s %s%s%s\n" "$C_BOLD" "$C_RESET" "$C_YELLOW" "$caps" "$C_RESET"
  printf "  Install/update grants these. Proceed? [y/N] "
  local a; read -r a || a=""
  case "$a" in [yY]*) return 0 ;; *) echo "  cancelled."; return 1 ;; esac
}

pause() { printf "\n%spress Enter to continue%s " "$C_DIM" "$C_RESET"; read -r _ || true; }

# ---- screens ----------------------------------------------------------------

header() {
  clear 2>/dev/null || true
  printf "%s========================================%s\n" "$C_CYAN" "$C_RESET"
  printf "%s  Leopold%s - toolchain manager\n" "$C_BOLD" "$C_RESET"
  printf "%s========================================%s\n" "$C_CYAN" "$C_RESET"
  # Which harnesses this menu is managing, and where it will read/write. Silent
  # here would mean uninstalling "everything" on a two-harness box without saying
  # which two.
  local h labels=""
  for h in $(leo_harness_targets); do labels="${labels:+$labels + }$(leo_harness_label "$h")"; done
  printf "%s  %s · %s%s\n\n" "$C_DIM" "$labels" "$EXT_DIR" "$C_RESET"
}

# Does this MACHINE have both harnesses? Deliberately not leo_has_harness: that one
# answers "is it in the current scope", which goes false the moment you narrow to one
# — and then the switch that narrowed it would disappear, with no way back. This asks
# the machine, not the scope, so the toggle stays reachable in every position.
both_harnesses() {
  { command -v claude >/dev/null 2>&1 || [ -d "$(leo_claude_home)" ]; } \
    && { command -v codex >/dev/null 2>&1 || [ -d "$(leo_codex_home)" ]; } && echo 1 || echo 0
}

# What every action in this menu will touch, right now.
scope_label() {
  case "${LEOPOLD_HARNESS:-auto}" in
    claude|claude-code) printf 'Claude Code only' ;;
    codex|openai)       printf 'Codex CLI only' ;;
    *)                  printf 'both' ;;
  esac
}

# Cycle both -> Claude only -> Codex only -> both. Exported, because every extension
# this menu shells out to reads LEOPOLD_HARNESS to decide what it writes — which is
# the whole point: narrow the scope once, and install/remove/doctor all follow.
cycle_harness() {
  case "${LEOPOLD_HARNESS:-auto}" in
    claude|claude-code) LEOPOLD_HARNESS=codex ;;
    codex|openai)       LEOPOLD_HARNESS=all ;;
    *)                  LEOPOLD_HARNESS=claude ;;
  esac
  export LEOPOLD_HARNESS
}

main_menu() {
  header
  MENU_PATHS=()
  local i=1 d title summary st
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    MENU_PATHS+=("$d")
    title="$(_jget "$d/extension.json" title)"; [ -n "$title" ] || title="$(basename "$d")"
    summary="$(_jget "$d/extension.json" summary)"
    if ext_installed "$d"; then
      st="${C_GREEN}installed${C_RESET}"
      local s; s="$(ext_status "$d")"; [ -n "$s" ] && st="$st ${C_DIM}($s)${C_RESET}"
    else
      st="${C_DIM}not installed${C_RESET}"
    fi
    printf "  %s%2d%s) %s%-12s%s %s\n      %s%s%s\n\n" \
      "$C_BOLD" "$i" "$C_RESET" "$C_BOLD" "$title" "$C_RESET" "$st" "$C_DIM" "$summary" "$C_RESET"
    i=$((i + 1))
  done < <(list_exts)
  # The harness switch only earns a slot when there is a second harness to switch to.
  # On a one-harness box it would be a control that cannot change anything.
  if [ "$(both_harnesses)" = "1" ]; then
    printf "   %sd%s) Doctor all     %su%s) Uninstall     %sh%s) Harness: %s     %sq%s) Quit\n\n" \
      "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$(scope_label)" \
      "$C_BOLD" "$C_RESET"
  else
    printf "   %sd%s) Doctor all     %su%s) Uninstall     %sq%s) Quit\n\n" \
      "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  fi
}

component_menu() {
  local d="$1" title
  title="$(_jget "$d/extension.json" title)"; [ -n "$title" ] || title="$(basename "$d")"
  while true; do
    header
    local st="not installed"
    ext_installed "$d" && st="installed${C_RESET} ${C_DIM}($(ext_status "$d"))"
    printf "  %s%s%s\n  status: %s%s\n\n" "$C_BOLD" "$title" "$C_RESET" "$C_GREEN" "$st"
    printf "  %s%s%s\n\n" "$C_DIM" "$(_jget "$d/extension.json" summary)" "$C_RESET"
    local caps; caps="$(ext_caps "$d/extension.json")"
    [ -n "$caps" ] && printf "  %scapabilities:%s %s\n\n" "$C_DIM" "$C_RESET" "$caps"
    local has_dash=""; [ -n "$(_jget "$d/extension.json" dashboard)" ] && has_dash=1
    local has_tog="";  [ -n "$(_jget "$d/extension.json" toggle)" ] && has_tog=1
    local extra=""
    [ -n "$has_tog" ]  && extra="$extra    t) Toggle on/off"
    [ -n "$has_dash" ] && extra="$extra    w) Watch"
    printf "   1) Install    2) Update    3) Remove    4) Doctor%s    b) Back\n\n" "$extra"
    printf "select: "; read -r a || a="b"
    case "$a" in
      1) ext_consent "$d" && { ext_run "$d" install || echo "${C_YELLOW}install returned non-zero${C_RESET}"; }; pause ;;
      2) ext_consent "$d" && { ext_run "$d" update  || echo "${C_YELLOW}update returned non-zero${C_RESET}"; }; pause ;;
      3) ext_run "$d" remove  || echo "${C_YELLOW}remove returned non-zero${C_RESET}";  pause ;;
      4) ext_run "$d" doctor  || true; pause ;;
      t|T) [ -n "$has_tog" ] && { ext_run "$d" toggle || true; }; pause ;;
      w|W) [ -n "$has_dash" ] && { ext_run "$d" watch || true; }; pause ;;
      b|B|"") return ;;
      *) ;;
    esac
  done
}

doctor_all() {
  header
  local d
  for d in "${MENU_PATHS[@]}"; do
    printf "%s== %s ==%s\n" "$C_CYAN" "$(basename "$d")" "$C_RESET"
    ext_run "$d" doctor || true
    echo
  done
  pause
}

# ---- uninstall (granular, data-safe) ---------------------------------------

confirm() { # prompt -> 0 if yes
  printf "%s [y/N] " "$1"
  local a; read -r a || a=""
  case "$a" in [yY]*) return 0 ;; *) echo "  skipped." ; return 1 ;; esac
}
ext_path() { [ -d "$EXT_DIR/$1" ] && printf "%s" "$EXT_DIR/$1"; }
CLAUDE="$(leo_claude_home)"
CODEX="$(leo_codex_home)"

# The asset home to uninstall. It is NOT re-derived from the environment: install.sh
# picks the home from the explicit --harness flag and persists that choice nowhere, so
# leo_asset_home would answer ~/.claude/leopold on any box that merely has a `claude`
# binary — while the real install sits under ~/.codex/leopold. Deleting the wrong path
# and reporting success is the exact half-uninstall this must never do.
# This menu ships INSIDE the asset home, so the registry we already resolved knows the
# truth: the home is the registry's parent. Only trust it when that parent looks like an
# install (hooks/ + VERSION) and not like a source clone (.git / install.sh / skills/) —
# running the menu out of a checkout must never rm -rf the repo.
_ext_parent="$(cd "$EXT_DIR/.." && pwd)"
if [ -d "$_ext_parent/hooks" ] && [ -f "$_ext_parent/VERSION" ] \
   && [ ! -d "$_ext_parent/.git" ] && [ ! -f "$_ext_parent/install.sh" ] && [ ! -d "$_ext_parent/skills" ]; then
  ASSETS="$_ext_parent"
else
  ASSETS="$(leo_asset_home)"
fi

# Unwire + delete per harness. Removing Leopold from a Codex machine while leaving
# its hooks declared in config.toml would be the worst kind of half-uninstall: the
# UI says gone, the harness still calls scripts that no longer exist.
remove_core_claude() {
  local settings="$CLAUDE/settings.json" tmp d
  if [ -f "$settings" ] && command -v jq >/dev/null 2>&1; then
    cp "$settings" "$settings.leopold.bak"
    # the core installer also wires the prompt enhancer, so core removal strips it too
    tmp="$(mktemp)"
    jq 'if .hooks then .hooks |= ( to_entries
          | map(.value |= ( map(.hooks |= map(select((.command // "") | test("leopold/hooks/|enhance\\.py --event") | not)))
                            | map(select((.hooks | length) > 0)) ))
          | from_entries ) else . end' "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "  unwired Leopold's Stop/PreToolUse/UserPromptSubmit hooks (backup at $settings.leopold.bak)"
  fi
  for d in "$CLAUDE"/skills/leopold-*; do [ -d "$d" ] && rm -rf "$d"; done
  echo "  removed the leopold-* skills from $CLAUDE/skills"
  # The enhance dir is DATA (ledger + learned prompt profile). This screen promises the
  # data is kept unless a DATA item is picked, so core removal leaves it — item 6 is the
  # one that deletes it, and it says so in yellow.
  _enh="$(leo_enhance_dir)"
  [ -d "$_enh" ] && echo "  kept your enhance data at $_enh (delete it with uninstall item 6)" || true
}

remove_core_codex() {
  local config="$CODEX/config.toml" d
  if [ -f "$config" ]; then
    cp "$config" "$config.leopold.bak"
    local tmp; tmp="$(mktemp)"
    # Drop every managed block: "# >>> leopold (managed) >>>" and "# >>> leopold:<tag> ...".
    awk '
      /^# >>> leopold(:[A-Za-z0-9_-]+)? \(managed\) >>>$/ { skip = 1; next }
      /^# <<< leopold(:[A-Za-z0-9_-]+)? \(managed\) <<<$/ { skip = 0; next }
      !skip { print }
    ' "$config" > "$tmp" && mv "$tmp" "$config"
    echo "  removed Leopold's managed hook blocks from $config (backup at $config.leopold.bak)"
  fi
  for d in "$CODEX"/skills/leopold-*; do [ -d "$d" ] && rm -rf "$d"; done
  echo "  removed the leopold-* skills from $CODEX/skills"
  # Same rule as the Claude side: the enhance dir is data, and only the DATA item removes it.
  # One dir for the machine (leo_enhance_dir), so this is the same data either way.
  _enh="$(leo_enhance_dir)"
  [ -d "$_enh" ] && echo "  kept your enhance data at $_enh (delete it with uninstall item 6)" || true
}

remove_core() {
  local h
  for h in $(leo_harness_targets); do
    case "$h" in
      claude) remove_core_claude ;;
      codex)  remove_core_codex ;;
    esac
  done
  if [ -d "$ASSETS" ]; then
    rm -rf "$ASSETS" 2>/dev/null || true
    if [ -d "$ASSETS" ]; then echo "  could not remove the asset home $ASSETS — remove it by hand"
    else echo "  removed the asset home $ASSETS"; fi
  else
    echo "  no asset home at $ASSETS — nothing to remove there"
  fi
}

remove_cli() {
  if command -v npm >/dev/null 2>&1; then
    npm uninstall -g leopold-driver >/dev/null 2>&1 \
      && echo "  uninstalled the leopold CLI (npm)" \
      || echo "  (leopold CLI not installed via npm, or it needs sudo)"
  else
    echo "  npm not found — nothing to do for the CLI"
  fi
}

remove_ext() { # name
  local d; d="$(ext_path "$1")"
  [ -n "$d" ] && ext_run "$d" remove || echo "  ($1 extension not found in this build)"
}

remove_ovmem_data() {
  printf "%s  This DELETES ~/.openviking — your ENTIRE long-term memory — and uninstalls\n" "$C_YELLOW"
  printf "  the OpenViking server. There is no undo.%s\n" "$C_RESET"
  printf "  Type %sDELETE%s to confirm: " "$C_BOLD" "$C_RESET"
  local a; read -r a || a=""
  [ "$a" = "DELETE" ] || { echo "  skipped (not confirmed)."; return; }
  pkill -f "openviking-server" 2>/dev/null || true
  command -v uv >/dev/null 2>&1 && uv tool uninstall openviking >/dev/null 2>&1 && echo "  uninstalled the openviking server" || true
  rm -rf "$HOME/.openviking" 2>/dev/null && echo "  deleted ~/.openviking (long-term memory)" || true
}

uninstall_menu() {
  header
  printf "  %sUninstall Leopold%s — pick exactly what to remove.\n" "$C_BOLD" "$C_RESET"
  printf "  %sYour data is KEPT unless you pick a DATA item; each pick is confirmed.%s\n\n" "$C_DIM" "$C_RESET"
  printf "   1) Leopold core        skills + hooks + %s (the harness)\n" "$ASSETS"
  printf "   2) leopold CLI         npm uninstall -g leopold-driver\n"
  printf "   3) serena              unregister MCP + unwire hooks (keeps the serena CLI)\n"
  printf "   4) gstack              remove the skill suite\n"
  printf "   5) ovmem               unwire hooks + remove engine %s(keeps your memory)%s\n" "$C_DIM" "$C_RESET"
  printf "   6) enhance              unwire hook + %sDELETE%s the enhance dir (ledger + learned profile)\n" "$C_YELLOW" "$C_RESET"
  printf "   7) %sovmem DATA + server   ~/.openviking + OpenViking — DELETES memory!%s\n\n" "$C_YELLOW" "$C_RESET"
  printf "   a) everything except ovmem DATA (1-6)      q) cancel\n\n"
  printf "pick (space-separated, e.g. \"1 2 5\"): "
  local picks p; read -r picks || picks="q"
  case "$picks" in q|Q|"") return ;; a|A) picks="1 2 3 4 5 6" ;; esac
  echo
  printf "%sSelected: %s%s\n" "$C_BOLD" "$picks" "$C_RESET"
  confirm "Proceed with the removals above?" || { pause; return; }
  echo
  for p in $picks; do
    case "$p" in
      1) confirm "Remove Leopold core (skills + hooks)?"        && remove_core ;;
      2) confirm "Uninstall the leopold CLI (npm -g)?"          && remove_cli ;;
      3) confirm "Remove serena (MCP + hooks)?"                 && remove_ext serena ;;
      4) confirm "Remove gstack?"                               && remove_ext gstack ;;
      5) confirm "Remove ovmem engine (keeps your memory)?"     && remove_ext ovmem ;;
      6) confirm "Remove enhance (deletes its ledger + learned profile)?" && remove_ext enhance ;;
      7) remove_ovmem_data ;;
      *) echo "  ignored: '$p'" ;;
    esac
  done
  echo
  printf "%sUninstall done.%s\n" "$C_GREEN" "$C_RESET"
  pause
}

# ---- main loop --------------------------------------------------------------

while true; do
  main_menu
  printf "select a component [number, d, q]: "; read -r choice || choice="q"
  case "$choice" in
    q|Q) echo; exit 0 ;;
    d|D) doctor_all ;;
    u|U) uninstall_menu ;;
    h|H) [ "$(both_harnesses)" = "1" ] && cycle_harness ;;
    ''|*[!0-9]*) ;;  # ignore non-numeric
    *)
      idx=$((choice - 1))
      if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#MENU_PATHS[@]}" ]; then
        component_menu "${MENU_PATHS[$idx]}"
      fi
      ;;
  esac
done
