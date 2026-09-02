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
    # Wired twice means run twice per stop: two counted turns and a lost update on every
    # counter. The plugin and settings.json each wire the same script; keep one.
    sc="$(grep -o 'stop-continuity\.sh' "$CLAUDE/settings.json" 2>/dev/null | wc -l | tr -d ' ')"
    [ "${sc:-0}" -gt 1 ] && note "Claude Code: the Stop hook is wired $sc times in settings.json — every stop runs it $sc times (double-counted turns); keep one entry"
    ls -d "$CLAUDE"/plugins/cache/*/leopold* >/dev/null 2>&1 && note "Claude Code: hooks wired in settings.json AND via the plugin — every stop runs the hook twice; remove one wiring"
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
    xc="$(grep -o 'stop-continuity\.sh' "$CODEX/config.toml" 2>/dev/null | wc -l | tr -d ' ')"
    [ "${xc:-0}" -gt 1 ] && note "Codex: the Stop hook is wired $xc times in config.toml — every stop runs it $xc times (double-counted turns); keep one entry"
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

# --- persona module ----------------------------------------------------------
# The synthetic-customer harness: three skills per harness, and a hook-level
# navigation bound (hooks/persona-guard.sh) that the conductor wires ONLY while
# a persona run is active. PreToolUse observes and denies MCP tool calls on
# BOTH harnesses — verified live against claude 2.1.235 and codex-cli 0.147.0
# (docs/reference/persona-guard-hooks.md). The wire alone does NOT prove a run
# is active: the hook is inert without the project's
# `.leopold/persona/ACTIVE.json`, and a crashed conductor can leave either one
# behind without the other. Say exactly which pieces are present — wire, arming
# file, or neither — per harness; a doctor line implying a bound that is not in
# force would be the silent-degrade this tool exists to catch.
persona_skills_in() { # <skills-dir>
  [ -f "$1/leopold-persona/SKILL.md" ] && \
  [ -f "$1/persona-contract-builder/SKILL.md" ] && \
  [ -f "$1/persona-contract-runtime/SKILL.md" ]
}
persona_bound() { # <hooks file (settings.json or config.toml)>
  local wired="" armed=""
  [ -f "$1" ] && grep -q 'persona-guard\.sh' "$1" 2>/dev/null && wired=1
  [ -f ".leopold/persona/ACTIVE.json" ] && armed=1
  if [ -n "$wired" ] && [ -n "$armed" ]; then
    echo "navigation bound: persona-guard hook wired + run active here (.leopold/persona/ACTIVE.json) + conductor checks"
  elif [ -n "$wired" ]; then
    echo "navigation bound: persona-guard hook wired but NO .leopold/persona/ACTIVE.json in this project — the hook is inert here (a crashed run may have left the wire; the skill's disarm step unwires it)"
  elif [ -n "$armed" ]; then
    echo "navigation bound: .leopold/persona/ACTIVE.json present but the persona-guard hook is NOT wired — conductor-level enforcement only (remove ACTIVE.json if no run is live)"
  else
    echo "navigation bound: conductor-level enforcement (persona-guard hook wires only while a run is active)"
  fi
}
if [ "$HAVE_CLAUDE" = "1" ]; then
  if persona_skills_in "$CLAUDE/skills"; then
    pass "persona: Claude Code skills present (3/3) — $(persona_bound "$CLAUDE/settings.json")"
  else
    note "persona: skills not installed on Claude Code (optional) — run ./install.sh"
  fi
  # Browser capability, from the live captures in
  # docs/reference/persona-guard-hooks.md (claude 2.1.235) — never assumed.
  pass "persona: Claude Code browser capability: MCP browser tools + WebFetch enact headless; PreToolUse deny verified live upstream of the server (docs/reference/persona-guard-hooks.md)"
fi
if [ "$HAVE_CODEX" = "1" ]; then
  if persona_skills_in "$CODEX/skills"; then
    pass "persona: Codex skills present (3/3) — $(persona_bound "$CODEX/config.toml")"
  else
    note "persona: skills not installed on Codex (optional) — run ./install.sh --harness codex"
  fi
  # Honest asymmetry, from the same live captures (codex-cli 0.147.0): the deny
  # path works, but Codex's own approval layer auto-cancels headless MCP calls
  # on the ALLOW path unless approvals are bypassed.
  note "persona: Codex browser capability: PreToolUse deny verified live, but headless MCP browsing is auto-cancelled by Codex's approval layer unless the run bypasses approvals (docs/reference/persona-guard-hooks.md)"
fi

# Per-project inventory, spoken only where a .leopold/ exists: contracts counted
# by the SAME lexical gate the driver applies (contract-check.ts — line-anchored
# `contract_status:`, quotes stripped; ready/draft/blocked is the builder's
# vocabulary, anything else is invalid), and flows counted as flows/*.md. An
# unused module is a normal answer, never an error.
persona_contract_status() { # <contract.yaml> -> first line-anchored status, quotes stripped
  sed -n 's/^[[:space:]]*contract_status[[:space:]]*:[[:space:]]*//p' "$1" 2>/dev/null \
    | head -n 1 | tr -d '"'"'"'[:space:]'
}
PPROJ="${LEOPOLD_PROJECT_DIR:-$PWD}/.leopold"
if [ -d "$PPROJ" ]; then
  PDIR="$PPROJ/persona"
  p_ready=0; p_draft=0; p_blocked=0; p_invalid=0; p_total=0
  for c in "$PDIR"/personas/*/contract.yaml; do
    [ -f "$c" ] || continue
    p_total=$((p_total+1))
    case "$(persona_contract_status "$c")" in
      ready)   p_ready=$((p_ready+1)) ;;
      draft)   p_draft=$((p_draft+1)) ;;
      blocked) p_blocked=$((p_blocked+1)) ;;
      *)       p_invalid=$((p_invalid+1)) ;;
    esac
  done
  p_flows=0
  for f in "$PDIR"/flows/*.md; do [ -f "$f" ] && p_flows=$((p_flows+1)); done
  if [ "$p_total" -eq 0 ] && [ "$p_flows" -eq 0 ]; then
    pass "persona: no contracts yet in this project — run /leopold-persona in a session to build the first"
  else
    p_line="persona: contracts $p_total ($p_ready ready · $p_draft draft · $p_blocked blocked"
    [ "$p_invalid" -gt 0 ] && p_line="$p_line · $p_invalid INVALID"
    p_line="$p_line) · flows $p_flows"
    if [ "$p_invalid" -gt 0 ]; then note "$p_line — an invalid contract never enacts; leopold persona list names the reason"; else pass "$p_line"; fi
  fi
fi

if command -v node >/dev/null 2>&1; then pass "node present ($(node -v 2>/dev/null)) — SDK driver usable"; else note "node missing — the SDK driver (optional) needs Node 18+"; fi
if [ -f "$SRC/VERSION" ]; then
  pass "engine source at $SRC (v$(tr -d '[:space:]' < "$SRC/VERSION"))"
else
  note "no source clone at $SRC (plugin install? update via 'claude plugin update')"
fi

# --- The toolchain, both surfaces on one line --------------------------------
# The assets and the npm driver are updated by different mechanisms, so they drift, and
# a drift is invisible from either one alone: `leopold-driver --version` says nothing
# about the assets, and VERSION says nothing about the binary. Doctor exists for exactly
# this, so it prints the PAIR and names a mismatch out loud.
LIBT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/toolchain.sh"
if [ -f "$LIBT" ]; then
  # shellcheck source=lib/toolchain.sh
  . "$LIBT"
  t_assets="$(leo_asset_version "$SRC")"
  [ -n "$t_assets" ] || t_assets="$(leo_asset_version "$LEO_HOME")"
  if command -v leopold-driver >/dev/null 2>&1; then
    t_drv="$(leo_driver_version)"
    if [ -z "$t_assets" ]; then
      note "toolchain: driver ${t_drv:-unknown} · assets unknown (no VERSION found to compare against)"
    elif [ "$t_drv" = "$t_assets" ]; then
      pass "toolchain: driver $t_drv · assets $t_assets — both surfaces agree"
    else
      miss "toolchain SPLIT: driver ${t_drv:-unknown} · assets $t_assets — one update moved only half of it. Run: npm i -g leopold-driver@$t_assets"
    fi
    # The failure that hides itself: npm installs into its own prefix while an older
    # install earlier in PATH keeps winning, so the update reports success and the stale
    # binary keeps running. `leopold-driver update` cannot escape it either — the stale
    # binary is what executes it. Only a PATH-wide look sees this.
    t_conf="$(leo_driver_conflicts || true)"
    if [ -n "$t_conf" ]; then
      t_win="$(printf '%s' "$t_conf" | head -1)"
      miss "multiple leopold-driver installs on PATH with different versions — PATH runs ${t_win% *} (${t_win##* })"
      printf '%s\n' "$t_conf" | while IFS=' ' read -r t_p t_v; do
        [ -n "$t_p" ] && echo "         $t_p  ($t_v)"
      done
      echo "         Remove the stale one (and the tree it points into), then: leopold-driver --version"
    fi
  else
    note "driver not installed (optional — the in-session engine needs no Node). Install: npm i -g leopold-driver@${t_assets:-latest}"
  fi
fi

if [ -f "$SRC/VERSION" ]; then
  up="$(bash "$SRC/scripts/leopold-update-check.sh" 2>/dev/null || true)"
  # The driver lines are already reported above, in more detail; only the release check
  # is news here.
  up="$(printf '%s\n' "$up" | grep '^UPDATE_AVAILABLE' || true)"
  [ -n "$up" ] && note "$up — run: make update"
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

  # Who conducts the run, and is that session alive. ONE reader (scripts/leopold-owner.sh,
  # the same one /leopold-run, /leopold-stop and /leopold-status use), so doctor cannot
  # disagree with the skills about who owns a run. Only spoken while a run is active.
  OWNER_SH="$(dirname "$0")/leopold-owner.sh"
  if [ -f "$PROJ/state.json" ] && [ "$(jq -r '.active // false' "$PROJ/state.json" 2>/dev/null)" = "true" ]; then
    if [ -f "$OWNER_SH" ]; then
      ost="$(bash "$OWNER_SH" status "${LEOPOLD_PROJECT_DIR:-$PWD}" 2>/dev/null)"
      o_sid="$(printf '%s' "$ost" | jq -r '.owner_short // ""' 2>/dev/null)"
      o_eng="$(printf '%s' "$ost" | jq -r '.engine // ""' 2>/dev/null)"
      o_har="$(printf '%s' "$ost" | jq -r '.harness // ""' 2>/dev/null)"
      o_alive="$(printf '%s' "$ost" | jq -r '.alive // false' 2>/dev/null)"
      o_age="$(printf '%s' "$ost" | jq -r '.age_s // "?"' 2>/dev/null)"
      o_pid="$(printf '%s' "$ost" | jq -r '.pid // ""' 2>/dev/null)"
      o_for="$(printf '%s' "$ost" | jq -r '.foreign_stops // 0' 2>/dev/null)"
      if [ "$o_eng" = "driver" ]; then
        if [ "$o_alive" = "true" ]; then pass "run owner: leopold run (driver, pid ${o_pid:-?}) — alive, last seen ${o_age}s ago"
        else note "run owner: leopold run (driver, pid ${o_pid:-?}) — no sign of life for ${o_age}s; the next leopold run reaps it, or /leopold-run takes over"; fi
      elif [ -z "$o_sid" ]; then
        note "run active with NO session owner — every session that stops in this checkout is continued and counted; re-activate with /leopold-run to bind the run to one session"
      elif [ "$o_alive" = "true" ]; then
        pass "run owner: session $o_sid (${o_eng:-skill}${o_har:+, $o_har}) — alive, last seen ${o_age}s ago"
      else
        note "run owner: session $o_sid (${o_eng:-skill}${o_har:+, $o_har}) — no sign of life for ${o_age}s; /leopold-run in a new session takes it over"
      fi
      [ "${o_for:-0}" -gt 0 ] 2>/dev/null && note "$o_for stop(s) from other sessions were turned away (foreign_stop) — a second window is open in this checkout; it is not counted, but it shares the working tree"
    else
      note "run active but scripts/leopold-owner.sh is missing beside this doctor — ownership cannot be reported; re-run ./install.sh"
    fi
  fi

  # A tracked state.json makes every clone and worktree inherit an active run.
  if git -C "${LEOPOLD_PROJECT_DIR:-$PWD}" ls-files --error-unmatch .leopold/state.json >/dev/null 2>&1; then
    miss "state.json is TRACKED by git — every worktree and clone inherits this run's state (and its git lock); add .leopold/ to .gitignore and untrack it"
  fi

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
