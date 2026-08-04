#!/usr/bin/env bash
# Behavior tests for the toolchain menu's harness switch (scripts/leopold-menu.sh).
#
# HERMETIC. PATH is rebuilt from scratch and HOME / CLAUDE_HOME / CODEX_HOME point
# inside a temp dir, so "does this machine have both harnesses" is something the test
# DECIDES rather than inherits. That is the whole point: the interesting cases are a
# two-harness box and a one-harness box, and a developer only ever has one of those.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MENU="$ROOT/scripts/leopold-menu.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then bad "$1"; else ok "$1"; fi; }

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
STUB="$TD/bin"; mkdir -p "$STUB"
for t in bash sh env grep sed awk cat printf jq python3 ls mkdir dirname basename \
         mktemp tr wc sort cut head tail rm cp mv chmod clear command curl; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$STUB/$t"
done

# Strip the terminal escapes the menu paints with, so assertions match plain text.
plain() { sed 's/\x1b\[[0-9;]*[mGKHJ]//g'; }

# Drive the menu with keystrokes in a sealed environment.
#
# <mode> decides HOW the second harness is present, and that distinction is the whole
# reason this helper exists:
#   both     — both home dirs on disk (the ordinary two-harness box)
#   both-bin — codex reachable on PATH with NO ~/.codex yet (a fresh codex install).
#              This is the only shape that catches a scope-dependent detector: with a
#              home dir around, the `|| [ -d … ]` fallback hides the bug.
#   claude   — one harness, nothing to switch to
drive() { # <mode> <keys>
  local mode="$1" keys="$2" h="$TD/$1" bin="$STUB"
  mkdir -p "$h/.claude"
  case "$mode" in
    both) mkdir -p "$h/.codex" ;;
    both-bin)
      bin="$TD/bin-$mode"; mkdir -p "$bin"
      ln -sf "$STUB"/* "$bin/" 2>/dev/null
      printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/codex"; chmod +x "$bin/codex" ;;
  esac
  printf '%b' "$keys" | env -i PATH="$bin" HOME="$h" \
    CLAUDE_HOME="$h/.claude" CODEX_HOME="$h/.codex" TERM=dumb \
    bash "$MENU" 2>&1 | plain
}

echo
echo "menu harness switch — a two-harness box gets the control"
out="$(drive both 'q\n')"
has "the switch is offered"        "$out" "h) Harness:"
has "and it starts on both"        "$out" "h) Harness: both"
has "the header names both"        "$out" "Claude Code + Codex CLI"

echo
echo "menu harness switch — h cycles both -> Claude -> Codex -> both"
out="$(drive both 'h\nh\nh\nq\n')"
labels="$(printf '%s' "$out" | grep -oE 'h\) Harness: (both|Claude Code only|Codex CLI only)' | sed 's/h) Harness: //')"
want="$(printf 'both\nClaude Code only\nCodex CLI only\nboth')"
if [ "$labels" = "$want" ]; then ok "the cycle visits every position and returns"
else bad "the cycle is wrong (got [$(printf '%s' "$labels" | tr '\n' '|')])"; fi

echo
echo "menu harness switch — narrowing the scope narrows what the menu reports"
out="$(drive both 'h\nq\n')"
has "after narrowing, the header names only Claude Code" "$out" "  Claude Code ·"
# The pre-narrow render must still have shown both, or the assertion above proves nothing.
has "the first render had shown both"                    "$out" "Claude Code + Codex CLI"

echo
echo "menu harness switch — the switch stays reachable after narrowing"
# Regression: the first cut asked leo_has_harness, which answers "is it in the CURRENT
# scope". Narrowing to Claude made that false for codex, the control vanished, and
# there was no way back to both. It must ask the MACHINE, not the scope.
#
# This runs in both-bin on purpose. With a ~/.codex directory present the buggy
# detector still passes on its `|| [ -d … ]` fallback — the assertion would be theatre.
# Codex-on-PATH-only is the shape where a scope-dependent answer actually breaks.
out="$(drive both-bin 'h\nq\n')"
has "the switch is offered when codex is on PATH with no home yet" "$out" "h) Harness:"
n="$(printf '%s' "$out" | grep -c 'h) Harness:')"
if [ "${n:-0}" -ge 2 ]; then ok "still offered after the scope narrowed"
else bad "the switch disappeared once the scope narrowed (rendered $n times)"; fi

echo
echo "menu harness switch — a one-harness box is not offered a choice"
out="$(drive claude 'q\n')"
hasnt "no switch when there is nothing to switch to" "$out" "h) Harness:"
has   "the other controls are still there"           "$out" "d) Doctor all"
has   "and the header names the one harness"         "$out" "Claude Code"

echo
if [ "$FAIL" -eq 0 ]; then printf '\033[32m%d passed, 0 failed\033[0m\n' "$PASS"; exit 0
else printf '\033[31m%d passed, %d FAILED\033[0m\n' "$PASS" "$FAIL"; exit 1; fi
