#!/usr/bin/env bash
# Leopold PermissionRequest policy: while the session that CONDUCTS an active run hits
# a permission prompt, the prompt is answered instead of waited on. The maintainer chose
# autonomy over safety at this seam on 2026-09-02: a run that stalls on a prompt nobody
# is watching is a run that stopped. Safety stays exactly where it already was —
# PreToolUse guards (the git lock, the persona allowlist), the harness sandbox, and the
# harness's own permission settings, none of which this hook can loosen.
#
# The ONE exception is the git lock, and it is not re-implemented here: a Bash payload
# is handed to hooks/guard-irreversible.sh as a synthesized PreToolUse payload and its
# deny is repeated VERBATIM — same reason, ALLOW_GIT / ALLOW_PUSH tokens honored
# identically, force-push denied token or not — because it is the same script deciding.
# A second copy of that decision here is exactly how two surfaces drift apart.
#
# Hook contract (PermissionRequest), captured live on both harnesses in
# docs/reference/hook-events.md — the reply shape is the same object on both:
#   allow: {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
#                                 "decision":{"behavior":"allow"}}}
#   deny:  {... "decision":{"behavior":"deny","message":"<reason>"}}
#   silence (exit 0, no output): the harness prompts exactly as it does today.
#
# Per harness, from hooks/hook-matrix.tsv (row `permission-policy`):
#   Claude Code 2.1.259  available   — fires under `--permission-prompts none`; allow AND
#                                      deny both honored. The default `host` prompt never
#                                      reaches the hook, which costs nothing: there is a
#                                      human there.
#   Codex CLI 0.152.1    substitute  — fires only under `--approve-for-me`, and only the
#                                      DENY half is honored; an allow reply is ignored and
#                                      Codex falls back to its own answer. So on Codex this
#                                      hook is the git lock's voice at the prompt and
#                                      nothing more; autonomy there stays with the driver's
#                                      sandbox flags. Same unmodified script either way.
#
# Scope, in order (each case has a test in scripts/test-hooks.sh; the git half is
# red-teamed command-for-command against the guard's own suite in scripts/test-guard.sh):
#   no .leopold/state.json           -> silence. Not a Leopold project.
#   the payload does not parse       -> DENY. Nothing below could be read out of it, so
#                                       an allow would be granted over a request nobody
#                                       saw — and with no command in it, the git lock
#                                       cannot speak either.
#   state.json does not parse        -> DENY. This is a guard, and a guard that cannot
#                                       read the run's scope fails closed and says so.
#   run not active                   -> silence.
#   a session that is not the run's  -> silence. The stop-hook incident of 2026-09-02 was
#                                       a second window conscripted by a run it did not
#                                       own; granting IT autonomy would be the same
#                                       mistake with the seat reversed. Ownership comes
#                                       from leo_hook_gate (hooks/_lib.sh), the one reader
#                                       hooks/stop-continuity.sh's rule was moved into, so
#                                       no two hooks can disagree about who conducts the
#                                       run. (Their git commit is still denied — by
#                                       the git lock at PreToolUse, project-wide, naming
#                                       the owner. This hook adds nothing there.)
#   the guard is missing/unusable    -> DENY. The allow below is granted ON the strength
#                                       of the git lock; without it there is nothing to
#                                       grant it on.
#   anything else                    -> allow, and log it.
#
# Every decision appends `permission_decided` (tool, command, decision, reason, session)
# to .leopold/events.jsonl. A git deny leaves TWO lines: the guard writes its own
# `guard_block` when it denies, and this hook writes the `permission_decided` that
# repeats it. Both are true and both are rendered by leopold watch.
#
# Silence is never a loosening: with no reply the harness does what it does today.

input="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0   # cannot parse safely -> defer to harness perms

# The event name is echoed back from the payload so the reply is addressed to the event
# that actually fired; both harnesses send `PermissionRequest` today. Scope and ownership
# (cwd, .leopold, the state file, the session) are read by leo_hook_gate below — this hook
# reads only the fields it DECIDES on.
event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
[ -n "${event:-}" ] || event="PermissionRequest"
tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"

# The shared gate/lock/event library, resolved beside THIS script so the installed asset
# home works exactly like the checkout. This is a GUARD: a missing library is a broken
# install, and a guard that cannot establish the run's scope denies and names what is
# missing rather than granting autonomy it cannot justify. The reply is written inline
# because deny() below logs through the very library that is not there.
_LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
if [ -r "$_LEO_LIB" ]; then
  # shellcheck source=_lib.sh
  . "$_LEO_LIB"
else
  # A broken install is a DENY — but only where Leopold has something to guard. The
  # library is what establishes scope, so its absence is checked against the one thing a
  # hook can read without it: a .leopold/state.json in the payload's cwd. Otherwise every
  # permission prompt on the machine, in projects Leopold never touched, would be denied
  # by a hook that is supposed to be inert there.
  _cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${_cwd:-}" ] || _cwd="$PWD"
  [ -f "$_cwd/.leopold/state.json" ] || exit 0
  jq -cn --arg e "$event" --arg m "Leopold: hooks/_lib.sh is missing beside permission-policy.sh, so the permission policy cannot establish this run's scope and fails closed. Re-run the Leopold installer, then: leopold doctor" \
    '{hookSpecificOutput:{hookEventName:$e,decision:{behavior:"deny",message:$m}}}'
  exit 0
fi

# The command is logged so a reader of events.jsonl can see WHAT was allowed, bounded to
# 200 chars: a permission prompt's command is short by nature, and an unbounded copy of
# arbitrary shell into a log file is a liability, not evidence.
log_cmd="$cmd"
[ "${#log_cmd}" -gt 200 ] && log_cmd="${log_cmd:0:200}..."

# One line per decision, stamped with `ts` and `session` by hooks/_lib.sh — the one
# stamper, so no hook can log a decision nobody can attribute.
log_decision() { # <decision> <reason>
  leo_hook_event permission_decided "$(jq -cn --arg tool "$tool" --arg cmd "$log_cmd" \
    --arg d "$1" --arg r "$2" '{tool:$tool,command:$cmd,decision:$d,reason:$r}' 2>/dev/null || echo '{}')"
}

allow() {
  jq -cn --arg e "$event" '{hookSpecificOutput:{hookEventName:$e,decision:{behavior:"allow"}}}'
  log_decision allow "$1"
  exit 0
}
deny() {
  jq -cn --arg e "$event" --arg m "$1" \
    '{hookSpecificOutput:{hookEventName:$e,decision:{behavior:"deny",message:$m}}}'
  log_decision deny "$1"
  exit 0
}

# ---- scope + ownership, through the one reader --------------------------------------
# hooks/_lib.sh answers "is there an active run here, and does the session in this payload
# conduct it" for every state-coupled hook — the same reader hooks/stop-continuity.sh and
# hooks/compact-checkpoint.sh use, so the three cannot disagree about who conducts a run.
# (That disagreement is not hypothetical: it is the 2026-09-02 incident.)
#
# `report` because this hook is a GUARD and the fail direction is its own: the gate reports
# what it found and the two unreadable cases below deny instead of exiting silently. The
# library never makes that choice for a caller.
#
#   no .leopold/state.json  -> silence. Not a Leopold project.
#   the payload does not parse -> DENY. Every field this hook decides on came out of it,
#       and each extraction above degrades to empty rather than failing — so an unreadable
#       payload would otherwise fall all the way through to `allow`, granting a run
#       autonomy over a request nobody read, with an empty command the git lock cannot
#       judge. Silence looks like the safer answer and is not: it hands an unattended run
#       to a prompt no one will answer, which is the stall this hook exists to end, and
#       says nothing about why. Both harnesses send JSON here (every capture in
#       docs/reference/hook-events.md), so reaching this means the harness and Leopold
#       disagree about the contract — worth saying out loud, once, in the reply the model
#       actually reads.
#   state.json does not parse -> DENY. The run's scope — is it active, whose is it —
#       cannot be read, so nothing is granted on it. Same direction the git lock takes on
#       the same file, for the same reason.
#   run not active, or a session that is not the run's -> silence. The stop-hook incident
#       of 2026-09-02 was a second window conscripted by a run it did not own; granting IT
#       autonomy would be the same mistake with the seat reversed. (Its git commit is still
#       denied — by the git lock at PreToolUse, project-wide, naming the owner. This hook
#       adds nothing there.) A run with no owner recorded at all is open: the Stop hook
#       continues whoever stops in that checkout, so this hook answers for them too.
if ! leo_hook_gate "$input" report; then
  case "$LEO_GATE_REASON" in
    payload_unreadable)
      deny "Leopold: this PermissionRequest payload did not parse as JSON, so the permission policy cannot see what is being asked and fails closed (a guard, not a convenience). The harness and Leopold disagree about the hook contract — re-run the Leopold installer, then: leopold doctor" ;;
    state_unreadable)
      deny "Leopold: .leopold/state.json does not parse, so this run's scope cannot be established and the permission policy fails closed. Fix the file (or re-run /leopold-brief); the harness's own prompt returns as soon as it parses." ;;
    *) exit 0 ;;
  esac
fi
cwd="$LEO_CWD"
me="$LEO_SESSION"

# ---- the git lock decides git, and only it ----------------------------------------
# Resolved beside this script so the installed asset home works exactly like the checkout.
GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/guard-irreversible.sh"
if [ ! -f "$GUARD" ] || [ ! -r "$GUARD" ]; then
  deny "Leopold: the permission policy could not consult the git lock ($GUARD) and will not grant autonomy without it (fail closed). Re-run the Leopold installer, then: leopold doctor"
fi

# The synthesized PreToolUse payload: the same fields the guard reads, no more. Passing
# the PermissionRequest payload through unchanged would tie the guard's future to this
# event's shape.
guard_out="$(jq -cn --arg cwd "$cwd" --arg t "$tool" --arg s "$me" \
               --argjson ti "$(printf '%s' "$input" | jq -c '.tool_input // {}' 2>/dev/null || echo '{}')" \
               '{hook_event_name:"PreToolUse",cwd:$cwd,session_id:$s,tool_name:$t,tool_input:$ti}' \
             | bash "$GUARD" 2>/dev/null)"
guard_rc=$?
if [ "$guard_rc" -ne 0 ]; then
  deny "Leopold: the git lock exited $guard_rc instead of deciding, so the permission policy fails closed. Check hooks/guard-irreversible.sh, then: leopold doctor"
fi
if [ -n "$guard_out" ]; then
  if ! printf '%s' "$guard_out" | jq -e . >/dev/null 2>&1; then
    deny "Leopold: the git lock replied with output the permission policy could not parse, so it fails closed. Check hooks/guard-irreversible.sh, then: leopold doctor"
  fi
  guard_dec="$(printf '%s' "$guard_out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || true)"
  if [ "$guard_dec" = "deny" ]; then
    # Repeat the verdict, in the guard's own words. Never a reason of this hook's own.
    guard_reason="$(printf '%s' "$guard_out" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null || true)"
    [ -n "$guard_reason" ] || guard_reason="Leopold guard: denied."
    deny "$guard_reason"
  fi
fi

allow "an active Leopold run conducts this session — autonomy over the prompt"
