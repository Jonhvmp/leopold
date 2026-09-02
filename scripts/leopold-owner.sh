#!/usr/bin/env bash
# Leopold — who conducts the run in this project, and is that session alive?
#
# ONE reader for run ownership, shared by /leopold-run (Step 0), /leopold-stop,
# /leopold-status and leopold doctor, so the four surfaces cannot disagree about who
# owns a run or when an owner counts as gone. The WRITERS live elsewhere and there are
# exactly two: /leopold-run Step 1 (in-session engine) and initState in
# packages/driver/src/config.ts (driver). This script never writes state.json.
#
# usage:
#   leopold-owner.sh status [project]             one JSON object on stdout
#   leopold-owner.sh check  [project] [--takeover] one line on stdout, exit 0 always:
#       FREE      no active run here
#       MINE      the active run is owned by THIS session (a resume of its own run)
#       STALE     owned by another session that shows no sign of life; /leopold-run may
#                 take over (Step 1 records the takeover)
#       BLOCKED   owned by another live session, or by a live driver run
#       TAKEOVER  --takeover was given: what would be BLOCKED is taken over, and said so
#   leopold-owner.sh me                           this session's id from the harness env
#
# Identity: the harness exports the session id into every shell it runs --
# CLAUDE_CODE_SESSION_ID on Claude Code, CODEX_THREAD_ID on Codex -- and the Stop hook
# receives the same value as `session_id` in its payload (verified live on Claude Code
# 2.1.258 and Codex 0.150.1, docs/reference/hooks.md). Both are the same string, so the
# session that activated a run and the session the hook continues are one comparison.
#
# Liveness: ANY one signal within LEOPOLD_OWNER_STALE_S (default 600 s) keeps an owner
# alive -- the owner's harness pid still runs (Claude Code exports CLAUDE_PID; Codex
# exports no pid), `last_turn` in state.json is fresh (the hook stamps it on every
# counted stop), or the owner's transcript file was modified recently (Claude Code
# appends to it on every tool call, so an executor that works one long turn without
# stopping stays visibly alive; the incident's executor closed eleven items in one
# 35-minute turn and would have read as stale on `last_turn` alone).
set -u

cmd="${1:-status}"; shift || true
PROJ="$PWD"; TAKEOVER=0
for a in "$@"; do
  case "$a" in
    --takeover) TAKEOVER=1 ;;
    *) PROJ="$a" ;;
  esac
done
STATE="$PROJ/.leopold/state.json"
EVENTS="$PROJ/.leopold/events.jsonl"
STALE_S="${LEOPOLD_OWNER_STALE_S:-600}"
case "$STALE_S" in (*[!0-9]*|"") STALE_S=600 ;; esac

me="${CLAUDE_CODE_SESSION_ID:-${CODEX_THREAD_ID:-}}"
if [ "$cmd" = "me" ]; then printf '%s\n' "$me"; exit 0; fi

command -v jq >/dev/null 2>&1 || { echo "leopold-owner.sh: jq is required" >&2; [ "$cmd" = check ] && echo "FREE: jq missing, ownership unknown"; exit 0; }

now_s="$(date -u +%s)"

# ISO-8601 UTC (the stamp every Leopold writer uses) -> epoch seconds. GNU date first,
# then BSD/macOS. Empty on anything unparseable, so a bad stamp is "no signal", never
# "seen just now" and never "seen in 1970".
iso_epoch() {
  local t="$1" e=""
  [ -n "$t" ] || { printf ''; return; }
  e="$(date -u -d "$t" +%s 2>/dev/null)" || e=""
  [ -n "$e" ] || e="$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$t" +%s 2>/dev/null)" || e=""
  [ -n "$e" ] || e="$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${t%%.*}" +%s 2>/dev/null)" || e=""
  printf '%s' "$e"
}
file_mtime() { # -> epoch seconds or empty
  [ -f "$1" ] || { printf ''; return; }
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || printf ''
}
pid_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

active=false; owner_sid=""; engine=""; harness=""; pid=""; claimed=""; released=""; tpath=""; last_turn=""
if [ -f "$STATE" ] && jq -e . "$STATE" >/dev/null 2>&1; then
  active="$(jq -r '.active // false' "$STATE")"
  owner_sid="$(jq -r '.owner.session_id // .session_id // ""' "$STATE")"
  engine="$(jq -r '.owner.engine // ""' "$STATE")"
  harness="$(jq -r '.owner.harness // ""' "$STATE")"
  pid="$(jq -r '.owner.pid // .orchestrator_pid // ""' "$STATE")"
  claimed="$(jq -r '.owner.claimed_at // .started_at // ""' "$STATE")"
  released="$(jq -r '.owner.released_at // ""' "$STATE")"
  tpath="$(jq -r '.owner.transcript_path // .transcript_path // ""' "$STATE")"
  last_turn="$(jq -r '.last_turn // .started_at // ""' "$STATE")"
fi
# A state an older driver wrote has no owner record but always has the orchestrator
# pid, with no session id beside it: that is a driver run. Anything else with a session
# id is the in-session engine; with neither, the owner is unknown.
if [ -z "$engine" ]; then
  if [ -z "$owner_sid" ] && [ -n "$pid" ]; then engine="driver"
  elif [ -n "$owner_sid" ]; then engine="skill"
  fi
fi

# ---- liveness: newest signal wins -------------------------------------------------
signals=""; newest=""
add_signal() { # <name> <epoch>
  [ -n "$2" ] || return 0
  signals="${signals:+$signals,}\"$1\""
  if [ -z "$newest" ] || [ "$2" -gt "$newest" ] 2>/dev/null; then newest="$2"; fi
}
if pid_alive "$pid"; then add_signal "pid $pid alive" "$now_s"; fi
add_signal "last_turn" "$(iso_epoch "$last_turn")"
add_signal "transcript modified" "$(file_mtime "$tpath")"
[ -n "$newest" ] || newest="$(iso_epoch "$claimed")"
age_s=""; alive=false
if [ -n "$newest" ]; then
  age_s=$(( now_s - newest )); [ "$age_s" -lt 0 ] && age_s=0
  [ "$age_s" -lt "$STALE_S" ] && alive=true
fi
foreign=0
if [ -f "$EVENTS" ]; then foreign="$(grep -c '"event":"foreign_stop"' "$EVENTS" 2>/dev/null || true)"; foreign="${foreign:-0}"; fi
mine=false; [ -n "$me" ] && [ "$me" = "$owner_sid" ] && mine=true

if [ "$cmd" = "status" ]; then
  jq -cn --argjson active "$active" --arg o "$owner_sid" --arg e "$engine" --arg h "$harness" --arg p "$pid" \
     --arg c "$claimed" --arg r "$released" --arg t "$tpath" --arg me "$me" --argjson mine "$mine" \
     --argjson alive "$alive" --arg age "$age_s" --argjson f "${foreign:-0}" --argjson stale "$STALE_S" \
     --argjson sig "[${signals}]" \
     '{active:$active, owner_session:$o, owner_short:($o[0:8]), engine:$e, harness:$h, pid:$p,
       claimed_at:$c, released_at:$r, transcript_path:$t, me:$me, mine:$mine, alive:$alive,
       age_s:(if $age == "" then null else ($age|tonumber) end), signals:$sig,
       foreign_stops:$f, stale_after_s:$stale}'
  exit 0
fi

# ---- check: the one word /leopold-run and /leopold-stop act on ---------------------
[ "$cmd" = "check" ] || { echo "leopold-owner.sh: unknown command '$cmd' (status|check|me)" >&2; exit 0; }
o8="${owner_sid:0:8}"
seen="last seen ${age_s:-?}s ago"
if [ "$active" != "true" ]; then
  echo "FREE: no active run in $PROJ"
elif [ "$engine" = "driver" ]; then
  if [ "$alive" = "true" ]; then
    if [ "$TAKEOVER" = "1" ]; then echo "TAKEOVER: forced over a live driver run (pid ${pid:-?}, $seen) -- stop it with /leopold-stop --force first if it is still working"
    else echo "BLOCKED: a driver-conducted run is active here (leopold run, pid ${pid:-?}, $seen); watch it with leopold watch or stop it with /leopold-stop --force"; fi
  else
    echo "STALE: a driver run left active:true with no sign of life (pid ${pid:-?}, $seen) -- taking over"
  fi
elif [ "$mine" = "true" ]; then
  echo "MINE: this session owns the active run ($o8, $seen) -- resuming it"
elif [ -z "$owner_sid" ]; then
  if [ "$alive" = "true" ]; then
    if [ "$TAKEOVER" = "1" ]; then echo "TAKEOVER: forced over an unowned but recently active run ($seen)"
    else echo "BLOCKED: a run with no session owner is active here ($seen) -- another window may be conducting it; wait, /leopold-stop it there, or re-run with --takeover"; fi
  else
    echo "STALE: an unowned run left active:true with no sign of life ($seen) -- taking over"
  fi
else
  if [ "$alive" = "true" ]; then
    if [ "$TAKEOVER" = "1" ]; then echo "TAKEOVER: forced over session $o8 (${engine:-skill}${harness:+, $harness}), which is alive ($seen) -- two executors on one plan is on you"
    else echo "BLOCKED: the run here is conducted by session $o8 (${engine:-skill}${harness:+, $harness}), alive ($seen); do not activate a second executor -- wait, or re-run with --takeover if that session is truly gone"; fi
  else
    echo "STALE: owner session $o8 (${engine:-skill}${harness:+, $harness}) shows no sign of life ($seen) -- taking over"
  fi
fi
exit 0
