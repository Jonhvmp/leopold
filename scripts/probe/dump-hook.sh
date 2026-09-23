#!/usr/bin/env bash
# Leopold — hook-event probe: the dump hook.
#
# Wired by scripts/probe-hook-events.sh on every lifecycle event a harness documents.
# It appends its stdin VERBATIM (one line, exactly the bytes the harness sent) to
#   <out>/<harness>/<event>.jsonl
# and one RECORD (timestamp, run, mode, the reply it gave, env facts, and the same
# payload again as a JSON string) to
#   <out>/<harness>/<event>.meta.jsonl
# The record carries its own payload on purpose: a harness kills a hook it does not
# wait for (StopFailure at process exit) within milliseconds, and two files paired by
# line number cannot survive one missing line — every later record would be shifted.
# The record is written first, the verbatim line second; a killed hook loses at most
# the verbatim copy of one firing, never the attribution of the next.
# The event name is its first ARGUMENT, so a payload that carries no
# `hook_event_name` still files under the right name — that absence is itself a
# finding the doc records.
#
# Usage:  dump-hook.sh <event> [--out DIR] [--harness NAME] [--mode MODE] [--run NAME] [--tag TEXT]
#
# Every value can also arrive by env (PROBE_OUT, PROBE_HARNESS, PROBE_MODE, PROBE_RUN);
# the argument wins. The driver always passes arguments: whether a hook process
# inherits the driver's env is one of the questions the probe answers, so nothing
# here may depend on the answer.
#
# Reply modes (PROBE_MODE / --mode) — the answer the hook gives, in each harness's
# documented shape, so the doc can record which reply each harness honored:
#   observe            exit 0, nothing on stdout                       (default)
#   allow              PreToolUse: permissionDecision allow; PermissionRequest: decision allow
#   deny               PreToolUse: permissionDecision deny;  PermissionRequest: decision deny;
#                      Stop/SubagentStop/UserPromptSubmit/PostToolUse: {"decision":"block"} — ONCE
#                      per (run, event), for the same reason exit2 is
#   exit2              stderr "probe exit2 <event>", exit 2 — ONCE per (run, event):
#                      a Stop hook that blocked every stop would never let the session end
#   systemMessage      {"systemMessage": "PROBE_SYSMSG <event>"}
#   additionalContext  {"hookSpecificOutput": {"hookEventName": <event>, "additionalContext": "PROBE_CTX <event>"}}
#   elicit             Elicitation: {"hookSpecificOutput": {"hookEventName":"Elicitation","action":"accept","content":{"answer":"PROBE_ELICIT"}}}
#                      ElicitationResult: same shape, content.answer "PROBE_MODIFIED"
#   worktree           WorktreeCreate: `git worktree add --detach` under <cwd>/.probe-worktrees, path on stdout;
#                      WorktreeRemove: `git worktree remove --force` of the payload's worktree_path
#
# bash + jq only. Fail-open: a dump that cannot be written must never break the
# session it observes — it exits 0 with nothing on stdout.
set -u

event="${1:?dump-hook.sh: event name}"; shift
out="${PROBE_OUT:-}"; harness="${PROBE_HARNESS:-unknown}"; mode="${PROBE_MODE:-observe}"
run="${PROBE_RUN:-}"; tag=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out)     out="$2";     shift 2 ;;
    --harness) harness="$2"; shift 2 ;;
    --mode)    mode="$2";    shift 2 ;;
    --run)     run="$2";     shift 2 ;;
    --tag)     tag="$2";     shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || exit 0

dir="$out/$harness"
mkdir -p "$dir" 2>/dev/null || exit 0
# Facts about the hook PROCESS, not the payload: which env the harness handed us.
# Gathered before stdin so nothing but the writes follows the payload's arrival.
env_probe="$(env | grep -E '^(PROBE_|CLAUDE_CODE_|CLAUDE_|CODEX_)' | cut -d= -f1 | sort | tr '\n' ',' | sed 's/,$//')"
payload="$(cat 2>/dev/null || true)"

# The run name is normally an argument. When the driver could not know it at wiring
# time it leaves a cursor file; the env fallback covers a harness that inherits env.
if [ -z "$run" ] && [ -f "$out/.run" ]; then run="$(cat "$out/.run" 2>/dev/null || true)"; fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Field presence by substring, not by jq: on the observe path (the one a harness may
# cut off at process exit) nothing slower than a shell builtin runs before the writes.
has_name=false; case "$payload" in *'"hook_event_name"'*) has_name=true ;; esac
has_sid=false;  case "$payload" in *'"session_id"'*)      has_sid=true  ;; esac

reply=""; rc=0
case "$mode" in
  allow)
    case "$event" in
      PreToolUse)        reply="$(jq -nc --arg e "$event" '{hookSpecificOutput:{hookEventName:$e,permissionDecision:"allow",permissionDecisionReason:"PROBE_ALLOW"}}')" ;;
      PermissionRequest) reply="$(jq -nc --arg e "$event" '{hookSpecificOutput:{hookEventName:$e,decision:{behavior:"allow"}}}')" ;;
    esac ;;
  deny)
    case "$event" in
      PreToolUse)        reply="$(jq -nc --arg e "$event" '{hookSpecificOutput:{hookEventName:$e,permissionDecision:"deny",permissionDecisionReason:"PROBE_DENY"}}')" ;;
      PermissionRequest) reply="$(jq -nc --arg e "$event" '{hookSpecificOutput:{hookEventName:$e,decision:{behavior:"deny",message:"PROBE_DENY"}}}')" ;;
      Stop|SubagentStop|UserPromptSubmit|PostToolUse)
                         # Once per (run, event): a Stop hook that blocked every stop would
                         # never let the session end, and a blocked prompt is blocked for good.
                         once="$dir/.deny.$run.$event"
                         if [ ! -f "$once" ]; then : > "$once"; reply="$(jq -nc '{decision:"block",reason:"PROBE_BLOCK"}')"; fi ;;
    esac ;;
  exit2)
    once="$dir/.exit2.$run.$event"
    if [ ! -f "$once" ]; then : > "$once"; rc=2; fi ;;
  systemMessage)
    reply="$(jq -nc --arg e "$event" '{systemMessage:("PROBE_SYSMSG " + $e)}')" ;;
  additionalContext)
    reply="$(jq -nc --arg e "$event" '{hookSpecificOutput:{hookEventName:$e,additionalContext:("PROBE_CTX " + $e + " — repeat this line verbatim in your reply")}}')" ;;
  elicit)
    case "$event" in
      Elicitation)       reply="$(jq -nc '{hookSpecificOutput:{hookEventName:"Elicitation",action:"accept",content:{answer:"PROBE_ELICIT"}}}')" ;;
      ElicitationResult) reply="$(jq -nc '{hookSpecificOutput:{hookEventName:"ElicitationResult",action:"accept",content:{answer:"PROBE_MODIFIED"}}}')" ;;
    esac ;;
  worktree)
    # WorktreeCreate REPLACES the harness's own git behavior: a hook that answers
    # nothing aborts the session ("hook succeeded but returned no worktree path"),
    # so this mode does the work and echoes the path; WorktreeRemove undoes it.
    local_cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)"
    case "$event" in
      WorktreeCreate)
        wt_name="$(printf '%s' "$payload" | jq -r '.name // "probe"' 2>/dev/null)"
        wt_path="$local_cwd/.probe-worktrees/$wt_name"
        mkdir -p "$local_cwd/.probe-worktrees" 2>/dev/null
        if git -C "$local_cwd" worktree add --detach "$wt_path" >/dev/null 2>&1; then reply="$wt_path"; fi ;;
      WorktreeRemove)
        wt_path="$(printf '%s' "$payload" | jq -r '.worktree_path // empty' 2>/dev/null)"
        [ -n "$wt_path" ] && git -C "$local_cwd" worktree remove --force "$wt_path" >/dev/null 2>&1 ;;
    esac ;;
esac

# The record: every value but the reply and the payload is a token this script or the
# driver chose (no quotes, no backslashes), so it is printed directly. The payload is
# one line of JSON as the harness sent it, so backslash and double quote are the only
# characters its JSON-string copy needs escaped — sed, not jq, keeps the observe path
# (the one a harness may cut off at process exit) under a few milliseconds. The reply
# is escaped the same way; a stray newline in either is folded so the record stays one line.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '; }
printf '{"ts":"%s","run":"%s","mode":"%s","tag":"%s","reply":"%s","exit":%s,"env":"%s","pid":"%s","ppid":"%s","has_hook_event_name":"%s","has_session_id":"%s","payload":"%s"}\n' \
  "$ts" "$run" "$mode" "$tag" "$(esc "$reply")" "$rc" "$env_probe" "$$" "$PPID" "$has_name" "$has_sid" "$(esc "$payload")" >> "$dir/$event.meta.jsonl" 2>/dev/null
printf '%s\n' "$payload" >> "$dir/$event.jsonl"

if [ "$rc" = 2 ]; then printf 'probe exit2 %s\n' "$event" >&2; exit 2; fi
if [ -n "$reply" ]; then printf '%s\n' "$reply"; fi
exit 0
