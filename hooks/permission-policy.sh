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

# ---- the semantic second axis: it may only ever DENY ---------------------------------
# Everything above has already decided ALLOW. This asks one more question — "how destructive
# and hard to reverse is this command?" — and can turn that allow into a deny. It can do
# nothing else: it is never consulted on a path that was heading for a deny, so it cannot
# grant, soften, or reword one. `guard-irreversible.sh` decided git before this line and its
# verdict was already repeated verbatim.
#
# EVERY FAILURE MODE KEEPS TODAY'S BEHAVIOUR, and costs no network call:
#   the decisions extension is not installed        -> allow, silently, as before
#   this project has no permission catalog          -> allow, silently, as before
#   the provider is unreachable / slow / uncalibrated for this catalog -> allow, logged
# A stalled permission prompt is the exact failure this hook exists to END, so the seam is
# given a hard millisecond bound and anything at or past it is a fall back, not a wait.
#
# The seam is `curl` + `jq` and speaks the System One shape only; a chat-completions provider
# configured here answers `unsupported` and lands in the same fall-back branch, named.
if   [ -n "${LEOPOLD_DECISIONS_DIR:-}" ]; then DEC_DIR="$LEOPOLD_DECISIONS_DIR"
elif [ -n "${LEOPOLD_HOME:-}" ];          then DEC_DIR="$LEOPOLD_HOME/decisions"
elif [ -d "${CLAUDE_HOME:-$HOME/.claude}/decisions" ]; then DEC_DIR="${CLAUDE_HOME:-$HOME/.claude}/decisions"
elif [ -d "${CODEX_HOME:-$HOME/.codex}/decisions" ];   then DEC_DIR="${CODEX_HOME:-$HOME/.codex}/decisions"
# An existing harness home, before the historical default — the step the other two copies of this
# resolution have (leo_decisions_dir in extensions/lib/harness.sh, and scripts/leopold-doctor.sh).
# Without it a Codex-only box looked under ~/.claude for a payload installed under ~/.codex.
elif [ -d "${CLAUDE_HOME:-$HOME/.claude}" ];           then DEC_DIR="${CLAUDE_HOME:-$HOME/.claude}/decisions"
elif [ -d "${CODEX_HOME:-$HOME/.codex}" ];             then DEC_DIR="${CODEX_HOME:-$HOME/.codex}/decisions"
else DEC_DIR="${CLAUDE_HOME:-$HOME/.claude}/decisions"
fi
DEC_SEAM="$DEC_DIR/decisions.sh"
DEC_CATALOG="$cwd/.leopold/decisions/permission.json"
DEC_TIMEOUT="${LEOPOLD_DECISIONS_TIMEOUT_MS:-2000}"

if [ -x "$DEC_SEAM" ] && [ -f "$DEC_CATALOG" ] && [ -n "$cmd" ]; then
  dec_state="$(mktemp)"
  jq -cn --arg c "$cmd" --arg t "$tool" '{tool:$t,command:$c}' > "$dec_state" 2>/dev/null || printf '{}' > "$dec_state"
  # A HARD OUTER BOUND, not just the seam's own. `--timeout-ms` bounds the seam's curl; it does
  # not bound the seam. A stalled prompt is the failure this hook exists to end, so the call runs
  # as a child and is killed at the deadline no matter what it is stuck on. `timeout(1)` is not
  # portable (macOS ships without it), so the wait is a bounded poll in the shell itself.
  dec_result="$(mktemp)"
  bash "$DEC_SEAM" --leo-dir "$cwd/.leopold" --catalog permission \
       --questions destructive --state-file "$dec_state" \
       --schema "$DEC_DIR/catalog.schema.json" --timeout-ms "$DEC_TIMEOUT" > "$dec_result" 2>/dev/null &
  dec_pid=$!
  # +250ms of grace over the seam's own budget, then it is over regardless.
  dec_deadline=$(( DEC_TIMEOUT + 250 ))
  dec_waited=0
  while kill -0 "$dec_pid" 2>/dev/null && [ "$dec_waited" -lt "$dec_deadline" ]; do
    sleep 0.05
    dec_waited=$(( dec_waited + 50 ))
  done
  if kill -0 "$dec_pid" 2>/dev/null; then
    kill -9 "$dec_pid" 2>/dev/null || true
    dec_out=""
  else
    wait "$dec_pid" 2>/dev/null || true
    dec_out="$(cat "$dec_result" 2>/dev/null || true)"
  fi
  rm -f "$dec_state" "$dec_result"

  dec_band="$(printf '%s' "$dec_out" | jq -r '.bands.destructive // ""' 2>/dev/null || true)"
  dec_score="$(printf '%s' "$dec_out" | jq -r '.answers.destructive.score // empty' 2>/dev/null || true)"
  dec_reason="$(printf '%s' "$dec_out" | jq -r '.answers.destructive.reason // ""' 2>/dev/null || true)"

  if [ "$dec_band" = "act" ] && [ -n "$dec_score" ]; then
    # The top level of the rubric is "irreversible, or reaches outside this machine". Deny only
    # when the mass is actually there — 2.5 on a 0..3 scale — and say the number, so the reason
    # is auditable rather than an appeal to a model.
    if awk -v s="$dec_score" 'BEGIN { exit !(s >= 2.5) }'; then
      leo_hook_event decision_denied "$(jq -cn --arg cmd "$log_cmd" --arg s "$dec_score" \
        '{command:$cmd,score:($s|tonumber),axis:"destructive"}' 2>/dev/null || echo '{}')"
      deny "Leopold: the permission policy allowed this lexically, then scored it $dec_score of 3 on \"how destructive and hard to reverse is this command?\" — at or above 2.5 that rubric means irreversible, or reaching outside this machine. Denied by the semantic axis, which can only ever add a denial. Adjust .leopold/decisions/permission.json, or run the command yourself."
    fi
  elif [ -z "$dec_band" ] || [ "$dec_band" != "act" ]; then
    # Not usable: a timeout, an unreachable provider, an `unsupported` seam, or an answer that
    # did not clear the bar. All the same outcome — the lexical verdict stands — and all worth
    # one line, because a run whose semantic axis never fires should be able to find out why.
    leo_hook_event decision_timeout "$(jq -cn --arg cmd "$log_cmd" --arg r "${dec_reason:-not usable}" \
      '{command:$cmd,axis:"destructive",fell_back:true,reason:$r}' 2>/dev/null || echo '{}')"
  fi
fi

allow "an active Leopold run conducts this session — autonomy over the prompt"
