#!/usr/bin/env bash
# leopold doctor — verify the Leopold install: skills, hooks + wiring, gstack,
# the driver toolchain, and whether an update is available.
set -u
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
CODEX="${CODEX_HOME:-$HOME/.codex}"
SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
# The harness-neutral asset home: wherever the installer put the hooks.
if   [ -n "${LEOPOLD_HOME:-}" ];        then LEO_HOME="$LEOPOLD_HOME"
elif [ -d "$CLAUDE/leopold/hooks" ];    then LEO_HOME="$CLAUDE/leopold"
else                                         LEO_HOME="$CODEX/leopold"
fi
ok=0; warn=0; bad=0
pass(){ echo "  [ok]   $1"; ok=$((ok+1)); }
miss(){ echo "  [FAIL] $1"; bad=$((bad+1)); }
note(){ echo "  [warn] $1"; warn=$((warn+1)); }

# Which harnesses are actually here. Leopold runs on either; it only needs one.
HAVE_CLAUDE=0; HAVE_CODEX=0
{ command -v claude >/dev/null 2>&1 || [ -d "$CLAUDE" ]; } && HAVE_CLAUDE=1
{ command -v codex  >/dev/null 2>&1 || [ -d "$CODEX"  ]; } && HAVE_CODEX=1

echo "leopold doctor"
echo

command -v jq >/dev/null 2>&1 && pass "jq present" || miss "jq missing (the hooks need it)"

if [ "$HAVE_CLAUDE" = "0" ] && [ "$HAVE_CODEX" = "0" ]; then
  miss "no agent harness found — install Claude Code or Codex CLI first"
fi

if [ -x "$LEO_HOME/hooks/stop-continuity.sh" ] && [ -x "$LEO_HOME/hooks/guard-irreversible.sh" ]; then
  pass "hooks installed + executable ($LEO_HOME/hooks)"
else
  miss "hooks not installed — run ./install.sh"
fi

# --- Claude Code -------------------------------------------------------------
if [ "$HAVE_CLAUDE" = "1" ]; then
  n=$(ls -d "$CLAUDE"/skills/leopold-* 2>/dev/null | wc -l | tr -d ' ')
  [ "${n:-0}" -ge 4 ] && pass "Claude Code: skills installed ($n)" || miss "Claude Code: skills not installed ($n found) — run ./install.sh"

  if [ -f "$CLAUDE/settings.json" ] && grep -q 'leopold/hooks' "$CLAUDE/settings.json" 2>/dev/null; then
    pass "Claude Code: hooks wired in settings.json"
  elif ls -d "$CLAUDE"/plugins/cache/*/leopold* >/dev/null 2>&1; then
    pass "Claude Code: hooks wired via plugin"
  else
    note "Claude Code: hooks not wired — run ./install.sh or install the plugin"
  fi
fi

# --- Codex CLI ---------------------------------------------------------------
# Codex reimplemented Claude Code's hook contract, so the same two hooks run there.
# The extra check is trust: a config-declared hook stays inert until approved once.
if [ "$HAVE_CODEX" = "1" ]; then
  cn=$(ls -d "$CODEX"/skills/leopold-* 2>/dev/null | wc -l | tr -d ' ')
  [ "${cn:-0}" -ge 4 ] && pass "Codex: skills installed ($cn)" || note "Codex: skills not installed ($cn found) — run ./install.sh --harness codex"

  if grep -q 'leopold (managed)' "$CODEX/config.toml" 2>/dev/null; then
    pass "Codex: hooks wired in config.toml"
    if grep -q 'trusted_hash' "$CODEX/config.toml" 2>/dev/null; then
      pass "Codex: hook trust entries present (open Codex once if the hooks still look inert)"
    else
      note "Codex: hooks never trusted — open Codex once and approve them, or they stay inert in interactive sessions"
    fi
  elif ls -d "$CODEX"/plugins/cache/*/leopold* >/dev/null 2>&1; then
    pass "Codex: hooks wired via plugin"
  else
    note "Codex: hooks not wired — run ./install.sh --harness codex"
  fi
fi

# The enhancer keeps ONE data dir for the machine (so the switch and the learned
# profile are shared) but ONE hook per harness. Resolve both the way the installer
# does, and report every harness that is missing its wiring.
if   [ -n "${LEOPOLD_ENHANCE_DIR:-}" ]; then ENH_DIR="$LEOPOLD_ENHANCE_DIR"
elif [ -n "${LEOPOLD_HOME:-}" ];        then ENH_DIR="$LEOPOLD_HOME/enhance"
elif [ -d "$CLAUDE/enhance" ];          then ENH_DIR="$CLAUDE/enhance"
elif [ -d "$CODEX/enhance" ];           then ENH_DIR="$CODEX/enhance"
elif [ -d "$CLAUDE" ];                  then ENH_DIR="$CLAUDE/enhance"
else                                         ENH_DIR="$CODEX/enhance"
fi
if [ -f "$ENH_DIR/enhance.py" ]; then
  enh_missing=""
  [ "$HAVE_CLAUDE" = "1" ] && ! grep -q 'enhance.py --event' "$CLAUDE/settings.json" 2>/dev/null \
    && enh_missing="Claude Code"
  [ "$HAVE_CODEX" = "1" ] && ! grep -q 'enhance.py --event' "$CODEX/config.toml" 2>/dev/null \
    && enh_missing="${enh_missing:+$enh_missing + }Codex CLI"
  st="$(LEOPOLD_ENHANCE_DIR="$ENH_DIR" python3 "$ENH_DIR/enhance.py" --event status 2>/dev/null || echo '?')"
  if [ -z "$enh_missing" ]; then
    pass "prompt enhancer installed + wired ($st)"
  else
    note "prompt enhancer not wired on $enh_missing — leopold menu (enhance -> Install)"
  fi
else
  note "prompt enhancer not installed (optional) — leopold menu (enhance -> Install)"
fi

# ovmem: same shape as the enhancer — ONE data dir for the machine, FOUR hooks per
# harness. Resolve the dir the way the installer does and name every harness that is
# missing its wiring; a memory that only fires in one of two agents is the silent
# half-install this exists to catch.
if   [ -n "${LEOPOLD_OVMEM_DIR:-}" ]; then OVM_DIR="$LEOPOLD_OVMEM_DIR"
elif [ -n "${LEOPOLD_HOME:-}" ];      then OVM_DIR="$LEOPOLD_HOME/ovmem"
elif [ -d "$CLAUDE/ovmem" ];          then OVM_DIR="$CLAUDE/ovmem"
elif [ -d "$CODEX/ovmem" ];           then OVM_DIR="$CODEX/ovmem"
elif [ -d "$CLAUDE" ];                then OVM_DIR="$CLAUDE/ovmem"
else                                       OVM_DIR="$CODEX/ovmem"
fi
# How many ovmem hooks a harness config declares. `grep -c` prints "0" AND exits 1
# when the file exists with no match, so `|| echo 0` would append a second 0 and hand
# `[` the two-line string "0\n0" — which aborts the test with "integer expression
# expected", short-circuits the && chain, and reports a half-install as wired. Use
# `|| true` (what extensions/ovmem/manage.sh:wired_count already does) and default the
# empty output the missing-file case produces.
ovm_wired() { # <hooks file> -> count
  local n
  [ -f "$1" ] || { echo 0; return; }
  n="$(grep -c 'ovmem.py --event' "$1" 2>/dev/null || true)"
  echo "${n:-0}"
}
if [ -f "$OVM_DIR/ovmem.py" ]; then
  ovm_missing=""
  [ "$HAVE_CLAUDE" = "1" ] && [ "$(ovm_wired "$CLAUDE/settings.json")" -lt 4 ] \
    && ovm_missing="Claude Code"
  [ "$HAVE_CODEX" = "1" ] && [ "$(ovm_wired "$CODEX/config.toml")" -lt 4 ] \
    && ovm_missing="${ovm_missing:+$ovm_missing + }Codex CLI"
  if [ -z "$ovm_missing" ]; then
    if curl -s -m 2 http://127.0.0.1:1933/health 2>/dev/null | grep -q '"healthy":true'; then
      pass "ovmem installed + wired (OpenViking up)"
    else
      note "ovmem wired but the OpenViking server is down — every hook is a silent no-op until it starts"
    fi
  else
    note "ovmem not wired on $ovm_missing — leopold menu (ovmem -> Install)"
  fi
else
  note "ovmem not installed (optional) — leopold menu (ovmem -> Install)"
fi

# gstack is per harness: each one discovers skills in its own skills root, so a
# machine can easily have it on one and not the other. Say which.
# `-e` on the SKILL.md, not `-d` on the dir: gstack installs each skill as a dir
# holding a symlink into the checkout, so a moved or deleted checkout leaves the
# dirs behind, dangling. Testing the target is the difference between "installed"
# and "there is a folder with that name".
gstack_in() { # <skills-dir>
  [ -e "$1/gstack/SKILL.md" ] || [ -e "$1/spec/SKILL.md" ] || [ -e "$1/gstack-spec/SKILL.md" ]
}
gs_have=""; gs_missing=""
[ "$HAVE_CLAUDE" = "1" ] && { gstack_in "$CLAUDE/skills" && gs_have="Claude Code" || gs_missing="Claude Code"; }
[ "$HAVE_CODEX" = "1" ]  && { gstack_in "$CODEX/skills"  && gs_have="${gs_have:+$gs_have + }Codex CLI" || gs_missing="${gs_missing:+$gs_missing + }Codex CLI"; }
if [ -n "$gs_have" ] && [ -z "$gs_missing" ]; then
  pass "gstack detected on $gs_have — planning toolchain available"
elif [ -n "$gs_have" ]; then
  note "gstack on $gs_have but missing on $gs_missing — 'make gstack-install' installs it everywhere"
else
  note "gstack not installed (optional) — 'make gstack-install' to enable planning"
fi

if command -v node >/dev/null 2>&1; then pass "node present ($(node -v 2>/dev/null)) — SDK driver usable"; else note "node missing — the SDK driver (optional) needs Node 18+"; fi
if [ -f "$SRC/VERSION" ]; then
  pass "engine source at $SRC (v$(tr -d '[:space:]' < "$SRC/VERSION"))"
  up="$(bash "$SRC/scripts/leopold-update-check.sh" 2>/dev/null || true)"
  [ -n "$up" ] && note "$up — run: make update"
else
  note "no source clone at $SRC (plugin install? update via 'claude plugin update')"
fi


# --- Project continuity ------------------------------------------------------
# Doctor answers "will this run survive a full window, and why not" for the
# project it is run from. Only speaks when a brief is present in the cwd.
#
# The checkpoint format has ONE contract (packages/driver/src/checkpoint.ts).
# This script is bash on purpose, so it cannot import that module; the copy
# below is pinned to the export by packages/driver/test/checkpoint.test.ts,
# which fails the build the moment doctor's wording drifts from the contract.
CP_TITLE="# Leopold Checkpoint"
CP_SECTIONS="In-Flight Item, Files and Code, Errors and Fixes, Decisions This Run, Learned Constraints, Current Work, Next Step"
CP_MAX_BYTES=32768

cp_parse_error() { # <file> -> the parse error on stdout; empty when the checkpoint is valid
  local bytes
  bytes="$(wc -c < "$1" 2>/dev/null | tr -d ' ')"
  if [ "${bytes:-0}" -gt "$CP_MAX_BYTES" ] 2>/dev/null; then
    echo "checkpoint is $bytes bytes, over the $CP_MAX_BYTES-byte cap — consolidate it (merge, drop stale facts)"
    return
  fi
  awk -v title="$CP_TITLE" -v sections="$CP_SECTIONS" '
    BEGIN { n = split(sections, S, /, /); for (i = 1; i <= n; i++) known[S[i]] = 1 }
    {
      line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == title) { titles++; next }
      if (match(line, /^##[ \t]+/)) {
        name = substr(line, RSTART + RLENGTH); gsub(/[ \t]+$/, "", name)
        if (!(name in known)) {
          low = tolower(name)
          if (low ~ /^(mission|charter|guardrails|plan)/) {
            err = "checkpoint has a \"## " name "\" section — brief state (Mission/Charter/Guardrails/Plan) never lives in the checkpoint; the next window re-reads the brief itself"
          } else {
            err = "checkpoint has an unknown section \"## " name "\" — the contract is: " sections
          }
          exit
        }
        if (name in seen) { err = "checkpoint has \"## " name "\" twice — a nested prior checkpoint; merge, never nest"; exit }
        seen[name] = 1; order[++k] = name
      }
    }
    END {
      if (err != "") { print err; exit }
      if (titles > 1) { print "checkpoint contains " titles " \"" title "\" titles — a nested prior checkpoint; merge, never nest"; exit }
      miss = ""
      for (i = 1; i <= n; i++) if (!(S[i] in seen)) miss = miss (miss == "" ? "" : ", ") "\"" S[i] "\""
      if (miss != "") { print "checkpoint is missing section(s): " miss; exit }
      for (i = 1; i <= k; i++) if (order[i] != S[i]) {
        print "checkpoint sections are out of order: found \"" order[i] "\" where \"" S[i] "\" belongs — the order is fixed"; exit
      }
    }' "$1"
}

PROJ="${LEOPOLD_PROJECT_DIR:-$PWD}/.leopold"
if [ -f "$PROJ/MISSION.md" ] || [ -f "$PROJ/state.json" ]; then
  echo
  echo "project continuity ($PROJ)"

  # The kill switch beats everything, including continuity: auto. Say so first.
  [ -e "$PROJ/STOP" ] && note "kill switch present (.leopold/STOP) — nothing relaunches this run until it is removed"

  # Checkpoint: present / absent / malformed. A malformed checkpoint is a named
  # problem — the next window would refuse it, so doctor refuses it here first.
  if [ -f "$PROJ/CHECKPOINT.md" ]; then
    cp_err="$(cp_parse_error "$PROJ/CHECKPOINT.md")"
    if [ -z "$cp_err" ]; then
      pass "checkpoint OK ($(wc -c < "$PROJ/CHECKPOINT.md" | tr -d ' ') bytes) — the next window continues from it"
    else
      miss "checkpoint MALFORMED: $cp_err — a reseed cannot trust .leopold/CHECKPOINT.md; fix it or archive it"
    fi
  else
    pass "no checkpoint (normal — a window roll writes .leopold/CHECKPOINT.md before the window closes)"
  fi

  # continuity: who reseeds a rolled window. GUARDRAILS line, default auto.
  cont_line="$(grep -m1 -iE '^[[:space:]]*-?[[:space:]]*(\*\*)?continuity(\*\*)?[[:space:]]*:' "$PROJ/GUARDRAILS.md" 2>/dev/null || true)"
  cont="$(printf '%s' "${cont_line#*:}" | awk '{print tolower($1)}')"
  case "${cont:-auto}" in
    auto)   pass "continuity auto — leopold watch relaunches a rolled window headless" ;;
    manual) note "continuity manual — relaunch is OFF; resume a rolled window yourself with /leopold-run" ;;
    *)      note "continuity '$cont' is not a setting (auto|manual) — treated as auto; fix the line in .leopold/GUARDRAILS.md" ;;
  esac

  # Windows vs the ceiling. Same resolution as the hook: state > GUARDRAILS > 10.
  windows="$(jq -r '.windows // 1' "$PROJ/state.json" 2>/dev/null || echo 1)"
  case "$windows" in (*[!0-9]*|"") windows=1 ;; esac
  max_windows="$(jq -r '.max_windows // empty' "$PROJ/state.json" 2>/dev/null || true)"
  if [ -z "$max_windows" ]; then
    mw_line="$(grep -m1 -iE '^[[:space:]]*-?[[:space:]]*(\*\*)?max_windows(\*\*)?[[:space:]]*:' "$PROJ/GUARDRAILS.md" 2>/dev/null || true)"
    max_windows="$(printf '%s' "${mw_line#*:}" | grep -oE '[0-9]+' 2>/dev/null | head -1)"
  fi
  case "$max_windows" in (*[!0-9]*|"") max_windows=10 ;; esac
  if [ "$windows" -ge "$max_windows" ] 2>/dev/null; then
    note "windows $windows/$max_windows — the ceiling is reached; the next roll stops the run (raise max_windows in .leopold/GUARDRAILS.md if it genuinely needs more)"
  else
    pass "windows $windows/$max_windows"
  fi

  # The last window's progress: what the most recent rolled window actually closed.
  # Two consecutive zero-item windows end the run, so a fresh zero is a warning.
  last_closed="$(jq -r '(.window_progress // []) | if length > 0 then .[-1] else "" end' "$PROJ/state.json" 2>/dev/null || true)"
  if [ -n "$last_closed" ]; then
    if [ "$last_closed" = "0" ]; then
      note "last window closed ZERO plan items — one more zero-item window ends the run (no_progress_across_windows)"
    else
      pass "last window closed $last_closed plan item(s)"
    fi
  fi
fi

echo
echo "summary: $ok ok, $warn warnings, $bad problems"
[ "${bad:-0}" -eq 0 ] && echo "Leopold looks healthy." || echo "Fix the [FAIL] items above."
exit 0
