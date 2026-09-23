#!/usr/bin/env bash
# Leopold's tamper detector for the harness's own configuration: ConfigChange, Claude
# Code only.
#
# WHAT IT IS FOR. Every bound Leopold enforces during a run is a hook declared in the
# harness's settings — the git lock first among them. A settings file rewritten mid-run
# can therefore disarm the run's guards from inside the run, and until now nothing noticed.
# This is the one hook of the pair that REFUSES: a settings reload while a run is active is
# blocked and logged. The pair's other half (hooks/file-watch.sh) only warns, because a
# human editing the plan is legitimate; a settings reload that would swap the guards under
# a running conductor is not.
#
# THE FACTS IT RIDES ON (docs/reference/hook-events.md `ConfigChange` — Claude Code;
# hooks/hook-matrix.tsv, capability `config-guard`; .leopold/DECISIONS.md, "config-guard —
# Claude Code only, ConfigChange.source"):
#
#   THE PAYLOAD IS `source` + `file_path`. `source` is the settings LAYER that changed
#   (`project_settings` is the one the probe captured, writing .claude/settings.json
#   mid-session); `file_path` is the file. Both are read here; nothing else is.
#
#   EXIT 2 BLOCKS THE RELOAD, NOT THE WRITE — measured, not inferred. The event probe
#   could NOT see this: it records the ConfigChange `exit2` reply as **unobservable**
#   (docs/reference/hook-events.md), because a ConfigChange hook never reaches the
#   session's stream at all — no `hook_started`, no `hook_response`, so no exit code to
#   read — and "the file kept the edit" is equally true whether the reload was blocked or
#   adopted, so it proves nothing on its own. So it was measured separately, with a side
#   effect only a reload can produce: docs/reference/config-reload-block.md — three paired
#   headless runs on Claude Code 2.1.260, each rewriting its own .claude/settings.json
#   mid-turn to ADD a PreToolUse hook, then making one more tool call. Exit 0 -> the added
#   hook fired on that call, 3/3 (the session adopted the reload). Exit 2 -> it never
#   fired, 0/3, while the file on disk kept the edit in all six.
#
#   So the block buys exactly one thing — the running session does not adopt the new
#   configuration — and the run's guards stay the ones it started with. It does NOT undo
#   the edit, and it cannot: nothing in this event can. That is why the hook LOGS as
#   loudly as it blocks. `config_change_blocked` is the durable record that the file on
#   disk and the session's live wiring have diverged, and scripts/leopold-watch.py renders
#   it as the critical event it is.
#
#   CODEX HAS NO ConfigChange AT ALL (the matrix row, evidence
#   #what-this-decides-for-leopold). A mid-run edit of config.toml is not detected there,
#   extensions/lib/harness.sh refuses the spec for Codex, and `leopold doctor` says so per
#   harness rather than letting the silence read as coverage.
#
# WHAT PASSES, AND WHY THE REST DOES NOT. Two layers are allowed through:
#
#   policy_settings  the administrator's managed policy. It is not the run's to refuse:
#                    a hook that blocked it would be a run overruling the machine's owner,
#                    and the charter's "never loosen, never overrule" cuts both ways.
#   skills           skills are prompt material, not wiring. Reloading one cannot disarm a
#                    guard, and a run that installs or edits a skill mid-flight is doing
#                    ordinary work.
#
# EVERYTHING ELSE IS REFUSED, including a `source` this hook has never heard of, a payload
# with no `source` at all, a payload that is not JSON, and a .leopold/state.json that does
# not parse. That is the fail-CLOSED direction the charter sets for a guard: the allowed
# layers are named, an unknown layer is a layer whose blast radius nobody has measured, and
# a guard that cannot tell whether a run is active does not get to assume it is not. The cost of being wrong is one skipped reload in one session, said
# out loud twice (stderr and the event log); the cost of the other direction is a run whose
# git lock was replaced while it was running.
#
# SCOPE, in order (each case has a test in scripts/test-hooks.sh):
#   no .leopold/state.json, run not active, or a session that is not the run's
#                             -> silent, exit 0. INERT WITHOUT AN ACTIVE RUN: this hook
#                                ships to every project on the machine, and a settings edit
#                                outside a Leopold run is none of its business. Ownership
#                                comes from leo_hook_gate (hooks/_lib.sh), the one reader.
#   .leopold/state.json does not parse, or the payload does not parse
#                             -> the guard FAILS CLOSED and refuses (below).
#   jq is not on PATH         -> said out loud on stderr, and allowed (below).
#   anything but ConfigChange -> silent.
#   source policy_settings / skills -> allowed, silent, even on an unreadable state: those
#                                two layers cannot disarm a run, and the machine owner's
#                                policy is never this run's to refuse.
#   anything else            -> `config_change_blocked` + exit 2 with the reason on stderr.
#
# It writes no state: the run's counters belong to the hooks that own them, and a blocked
# reload is an event, not a counter.

input="$(cat 2>/dev/null || true)"

# The layers a run does not refuse. Named here, once, so the message and the test read the
# same list as the code.
CG_ALLOWED="policy_settings skills"

# The shared gate/event library, resolved beside THIS script so the installed asset home
# works exactly like the checkout. A guard that cannot establish scope must not start
# refusing things at random: without the library this hook cannot tell whether a run is
# even active, and blocking every settings reload on the machine would be far worse than
# the hole it is covering. So it says so where a person will see it — and only inside a
# Leopold project — and allows. This is the SAME line the missing-jq branch below draws,
# for the same reason, and it is not the fail-closed direction being abandoned: refusing
# needs a scope, and with no library (or no jq) there is none — nor is there a run left to
# protect, since every other Leopold hook is inert under exactly these conditions.
_LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
if [ -r "$_LEO_LIB" ]; then
  # shellcheck source=_lib.sh
  . "$_LEO_LIB"
else
  _cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${_cwd:-}" ] || _cwd="$PWD"
  [ -f "$_cwd/.leopold/state.json" ] || exit 0
  echo "Leopold: hooks/_lib.sh is missing beside config-guard.sh — a settings change during a run is NOT being refused, so this run's guards can be swapped from inside it. Re-run the Leopold installer, then: leopold doctor" >&2
  exit 0
fi

# ---- scope + ownership, through the one reader ---------------------------------------
# `report`, because the fail direction is this hook's own and the library never picks it.
# Two of the gate's noes are NOT "no run here" — they are "this guard cannot tell", and a
# guard that cannot tell refuses. That is the direction hooks/guard-irreversible.sh,
# hooks/subagent-cap.sh and hooks/permission-policy.sh already take on the same file
# ("a ceiling that lapses on a malformed file is not a ceiling"), and this hook is the one
# standing between a running conductor and a rewrite of its own wiring:
#
#   state_unreadable    .leopold/state.json exists and does not parse. Whether a run is
#                       active cannot be established, so it is not assumed to be inactive.
#                       Reachable in ordinary operation, not just under an attacker: the
#                       state file is rewritten many times a turn, and a reader that does
#                       not hold .leopold/.state.lock can catch it mid-write.
#   payload_unreadable  the ConfigChange payload is not JSON, so `source` and `file_path`
#                       could not be read either — the refusal below files it as `unknown`,
#                       which is exactly what an unnamed layer is.
#
# Everything else is silence: no .leopold/state.json (not a Leopold project), no active
# run, a driver's run seen from a session that is not its worker, or a session that is not
# the run's. A settings reload in a project that is not conducting anything is none of
# this hook's business.
#
# jq missing is the one "cannot tell" that does NOT refuse, and the reason is not
# convenience: without jq EVERY Leopold hook is already inert — hooks/guard-irreversible.sh
# exits 0 at its first line for the same reason, so the git lock this guard exists to
# protect is not armed in the first place. There is no wiring left to preserve, and
# refusing every settings reload in every Leopold project on the machine would buy nothing
# and could not be undone from inside (this event blocks reloads, not writes). So it is
# said out loud where a person will see it — and only inside a Leopold project — and
# allowed. `leopold doctor` reports the missing jq as the install fault it is.
cg_gate_reason=""
if ! leo_hook_gate "$input" report; then
  case "$LEO_GATE_REASON" in
    state_unreadable|payload_unreadable) cg_gate_reason="$LEO_GATE_REASON" ;;
    no_jq)
      # No jq means no LEO_* at all (the gate stops before it sets them), so the project
      # test is done here, lexically, on the payload's own `cwd`.
      _cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
      [ -n "${_cwd:-}" ] || _cwd="$PWD"
      [ -f "$_cwd/.leopold/state.json" ] || exit 0
      echo "Leopold: jq is not on PATH, so config-guard.sh cannot read this settings change — it is NOT being refused. Every other Leopold hook is inert for the same reason, the git lock included. Install jq, then: leopold doctor" >&2
      exit 0
      ;;
    *) exit 0 ;;
  esac
fi

# Wired on one event; the name is checked anyway, because a guard that refuses on a
# payload it was not written for is one bad wiring away from refusing everything. An
# unreadable payload has no name to check — and this hook is wired on exactly one event —
# so it is judged as the ConfigChange it can only be.
case "${LEO_EVENT:-ConfigChange}" in ConfigChange) ;; *) exit 0 ;; esac

cg_source="$(printf '%s' "$input" | jq -r '.source // ""' 2>/dev/null || true)"
cg_file="$(printf '%s' "$input" | jq -r '.file_path // ""' 2>/dev/null || true)"
case "$cg_source" in null) cg_source="" ;; esac
case "$cg_file" in null) cg_file="" ;; esac

for _a in $CG_ALLOWED; do
  [ "$cg_source" = "$_a" ] && exit 0
done

# Refuse: the event first (durable, and the one thing that survives this window), then the
# reason on stderr with exit 2 — the reply docs/reference/config-reload-block.md measured
# this event honoring. A refusal the guard could not fully justify says which of its two
# "cannot tell" cases it is, in the event and on stderr both: a reader of events.jsonl has
# to be able to separate "this layer is refused" from "this guard was flying blind".
leo_hook_event config_change_blocked "$(jq -cn --arg s "$cg_source" --arg f "$cg_file" --arg r "$cg_gate_reason" \
  '{source: (if $s == "" then "unknown" else $s end)}
   + (if $f == "" then {} else {file_path:$f} end)
   + (if $r == "" then {} else {reason:$r} end)' \
  2>/dev/null || echo '{}')"

# The lead-in never asserts what this run could not read: on the fail-closed paths the
# guard does NOT know a run is active — that is why it refused — and a message that said
# so anyway would be the same overclaim the guard exists to prevent, one layer up.
case "$cg_gate_reason" in
  state_unreadable)   cg_why=" .leopold/state.json does not parse, so whether a run is active could not be established and this guard fails closed — fix the file (or re-run /leopold-brief) and reloads work again." ;;
  payload_unreadable) cg_why=" The ConfigChange payload did not parse as JSON, so the layer that changed could not be read and this guard fails closed — the harness and Leopold disagree about the hook contract; re-run the Leopold installer, then: leopold doctor." ;;
  *)                  cg_why="" ;;
esac
if [ -z "$cg_gate_reason" ]; then
  cg_lead="a Leopold run is active and ${cg_file:-a settings file} changed (source: ${cg_source:-unknown})"
else
  cg_lead="${cg_file:-a settings file} changed (source: ${cg_source:-unknown}) and this guard could not establish whether a run is active"
fi

printf '%s\n' "Leopold: ${cg_lead} — the reload was refused, so this session keeps the hook wiring it started with. The file on disk KEEPS the edit: exit 2 stops the reload, not the write.${cg_why} Every guard this run relies on — the git lock first — is declared in that wiring, and swapping it mid-run is how a run stops being conducted. Finish or stop the run (/leopold-stop), then change the settings. Allowed without refusal: ${CG_ALLOWED}." >&2
exit 2
