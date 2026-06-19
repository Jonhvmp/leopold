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
  printf "   %sd%s) Doctor all     %sq%s) Quit\n\n" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
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
    printf "   1) Install    2) Update    3) Remove    4) Doctor    b) Back\n\n"
    printf "select: "; read -r a || a="b"
    case "$a" in
      1) ext_run "$d" install || echo "${C_YELLOW}install returned non-zero${C_RESET}"; pause ;;
      2) ext_run "$d" update  || echo "${C_YELLOW}update returned non-zero${C_RESET}";  pause ;;
      3) ext_run "$d" remove  || echo "${C_YELLOW}remove returned non-zero${C_RESET}";  pause ;;
      4) ext_run "$d" doctor  || true; pause ;;
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

# ---- main loop --------------------------------------------------------------

while true; do
  main_menu
  printf "select a component [number, d, q]: "; read -r choice || choice="q"
  case "$choice" in
    q|Q) echo; exit 0 ;;
    d|D) doctor_all ;;
    ''|*[!0-9]*) ;;  # ignore non-numeric
    *)
      idx=$((choice - 1))
      if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#MENU_PATHS[@]}" ]; then
        component_menu "${MENU_PATHS[$idx]}"
      fi
      ;;
  esac
done
