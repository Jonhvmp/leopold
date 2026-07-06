#!/usr/bin/env bash
# Leopold - toolchain manager.
# A data-driven menu over the extension registry in ../extensions/. Each extension
# is a self-contained folder with an extension.json (metadata) and a manage.sh that
# implements: detect | status | install | update | remove | doctor.
#
# Works both from a clone (./scripts/leopold-menu.sh) and from an install
# (~/.claude/leopold/scripts/leopold-menu.sh) - the extensions dir is resolved
# relative to this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR=""
for cand in "$HERE/../extensions" "${CLAUDE_HOME:-$HOME/.claude}/leopold/extensions"; do
  if [ -d "$cand" ]; then EXT_DIR="$(cd "$cand" && pwd)"; break; fi
done
if [ -z "$EXT_DIR" ]; then
  echo "No extensions registry found (looked for ../extensions and ~/.claude/leopold/extensions)." >&2
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
ext_status()    { bash "$1/manage.sh" status 2>/dev/null || true; }
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
  printf "%s========================================%s\n\n" "$C_CYAN" "$C_RESET"
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
  printf "   %sd%s) Doctor all     %su%s) Uninstall     %sq%s) Quit\n\n" \
    "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
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
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"

remove_core() {
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
  rm -rf "$CLAUDE/leopold" 2>/dev/null || true
  rm -rf "$CLAUDE/enhance" 2>/dev/null || true
  echo "  removed the leopold-* skills, $CLAUDE/leopold and $CLAUDE/enhance"
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
  printf "   1) Leopold core        skills + hooks + %s/leopold (the harness)\n" "$CLAUDE"
  printf "   2) leopold CLI         npm uninstall -g leopold-driver\n"
  printf "   3) serena              unregister MCP + unwire hooks (keeps the serena CLI)\n"
  printf "   4) gstack              remove the skill suite\n"
  printf "   5) ovmem               unwire hooks + remove engine %s(keeps your memory)%s\n" "$C_DIM" "$C_RESET"
  printf "   6) enhance              unwire hook + %sDELETE%s %s/enhance (ledger + learned profile)\n" "$C_YELLOW" "$C_RESET" "$CLAUDE"
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
    ''|*[!0-9]*) ;;  # ignore non-numeric
    *)
      idx=$((choice - 1))
      if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#MENU_PATHS[@]}" ]; then
        component_menu "${MENU_PATHS[$idx]}"
      fi
      ;;
  esac
done
