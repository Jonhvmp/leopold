#!/usr/bin/env bash
# Leopold subagent cap: PreToolUse, on both harnesses. The one bound that REFUSES a
# spawn, as opposed to hooks/subagent-account.sh, which only counts them.
#
# WHY PreToolUse AND NOT SubagentStart. By the time `SubagentStart` fires the child
# exists; the probe captured no honored deny reply on that event on either harness, so a
# cap there could observe and nothing more. `PreToolUse` answers BEFORE the tool runs and
# its `permissionDecision: deny` was captured as honored on Claude Code 2.1.259 and Codex
# CLI 0.152.1 alike — the tool never ran and the reason reached the model
# (docs/reference/hook-events.md; hooks/hook-matrix.tsv, row `subagent-cap`, both rows
# `available`; .leopold/DECISIONS.md, "subagent-cap — both harnesses").
#
# MATCH WIDE, DECIDE NARROW. The spec in leo_core_hook_specs matches
# `Agent|Task|collaborationspawn_agent` — Claude Code's spawn tools and the name Codex's
# spawn arrives under at PreToolUse (Findings: "its multi-agent tools reach `PreToolUse`
# as `collaborationspawn_agent` / `collaborationwait_agent`"). The matcher is a superset
# on purpose: the reference page records the Agent tool as the trigger but quotes no
# spawn payload, an extra alternative costs nothing, and THIS SCRIPT re-checks
# `tool_name` itself and exits silently for anything else — exactly as
# hooks/guard-irreversible.sh re-checks for `Bash`. A harness that applied no matcher at
# all would still get one answer and only for a spawn. A tool name the probe has not
# captured is added by re-probing, never by guessing.
#
# WHERE THE CAP COMES FROM, in this order:
#   1. `max_subagents` in .leopold/state.json — what /leopold-run's state template writes
#      (default 8) and the number `leopold watch` already draws its meter against.
#   2. `max_subagents:` in .leopold/GUARDRAILS.md — for a brief that sets a ceiling the
#      activation never copied into state. Read lexically, the same shape
#      hooks/compact-checkpoint.sh reads `max_checkpoint_kb:` with.
#   3. Neither: NO CAP. The hook prints nothing and the spawn proceeds exactly as it does
#      today. That is the backward-compatible half of this bound — a state.json without
#      the field runs byte-for-byte as before.
# `max_subagents: 0` is a real ceiling ("no subagents this run"), the same way
# `max_forks: 0` already is; only an ABSENT or non-numeric value means no cap.
#
# THE COUNT IS hooks/subagent-account.sh's. This hook reads `subagents_spawned` and never
# writes it — one writer per field — so it takes no state lock at all and is wired at the
# 5s the git lock uses. What it compares is the count of spawns this run has ALREADY made
# against the ceiling: at `2/2` the third spawn is denied.
#
# IT ONLY EVER DENIES. There is no allow reply here: a PreToolUse hook that answered
# `allow` would override the git lock and the persona allowlist, which decide first and
# whose denials this must never loosen. Below the cap it prints nothing and the harness's
# own permission system does what it always does.
#
# Scope, in order (each case has a test in scripts/test-hooks.sh):
#   the tool is not a spawn tool          -> silence, before anything else is read.
#   no jq                                 -> silence. Nothing here can parse anything.
#   no .leopold/state.json                -> silence. Not a Leopold project.
#   state.json does not parse             -> DENY. The one fail-CLOSED case: the run's
#                                            ceiling cannot be read, and a cap that
#                                            silently lapses because a file is malformed
#                                            is not a bound. Same direction
#                                            hooks/guard-irreversible.sh takes on the
#                                            same file.
#   run not active, or a session that is  -> silence. A second window's subagents are not
#     not the run's                          this run's budget, and denying them would be
#                                            the 2026-09-02 incident with the seat
#                                            reversed. Ownership comes from
#                                            leo_hook_gate (hooks/_lib.sh), the one reader.
#   no cap configured                     -> silence (today's behavior).
#   count < cap                           -> silence.
#   count >= cap                          -> deny, naming `count/cap`, and log
#                                            `subagent_cap_denied`.
#
# A MISSING hooks/_lib.sh IS NOT A DENY, and this is the one place this hook parts
# company with hooks/permission-policy.sh. The policy denies there because it exists to
# GRANT autonomy and must not grant it on a gate that never opened. The cap grants
# nothing: it is a budget ceiling, and refusing every spawn in the project because an
# installed file went missing would stop the run's actual work over a broken install —
# while the git lock (which needs no library) and the permission policy (which denies
# loudly for the same cause) already carry the safety half. So it says so on stderr,
# where Leopold has something to say, and gets out of the way.

input="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0   # cannot parse safely -> defer to harness perms

# Decide narrow, first thing: the spawn tools this hook answers for, and nothing else.
# A payload that does not parse yields an empty name and falls out here — which is the
# right direction, not an oversight: with no tool name there is no spawn to cap, and a
# hook that denied every tool it could not identify would deny the session's work on the
# strength of a payload nobody could read.
tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"
case "$tool" in
  Task|Agent|collaborationspawn_agent) ;;
  *) exit 0 ;;
esac

# The shared gate/lock/event library, resolved beside THIS script so the installed asset
# home works exactly like the checkout. See the note above on why its absence is not a
# denial. The reply below never runs without it, so nothing here depends on a half-loaded
# contract.
_LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
if [ -r "$_LEO_LIB" ]; then
  # shellcheck source=_lib.sh
  . "$_LEO_LIB"
else
  _cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${_cwd:-}" ] || _cwd="$PWD"
  [ -f "$_cwd/.leopold/state.json" ] || exit 0
  echo "Leopold: hooks/_lib.sh is missing beside subagent-cap.sh — max_subagents is NOT being enforced for this run. Re-run the Leopold installer, then: leopold doctor" >&2
  exit 0
fi

# The deny reply the probe captured as honored on both harnesses — the same object
# hooks/guard-irreversible.sh prints, with `hookEventName` fixed at the one event this
# hook is wired on. Every denial leaves a `subagent_cap_denied` line, stamped with `ts`
# and `session` by hooks/_lib.sh, so a reader of events.jsonl can see the ceiling bite.
deny() { # <reason> [extra JSON object for the event]
  local x="${2:-}"
  [ -n "$x" ] || x='{}'
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  leo_hook_event subagent_cap_denied "$(jq -cn --arg t "$tool" --argjson x "$x" \
    '{tool:$t} + (if ($x|type) == "object" then $x else {} end)' 2>/dev/null || echo '{}')"
  exit 0
}

# ---- scope + ownership, through the one reader --------------------------------------
# `report` because the fail direction is this hook's own: an unreadable state.json denies
# (a ceiling that lapses on a malformed file is not a ceiling), and every other no is
# silence. The library never makes that choice for a caller.
if ! leo_hook_gate "$input" report; then
  case "$LEO_GATE_REASON" in
    state_unreadable)
      deny "Leopold: .leopold/state.json does not parse, so this run's subagent ceiling (max_subagents) cannot be read and the cap fails closed — the spawn was denied. Fix the file (or re-run /leopold-brief); spawning works again as soon as it parses." ;;
    *) exit 0 ;;
  esac
fi

# ---- the ceiling ---------------------------------------------------------------------
cap=""; cap_from=""
v="$(jq -r '.max_subagents // empty' "$LEO_STATE" 2>/dev/null || true)"
case "$v" in ''|*[!0-9]*) v="" ;; esac
if [ -n "$v" ]; then
  cap="$v"; cap_from="state.json"
else
  # The brief's own line, read lexically: `- max_subagents: 4`, `**max_subagents**: 4`,
  # with or without the list dash. A commented-out template line (`<!-- ... -->`) does not
  # match, which is what makes the template's own examples inert.
  v="$(grep -m1 -iE '^[[:space:]]*-?[[:space:]]*(\*\*)?max_subagents(\*\*)?[[:space:]]*:[[:space:]]*[0-9]+' \
        "$LEO_DIR/GUARDRAILS.md" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  case "$v" in ''|*[!0-9]*) v="" ;; esac
  if [ -n "$v" ]; then cap="$v"; cap_from="GUARDRAILS.md"; fi
fi
# No ceiling declared anywhere: today's behavior, exactly. Nothing is printed, nothing is
# logged, and the spawn goes through as it always has.
[ -n "$cap" ] || exit 0

count="$(jq -r '.subagents_spawned // 0' "$LEO_STATE" 2>/dev/null || echo 0)"
case "$count" in ''|*[!0-9]*) count=0 ;; esac

[ "$count" -ge "$cap" ] || exit 0

# The reason names the two numbers because that is what the model has to act on, and it
# does NOT invite the run to raise its own ceiling: a budget is the human's to set
# (.leopold/GUARDRAILS.md says so in as many words, and no run may edit that file).
deny "Leopold: this run has reached its subagent ceiling — $count/$cap spawned (max_subagents: $cap, from $cap_from). The spawn was denied. Do this item's work in your own turn: read the files you need directly instead of delegating, and keep the remaining plan items in this session. Raising the ceiling is the human's call, in .leopold/GUARDRAILS.md. Nothing else is blocked." \
  "$(jq -cn --argjson c "$count" --argjson m "$cap" --arg s "$cap_from" \
     '{count:$c,cap:$m,source:$s}' 2>/dev/null || echo '{}')"
