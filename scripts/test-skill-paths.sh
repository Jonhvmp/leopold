#!/usr/bin/env bash
# Leopold — skill path tests.
#
# Skills ship to more than one harness home, so no SKILL.md may hardcode one.
# This asserts two things, hermetically (temp CLAUDE_HOME/CODEX_HOME/LEOPOLD_HOME
# — it never reads or writes a real ~/.claude or ~/.codex):
#   1. no SKILL.md contains a literal ~/.claude or ~/.codex path
#   2. every bash snippet in a SKILL.md resolves the asset home and reaches the
#      real script, on a Claude-only layout, a Codex-only layout, and under a
#      LEOPOLD_HOME override
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
pass() { echo "  [ok]   $*"; }
bad()  { echo "  [FAIL] $*"; fail=1; }

echo "skill path tests"
echo

# --- 1. no hardcoded harness home --------------------------------------------
# Both spellings of a hardcoded home count: `~/.claude` and `$HOME/.claude`
# (and the Codex equivalents). Only the documented resolver default is allowed,
# i.e. `${CLAUDE_HOME:-$HOME/.claude}` / `${CODEX_HOME:-$HOME/.codex}`.
# The allowed default is blanked out of each line FIRST (so a line that mixes the
# resolver with a hardcoded path is still caught), then anything left that looks
# like a harness home is a failure.
hits="$(grep -rn '' "$HERE"/skills/*/SKILL.md 2>/dev/null \
        | sed -E 's/\$\{CLAUDE_HOME:-\$HOME\/\.claude\}//g; s/\$\{CODEX_HOME:-\$HOME\/\.codex\}//g' \
        | grep -E '[~]/\.(claude|codex)|\$\{?HOME\}?/\.(claude|codex)')"
if [ -z "$hits" ]; then
  pass "no SKILL.md hardcodes a harness home"
else
  bad "hardcoded harness home in a SKILL.md:"; printf '%s\n' "$hits"
fi

# --- 2. the snippets resolve and run ------------------------------------------
# A fake install: stub scripts that print where they were run from.
mk_home() {
  mkdir -p "$1/leopold/scripts" "$1/leopold/templates" "$1/enhance"
  for s in leopold-doctor leopold-update leopold-update-check; do
    printf '#!/bin/sh\necho "RAN %s"\n' "$s" > "$1/leopold/scripts/$s.sh"
    chmod +x "$1/leopold/scripts/$s.sh"
  done
  : > "$1/enhance/enhance.py"
}

# First fenced bash block of a SKILL.md — that is where the resolver lives.
snippet() { awk '/^```bash$/{f=1;next} /^```$/{if(f)exit} f' "$HERE/skills/$1/SKILL.md"; }

SNIPPET_SKILLS="leopold-doctor leopold-update leopold-run leopold-brief"

check_layout() { # <label> <claude home> <codex home> <fake HOME> <expected asset home>
  local label="$1" ch="$2" xh="$3" home="$4" want="$5" s out
  for s in $SNIPPET_SKILLS; do
    local snip; snip="$(snippet "$s")"
    if [ -z "$snip" ]; then bad "$s: no bash block to check"; continue; fi
    out="$(env -u LEOPOLD_HOME "CLAUDE_HOME=$ch" "CODEX_HOME=$xh" "HOME=$home" \
             PATH=/usr/bin:/bin bash -c "$snip" 2>&1)"
    case "$out" in
      *"No such file"*|*"not found"*) bad "$label $s: $out" ;;
      *RAN*)                          pass "$label $s runs from $want" ;;
      *)                              bad "$label $s: script never ran ($out)" ;;
    esac
  done
}

CH="$T/claude-only/.claude"; mk_home "$CH"
check_layout "Claude-only:" "$CH" "$T/claude-only/.codex" "$T/claude-only" "$CH/leopold"

XH="$T/codex-only/.codex"; mk_home "$XH"
check_layout "Codex-only: " "$T/codex-only/.claude" "$XH" "$T/codex-only" "$XH/leopold"

# Both present: Claude Code stays the asset home (no migration for existing installs).
BC="$T/both/.claude"; BX="$T/both/.codex"; mk_home "$BC"; mk_home "$BX"
out="$(env -u LEOPOLD_HOME "CLAUDE_HOME=$BC" "CODEX_HOME=$BX" "HOME=$T/both" PATH=/usr/bin:/bin \
        bash -c "$(snippet leopold-doctor)"$'\n''echo "$LEO"' 2>&1)"
case "$out" in *"$BC/leopold"*) pass "both harnesses: asset home stays under Claude Code" ;;
               *) bad "both harnesses: resolved to $out, expected $BC/leopold" ;; esac

# LEOPOLD_HOME wins outright.
OH="$T/override/leo"; mkdir -p "$OH/scripts"
printf '#!/bin/sh\necho "RAN leopold-doctor"\n' > "$OH/scripts/leopold-doctor.sh"
chmod +x "$OH/scripts/leopold-doctor.sh"
out="$(env "LEOPOLD_HOME=$OH" "CLAUDE_HOME=$CH" "CODEX_HOME=$XH" "HOME=$T/override" PATH=/usr/bin:/bin \
        bash -c "$(snippet leopold-doctor)"$'\n''echo "$LEO"' 2>&1)"
case "$out" in *"$OH"*) pass "LEOPOLD_HOME override wins" ;;
               *) bad "LEOPOLD_HOME override ignored ($out)" ;; esac

# --- 3. leopold-enhance resolves BOTH of its homes ----------------------------
for lbl in claude codex; do
  case "$lbl" in
    claude) ch="$CH"; xh="$T/claude-only/.codex"; home="$T/claude-only"; want="$CH" ;;
    codex)  ch="$T/codex-only/.claude"; xh="$XH"; home="$T/codex-only"; want="$XH" ;;
  esac
  out="$(env -u LEOPOLD_HOME "CLAUDE_HOME=$ch" "CODEX_HOME=$xh" "HOME=$home" PATH=/usr/bin:/bin \
          bash -c "$(snippet leopold-enhance)"$'\n''echo "$ENH|$LEO"' 2>&1)"
  if [ "$out" = "$want/enhance|$want/leopold" ]; then
    pass "leopold-enhance ($lbl): \$ENH and \$LEO both under $want"
  else
    bad "leopold-enhance ($lbl): got $out, expected $want/enhance|$want/leopold"
  fi
done

# --- 4. leopold-watch resolves the dashboard script ---------------------------
# Its snippet starts a server, so only the resolver lines (everything before the
# PORT= line) are executed, and the resolved $WATCH is asserted.
watch_resolver() { awk '/^```bash$/{f=1;next} /^```$/{if(f)exit} f && /^PORT=/{exit} f' "$HERE/skills/leopold-watch/SKILL.md"; }
for lbl in claude codex; do
  case "$lbl" in
    claude) ch="$CH"; xh="$T/claude-only/.codex"; home="$T/claude-only"; want="$CH" ;;
    codex)  ch="$T/codex-only/.claude"; xh="$XH"; home="$T/codex-only"; want="$XH" ;;
  esac
  : > "$want/leopold/scripts/leopold-watch.py"
  out="$(env -u LEOPOLD_HOME "CLAUDE_HOME=$ch" "CODEX_HOME=$xh" "HOME=$home" PATH=/usr/bin:/bin \
          bash -c "$(watch_resolver)"$'\n''echo "$WATCH"' 2>&1)"
  if [ "$out" = "$want/leopold/scripts/leopold-watch.py" ]; then
    pass "leopold-watch ($lbl): dashboard resolves to $want/leopold"
  else
    bad "leopold-watch ($lbl): got $out, expected $want/leopold/scripts/leopold-watch.py"
  fi
done

echo
if [ "$fail" = 0 ]; then echo "skill paths OK"; else echo "skill path tests FAILED"; fi
exit $fail
