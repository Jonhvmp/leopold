#!/usr/bin/env bash
# Leopold subagent ledger: SubagentStart / SubagentStop, on both harnesses.
#
# WHY IT EXISTS. `leopold watch` has shown a `subagents` meter since 0.9 — value
# `subagents_spawned`, ceiling `max_subagents` — and NOTHING IN LEOPOLD EVER WROTE THAT
# FIELD. /leopold-run seeds it at 0 in the state template and never touches it again; the
# driver does not write it at all (packages/driver/src/*.ts has no reference to it). The
# meter read 0/8 for every run ever conducted, which is worse than absent: a zero that
# reads as success is exactly what CLAUDE.md bans. The prompt asked the model to "keep
# subagents lean" and nothing counted them. This hook is the counter.
#
# THE FACTS IT RIDES ON, from the probe's live captures (docs/reference/hook-events.md,
# `SubagentStart` / `SubagentStop` on both harnesses; hooks/hook-matrix.tsv, row
# `subagent-accounting`, all four rows `available`):
#   SubagentStart  `agent_id` + `agent_type` name the child; `session_id` is the PARENT's,
#                  which is what makes the ownership gate below the right question to ask.
#                  Codex adds `turn_id` and `model`; neither is needed here.
#   SubagentStop   `agent_id`, `agent_transcript_path`, `last_assistant_message` and
#                  `stop_hook_active` — the same accounting keys on Claude Code 2.1.259
#                  and Codex CLI 0.152.1, so `subagents[agent_id]` keys identically on
#                  both and no second shape exists.
# `last_assistant_message` is NOT read: it is model-facing text, and a hook that
# re-interprets what the model said is the thing this project's charter forbids. The
# child's cost is taken from the SIZE of its transcript, a fact of the filesystem.
#
# WHAT IT WRITES INTO state.json, and nothing else (scripts/test-hooks.sh diffs the state
# to prove it):
#   subagents_spawned         +1 per SubagentStart. The one writer of this field.
#   subagents[<agent_id>]     {agent_type, started_at, stopped_at, transcript_bytes}
# Never `iteration`, `no_progress`, `windows`, `context_mb`, `transcript_path`,
# `last_turn` or `owner` — those belong to hooks/stop-continuity.sh and to activation.
# A subagent is not a turn.
#
# THE LEDGER IS NOT PRUNED, on purpose. One entry is ~120 bytes; a run with a cap can
# only reach `max_subagents` of them, and an uncapped run would need thousands before
# state.json cost anything a hook can measure. A prune would need its own event, its own
# contract and a second reader — a cost with no failure behind it.
#
# COUNTED UNDER THE LOCK. Four children can start in the same second (the Agent tool
# takes a list), and an unlocked read-modify-write loses updates: the count would drift
# BELOW the truth and hooks/subagent-cap.sh would let the run past its ceiling. So the
# increment goes through the mkdir lock hooks/_lib.sh owns, and the spec in
# leo_core_hook_specs declares 10s against that ~5s budget (LEO_LOCK_HEADROOM) — a hook
# wired tighter is killed mid-wait and counts nothing. scripts/test-harness-lib.sh
# derives that floor rather than trusting this comment.
#
# IT NEVER BLOCKS. Exit 2 IS honored on SubagentStop on both harnesses (the capture: the
# child continues and stops again with `stop_hook_active: true`), and this hook never
# uses it — a ledger that can refuse a child's stop would spin it forever. The bound that
# refuses is hooks/subagent-cap.sh, at PreToolUse, before the spawn, where a deny reply
# was captured as honored. This one only records.
#
# Scope, in order (each case has a test in scripts/test-hooks.sh):
#   no .leopold/state.json, state that does not parse, run not active, or a session that
#     is not the run's                        -> silent. A continuity hook fails open, and
#                                                a stranger's subagents are not this run's
#                                                cost. Ownership comes from leo_hook_gate
#                                                (hooks/_lib.sh), the one reader.
#   anything but SubagentStart / SubagentStop -> silent.
#   SubagentStart                             -> count it, stamp `started_at`, log
#                                                `subagent_started`.
#   SubagentStop                              -> stamp `stopped_at` and `transcript_bytes`,
#                                                log `subagent_stopped`.
#
# A SubagentStop for an `agent_id` that never started here (the run was activated while a
# child was already running) creates its entry with a `stopped_at` and no `started_at`,
# and does NOT touch the count: half a fact recorded honestly beats a count that includes
# a spawn this run never made. A second SubagentStop for the same child — what a
# `stop_hook_active: true` re-firing looks like when another hook exits 2 — overwrites the
# same fields with the same kind of value and logs a second line, which is what happened.

input="$(cat 2>/dev/null || true)"

# The shared gate/lock/event library, resolved beside THIS script so the installed asset
# home works exactly like the checkout. Missing means a broken install: say so where a
# person will see it and let the harness carry on — a continuity hook never fails loud
# into the model's way, and an uncounted subagent is not worth interrupting a run for.
_LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
if [ -r "$_LEO_LIB" ]; then
  # shellcheck source=_lib.sh
  . "$_LEO_LIB"
else
  # Only where Leopold has something to say: the library is what establishes scope, so
  # its absence is checked against the one thing a hook can read without it — a
  # .leopold/state.json in the payload's cwd. A broken install must not print into every
  # session on the machine.
  _cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${_cwd:-}" ] || _cwd="$PWD"
  [ -f "$_cwd/.leopold/state.json" ] || exit 0
  echo "Leopold: hooks/_lib.sh is missing beside subagent-account.sh — this run's subagents are NOT being counted, so the cap cannot hold. Re-run the Leopold installer, then: leopold doctor" >&2
  exit 0
fi

# Active run, conducted by the session in this payload, or nothing at all. Without
# `report` this exits silently on every no — the continuity direction, and the right one:
# a ledger written for a run this session does not conduct would charge a stranger's work
# to somebody else's budget.
leo_hook_gate "$input"

# Wired on these two events; the name is checked anyway, because a hook that acts on a
# payload it was not written for is how one bad wiring becomes a corrupted count.
case "${LEO_EVENT:-}" in SubagentStart|SubagentStop) ;; *) exit 0 ;; esac

# The child's identity and kind. `agent_id` is the ledger's key and is stamped onto every
# event line by leo_hook_event (hooks/_lib.sh reads it from the payload itself), so it is
# never repeated in the extra object below. `agent_type` is the harness's own word —
# `general-purpose` on Claude Code, `default` or a role name on Codex — kept verbatim and
# bounded, never normalized: a normalized value would hide the day a new one appears.
agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null || true)"
agent_type="$(printf '%s' "$agent_type" | tr '\n\r\t' '   ' | sed -e 's/  */ /g' -e 's/^ *//' -e 's/ *$//')"
[ "${#agent_type}" -le 80 ] || agent_type="${agent_type:0:79}…"

now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"

# One read-modify-write of state.json, under the lock, from a jq program the caller
# supplies. A lock this hook cannot take inside its budget does not cost the write: it
# happens anyway, unlocked, and `lock_timeout` says so — the same choice every other state
# writer in hooks/ makes, because a lost counter is cheap and a missing one is not.
# Echoes the value of `subagents_spawned` after the write, read while the lock is still
# held, so the event line below reports the count that actually landed.
sa_write() { # <jq program> [jq args...]
  local prog="$1"; shift
  local tmp out=""
  leo_hook_lock || leo_hook_event lock_timeout
  tmp="$(mktemp 2>/dev/null || echo "$LEO_STATE.tmp")"
  if jq "$@" "$prog" "$LEO_STATE" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$LEO_STATE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
  out="$(jq -r '.subagents_spawned // 0' "$LEO_STATE" 2>/dev/null || echo 0)"
  leo_hook_unlock
  case "$out" in ''|*[!0-9]*) out=0 ;; esac
  printf '%s' "$out"
}

# `.subagents` and `.subagents_spawned` are normalized to their own types before use. They
# are Leopold's fields, so a hand-edited string where a number belongs is repaired rather
# than allowed to abort the whole write and lose the count with it. Written as two shell
# fragments because both jq programs below need the same two expressions and a second
# copy of either is a second contract.
SA_LEDGER='((.subagents // {}) | if type == "object" then . else {} end)'
SA_ENTRY='((.[$id] // {}) | if type == "object" then . else {} end)'
SA_TYPE='(if $ty == "" then {} else {agent_type: $ty} end)'

if [ "$LEO_EVENT" = "SubagentStart" ]; then
  # The count is unconditional; the ledger entry needs a key. A harness that ever sends
  # SubagentStart without `agent_id` still has its spawn counted — the cap rides on the
  # count, and losing a spawn from it would let a run past its ceiling — and simply gets
  # no per-child row, which the missing entry says honestly.
  count="$(sa_write \
    '.subagents_spawned = (((.subagents_spawned // 0) | if type == "number" then . else 0 end) + 1)
     | (if $id == "" then .
        else .subagents = ('"$SA_LEDGER"' | .[$id] = ('"$SA_ENTRY"' + {started_at: $at} + '"$SA_TYPE"'))
        end)' \
    --arg id "${LEO_AGENT:-}" --arg ty "$agent_type" --arg at "$now")"
  leo_hook_event subagent_started "$(jq -cn --arg ty "$agent_type" --argjson n "${count:-0}" \
    '{count:$n} + (if $ty == "" then {} else {agent_type:$ty} end)' 2>/dev/null || echo '{}')"
  exit 0
fi

# ---- SubagentStop: what the child cost, from the filesystem --------------------------
# `agent_transcript_path` is the child's OWN transcript on both harnesses (the capture:
# `<session>/subagents/agent-<id>.jsonl` on Claude Code, a rollout file under
# $CODEX_HOME/sessions on Codex), so its size is this child's contribution and not the
# parent's. An absent or unreadable file leaves the field out entirely rather than
# recording a 0 that would read as "this child produced nothing".
tpath="$(printf '%s' "$input" | jq -r '.agent_transcript_path // empty' 2>/dev/null || true)"
bytes=""
if [ -n "$tpath" ] && [ -f "$tpath" ]; then
  bytes="$(wc -c < "$tpath" 2>/dev/null | tr -d ' ')"
  case "$bytes" in ''|*[!0-9]*) bytes="" ;; esac
fi

if [ -n "${LEO_AGENT:-}" ]; then
  sa_write \
    '.subagents = ('"$SA_LEDGER"' | .[$id] = ('"$SA_ENTRY"'
        + {stopped_at: $at}
        + '"$SA_TYPE"'
        + (if $b == "" then {} else {transcript_bytes: ($b | tonumber)} end)))' \
    --arg id "$LEO_AGENT" --arg ty "$agent_type" --arg at "$now" --arg b "$bytes" >/dev/null
fi

leo_hook_event subagent_stopped "$(jq -cn --arg ty "$agent_type" --arg b "$bytes" \
  '(if $ty == "" then {} else {agent_type:$ty} end)
   + (if $b == "" then {} else {transcript_bytes: ($b | tonumber)} end)' 2>/dev/null || echo '{}')"
exit 0
