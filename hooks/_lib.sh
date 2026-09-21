#!/usr/bin/env bash
# Leopold hook library — the three things every state-coupled hook has to get right,
# written once. Sourced, never executed; bash + jq, no other dependency.
#
# WHY THIS FILE EXISTS, AND WHY ONLY NOW. The owner gate, the state lock and the event
# stamp were transcribed into hooks/stop-continuity.sh, then hooks/permission-policy.sh,
# then hooks/compact-checkpoint.sh — three copies of "whose run is this", which is exactly
# the drift that produced the 2026-09-02 incident (a second window conscripted for an hour
# because two surfaces answered that question differently). The project's rule is that a
# shared hooks/_lib.sh arrives when THREE hooks need the same function, not on the first
# guess about what they might need; hooks/stop-failure.sh is the third caller of the gate,
# so the library is created here with real callers instead of hypothetical ones.
#
# WHAT IS NOT HERE, ON PURPOSE:
#   * hooks/stop-continuity.sh keeps its own gate and lock. It is the run's spine: it
#     needs the OWNER-UNKNOWN and FOREIGN-STOP branches to speak (this gate is silent for
#     both), it releases the lock through an EXIT trap because it exits down a dozen
#     paths, and its behavior is pinned by ~40 assertions. Moving it is a separate,
#     provable change, not a side effect of adding a hook.
#   * cp_cap() (the checkpoint cap formula) stays transcribed in the two hooks that use
#     it. TWO callers is not the bar this file was created at, and both copies are pinned
#     to packages/driver/src/checkpoint.ts by packages/driver/test/checkpoint.test.ts.
#
# HOW A HOOK SOURCES IT — relative to its own path, never to $PWD or to a checkout:
#
#   _LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
#   if [ -r "$_LEO_LIB" ]; then . "$_LEO_LIB"; else <fail in THIS hook's direction>; fi
#
# The installed layout is `<asset home>/hooks/`, a copy of this directory — install.sh
# copies hooks/ wholesale — and a harness runs a hook by absolute path from an arbitrary
# cwd. ${BASH_SOURCE[0]} is the only anchor that survives both. A hook that cannot find
# the library does NOT continue on half a contract: continuity hooks say so on stderr and
# exit 0 (never block a stop or a compaction), guards deny and name the missing file.
#
# The fail direction is the CALLER's, always. This library never decides whether a
# missing field is fatal — it reports, and the hook that knows whether it is a guard or a
# continuity hook decides. That is why leo_hook_gate takes a `report` mode instead of
# owning the answer.

# ---- scope + ownership: is this hook's payload the run this session conducts? --------
#
# leo_hook_gate <payload> [report]
#
# The gate every state-coupled hook opens with. On success it returns 0 and leaves the
# payload's scope in these variables:
#
#   LEO_CWD        the project root (payload `.cwd`, else $PWD — the same fallback the
#                  Stop hook has always used)
#   LEO_DIR        $LEO_CWD/.leopold
#   LEO_STATE      $LEO_DIR/state.json  (exists, parses, and `.active` is true)
#   LEO_EVENT      `.hook_event_name` — present in every payload the probe captured on
#                  both harnesses (docs/reference/hook-events.md, Findings), so a hook
#                  wired on two events may branch on it
#   LEO_SESSION    `.session_id`; LEO_SESSION8 its first 8 chars, or "-" — what every
#                  event line carries
#   LEO_AGENT      `.agent_id` when the payload has one (subagent payloads do), else ""
#   LEO_OWNER_ENGINE  who CONDUCTS the run, normalized: "driver" | "skill" | "" (no owner
#                  recorded at all). Passing the gate means "this payload may act for the
#                  run"; it does NOT mean "this payload conducts it". On a driver run the
#                  session that passes is the driver's spawned WORKER — an executor whose
#                  turn is one of many the conductor dispatches — so a hook that would end
#                  the run, release a seat, or clear a run-scoped token has to know the
#                  difference. hooks/stop-failure.sh is the first caller that does, and
#                  it reads this instead of re-deriving the owner record a fourth time.
#
# The owner's session id and pid are still NOT exported: nothing reads them, and an output
# nobody reads is a contract nobody tests. The hook that needs one adds it, with the test.
#
# Without `report` it EXITS the hook (status 0, no output) for every case below — the
# continuity direction, and what two of the three callers want. With `report` it returns
# non-zero and sets LEO_GATE_REASON to one of:
#
#   no_jq                 jq is not on PATH — nothing here can parse anything
#   no_state              no .leopold/state.json: not a Leopold project
#   payload_unreadable    the payload is not JSON (a guard denies on this; see below)
#   state_unreadable      state.json does not parse
#   inactive              no run is active
#   driver_run            a driver conducts this run and this is not its spawned worker
#   no_session_in_payload an owner is recorded and the payload names no session — no
#                         proof of ownership, so never treated as the owner
#   foreign_session       the payload names a session that is not the owner
#
# OWNERSHIP IS READ EXACTLY AS hooks/stop-continuity.sh READS IT: `owner.session_id`,
# else the legacy top-level `session_id` an older /leopold-run wrote; an orchestrator pid
# with no session id beside it is a driver run, whose executor is the session the driver
# spawned (LEOPOLD_SDK_WORKER=1, set at the one query seam in packages/driver/src/sdk.ts).
# A run with NO owner recorded at all is open: the Stop hook continues whoever stops in
# that checkout, so every hook here acts for them too. Two answers to "whose run is this"
# is the bug this file exists to make impossible.
leo_hook_gate() { # <payload> [report]
  local _payload="${1:-}" _mode="${2:-}" _sid="" _engine="" _pid=""
  LEO_GATE_REASON=""
  LEO_OWNER_ENGINE=""

  # jq is how every field below is read; without it a hook cannot act safely at all.
  if ! command -v jq >/dev/null 2>&1; then _leo_gate_no no_jq "$_mode" || return 1; fi

  LEO_CWD="$(printf '%s' "$_payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${LEO_CWD:-}" ] || LEO_CWD="$PWD"
  LEO_DIR="$LEO_CWD/.leopold"
  LEO_STATE="$LEO_DIR/state.json"
  # shellcheck disable=SC2034  # LEO_EVENT is this library's OUTPUT: a hook wired on two
  # events (the compaction hook) branches on it. A library's product looks unused from
  # inside the library; the same is true of LEO_GATE_REASON below.
  LEO_EVENT="$(printf '%s' "$_payload" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
  LEO_SESSION="$(printf '%s' "$_payload" | jq -r '.session_id // empty' 2>/dev/null || true)"
  LEO_AGENT="$(printf '%s' "$_payload" | jq -r '.agent_id // empty' 2>/dev/null || true)"
  LEO_SESSION8="${LEO_SESSION:0:8}"; [ -n "$LEO_SESSION8" ] || LEO_SESSION8="-"

  # Not a Leopold project — checked BEFORE the payload is validated, so a hook in a
  # project that never ran Leopold stays silent even on a payload it cannot read.
  [ -f "$LEO_STATE" ] || { _leo_gate_no no_state "$_mode" || return 1; }

  # A payload that does not parse: every extraction above degraded to empty rather than
  # failing, so nothing below could be trusted. A guard denies here (fail closed); a
  # continuity hook exits.
  printf '%s' "$_payload" | jq -e . >/dev/null 2>&1 || { _leo_gate_no payload_unreadable "$_mode" || return 1; }

  jq -e . "$LEO_STATE" >/dev/null 2>&1 || { _leo_gate_no state_unreadable "$_mode" || return 1; }
  [ "$(jq -r '.active // false' "$LEO_STATE" 2>/dev/null || echo false)" = "true" ] \
    || { _leo_gate_no inactive "$_mode" || return 1; }

  _sid="$(jq -r '.owner.session_id // .session_id // ""' "$LEO_STATE" 2>/dev/null || true)"
  _engine="$(jq -r '.owner.engine // ""' "$LEO_STATE" 2>/dev/null || true)"
  _pid="$(jq -r '.owner.pid // .orchestrator_pid // ""' "$LEO_STATE" 2>/dev/null || true)"
  if [ "$_engine" = "driver" ] || { [ -z "$_sid" ] && [ -n "$_pid" ] && [ -z "$_engine" ]; }; then
    _engine="driver"
  fi
  # shellcheck disable=SC2034  # LEO_OWNER_ENGINE is this library's OUTPUT (see the header):
  # hooks/stop-failure.sh branches on it to tell the run's conductor from its executor.
  LEO_OWNER_ENGINE="$_engine"
  if [ "$_engine" = "driver" ]; then
    [ "${LEOPOLD_SDK_WORKER:-}" = "1" ] || { _leo_gate_no driver_run "$_mode" || return 1; }
  elif [ -n "$_sid" ]; then
    [ -n "$LEO_SESSION" ] || { _leo_gate_no no_session_in_payload "$_mode" || return 1; }
    [ "$_sid" = "$LEO_SESSION" ] || { _leo_gate_no foreign_session "$_mode" || return 1; }
  fi
  return 0
}

# The one place the gate's two modes differ: exit the hook silently, or report and let
# the caller answer in its own shape. Called only from leo_hook_gate.
_leo_gate_no() { # <reason> <mode>
  # shellcheck disable=SC2034  # the reason IS the report; a `report` caller reads it
  LEO_GATE_REASON="$1"
  [ "${2:-}" = "report" ] && return 1
  exit 0
}

# ---- one writer at a time ------------------------------------------------------------
#
# leo_hook_lock / leo_hook_unlock — the mkdir lock hooks/stop-continuity.sh introduced,
# on $LEO_DIR/.state.lock, with its reap rule: mkdir is atomic on every filesystem bash
# runs on, and a lock older than a minute belonged to a hook that died holding it.
#
# Returns 0 with the lock held (LEO_LOCK_HELD=1), 1 after the budget below. A timeout is
# NOT a reason to skip the write: continuity beats counter accuracy, so the caller
# proceeds unlocked and logs `lock_timeout` — the same choice the Stop hook makes.
#
# THE BUDGET IS HALF A CONTRACT; THE HARNESS TIMEOUT IS THE OTHER HALF. A hook that
# waits here for five seconds inside a five-second harness timeout is killed mid-wait:
# the fallback write never runs, no `lock_timeout` is logged, no `systemMessage` reaches
# the operator, and — for hooks/stop-failure.sh — the run stays `active: true` forever,
# which is the exact failure that hook exists to end. That is not hypothetical: a
# compaction, a stop and an API error can land in the same second, and the first two
# take this lock. So the budget is NAMED here rather than buried in the loop, and every
# caller's declared timeout in leo_core_hook_specs (extensions/lib/harness.sh) must
# exceed it by at least LEO_LOCK_HEADROOM seconds. Five is sized from measurement, not
# taste: tries × sleep is 5s of SLEEPING, but each attempt also stats the lock for the
# reap check, so a full wait against a live lock clocked 6.3s here — the headroom has to
# absorb that overhead AND the hook's own jq work (~0.2s), and it does, twice over.
# scripts/test-harness-lib.sh derives that arithmetic from these three numbers and the
# spec list, and fails if any hook that calls leo_hook_lock is wired tighter.
LEO_LOCK_TRIES=50      # attempts before giving up
LEO_LOCK_SLEEP=0.1     # seconds between attempts  -> 5s asleep, ~6.3s measured wall clock
# shellcheck disable=SC2034  # LEO_LOCK_HEADROOM is this library's published CONTRACT, not
# its own variable: nothing in here waits on it, and scripts/test-harness-lib.sh reads it
# to compute the minimum timeout every lock-taking spec must declare. Deleting it because
# it "looks unused" is how the arithmetic comes apart again.
LEO_LOCK_HEADROOM=5    # seconds a caller's declared timeout must have beyond the budget
#
# No EXIT trap is installed here on purpose: callers already own that trap (the
# compaction hook removes its temp dir with one), and a library that silently replaced it
# would leak the caller's temp files. Unlock explicitly; a hook that dies holding the lock
# is reaped by the rule above.
leo_hook_lock() {
  local _i=0
  LEO_LOCK_HELD=0
  [ -n "${LEO_DIR:-}" ] || return 1
  while ! mkdir "$LEO_DIR/.state.lock" 2>/dev/null; do
    # A stale lock is reaped rather than waited out. The attempt counter advances here
    # too: a lock directory that cannot be removed (permissions) would otherwise spin
    # this loop forever, and a hook that never returns is worse than an unlocked write.
    if [ -n "$(find "$LEO_DIR" -maxdepth 1 -name .state.lock -mmin +1 2>/dev/null)" ]; then
      rmdir "$LEO_DIR/.state.lock" 2>/dev/null || true
      _i=$((_i + 1)); [ "$_i" -ge "$LEO_LOCK_TRIES" ] && return 1
      continue
    fi
    _i=$((_i + 1)); [ "$_i" -ge "$LEO_LOCK_TRIES" ] && return 1
    sleep "$LEO_LOCK_SLEEP"
  done
  LEO_LOCK_HELD=1
  return 0
}

leo_hook_unlock() {
  [ "${LEO_LOCK_HELD:-0}" = "1" ] || return 0
  rmdir "$LEO_DIR/.state.lock" 2>/dev/null || true
  LEO_LOCK_HELD=0
  return 0
}

# ---- the run's log -------------------------------------------------------------------
#
# leo_hook_event <event> [extra JSON object]
#
# Appends ONE line to $LEO_DIR/events.jsonl: {ts, event, ...extra, session[, agent_id]}.
# `ts` (UTC, seconds) and `session` are stamped here so no hook can forget them — the
# 2026-09-02 incident was invisible in the log precisely because lines did not say which
# session wrote them — and `agent_id` rides along whenever the payload carried one.
#
# The extra object is merged between them, so a reader sees the event's own fields in the
# order the hook wrote them. It is never allowed to cost the line: if it is not a JSON
# object, the event is still logged with ts/event/session alone. An event that is dropped
# because a field was malformed is a witness that was never there.
#
# scripts/test-watch-events.py derives the set of event names from `leo_hook_event <name>`
# calls (and the older literal forms) across hooks/, and fails until scripts/
# leopold-watch.py registers each one with a severity and a one-line meaning.
leo_hook_event() { # <event> [extra JSON object]
  local _ev="${1:-}" _x="${2:-}" _ts _line
  [ -n "$_ev" ] || return 0
  [ -n "${LEO_DIR:-}" ] || return 0
  _ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
  [ -n "$_x" ] || _x='{}'
  _line="$(jq -cn --arg ts "$_ts" --arg e "$_ev" --arg s "${LEO_SESSION8:--}" \
                  --arg a "${LEO_AGENT:-}" --argjson x "$_x" \
    '{ts:$ts,event:$e}
     + (if ($x|type) == "object" then $x else {} end)
     + {session:$s}
     + (if $a == "" then {} else {agent_id:$a} end)' 2>/dev/null)"
  if [ -z "$_line" ]; then
    _line="$(jq -cn --arg ts "$_ts" --arg e "$_ev" --arg s "${LEO_SESSION8:--}" \
      '{ts:$ts,event:$e,session:$s}' 2>/dev/null)"
  fi
  [ -n "$_line" ] || _line="{\"ts\":\"$_ts\",\"event\":\"$_ev\",\"session\":\"${LEO_SESSION8:--}\"}"
  printf '%s\n' "$_line" >> "$LEO_DIR/events.jsonl" 2>/dev/null || true
  return 0
}
