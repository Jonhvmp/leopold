#!/usr/bin/env bash
# Leopold Stop hook: state-coupled autonomous continuity.
#
# When the main agent finishes a turn, this hook reads .leopold/state.json and
# PLAN.md in the project. If a Leopold run is active and work remains with no
# stop condition met, it blocks the stop and re-injects a compact "continue"
# instruction. Otherwise it allows the session to halt.
#
# Hook contract (Claude Code Stop): read JSON on stdin. To keep going, print
# {"decision":"block","reason":"..."} and exit 0. To allow stopping, exit 0 with
# no output. Failure mode is intentionally fail-open (allow stop): a broken hook
# must never trap a session in a loop.

input="$(cat 2>/dev/null || true)"

# jq is required to parse state safely; without it, allow the stop.
command -v jq >/dev/null 2>&1 || exit 0

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -z "${cwd:-}" ] && cwd="$PWD"
LEO="$cwd/.leopold"
STATE="$LEO/state.json"

# Not a Leopold run -> normal stop.
[ -f "$STATE" ] || exit 0

now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"

# Fail SAFE and LOUD on a broken state file. Malformed JSON, or a missing/non-numeric
# budget field, means the iteration budget cannot be trusted -- the run could loop
# forever on a silently-skipped budget. Stop the run and say why, rather than continue
# blindly or die in silence.
state_invalid() {
  printf '{"ts":"%s","event":"state_invalid","reason":"%s"}\n' "$now" "$1" >> "$LEO/events.jsonl" 2>/dev/null || true
  echo "Leopold: .leopold/state.json is invalid ($1) -- stopping the run (fail-safe). Fix the file or re-run /leopold-brief." >&2
  printf '{"active":false,"stopped_reason":"state_invalid"}\n' > "$STATE" 2>/dev/null || true
  exit 0
}
jq -e . "$STATE" >/dev/null 2>&1 || state_invalid "malformed JSON"

active="$(jq -r '.active // false' "$STATE" 2>/dev/null || echo false)"
[ "$active" = "true" ] || exit 0

# A present-but-non-numeric budget field is the real hole: it would make the
# `iter >= max` test below error out (and get swallowed), silently skipping the
# budget -> unbounded loop. So any present budget field must be an integer. Missing
# fields fall back to the safe defaults below (50 / 0 / 3), so the budget still holds.
for f in iteration max_iterations consecutive_failures max_failures; do
  v="$(jq -r --arg k "$f" '.[$k] // empty' "$STATE" 2>/dev/null)"
  if [ -n "$v" ] && ! printf '%s' "$v" | grep -qE '^[0-9]+$'; then
    state_invalid "non-numeric $f ($v)"
  fi
done

log_event() { printf '%s\n' "$1" >> "$LEO/events.jsonl" 2>/dev/null || true; }

allow_stop() {
  local r="$1" tmp
  tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
  jq --arg r "$r" '.active=false | .stopped_reason=$r' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
  log_event "{\"ts\":\"$now\",\"event\":\"stop\",\"reason\":\"$r\"}"
  # Safety hygiene: always clear the kill switch and per-session git opt-in tokens
  # so the next run re-locks git and does not halt immediately on a stale STOP.
  rm -f "$LEO/STOP" "$LEO/ALLOW_GIT" "$LEO/ALLOW_PUSH" "$LEO/ALLOW_PUBLISH" 2>/dev/null || true
  # on_finish policy (GUARDRAILS.md): archive the run logs on a clean finish.
  if [ "$r" = "plan_complete" ] && grep -qiE '^[[:space:]]*-?[[:space:]]*on_finish:[[:space:]]*archive' "$LEO/GUARDRAILS.md" 2>/dev/null; then
    arch="$LEO/runs/$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$arch" 2>/dev/null || true
    [ -f "$LEO/DECISIONS.md" ] && mv "$LEO/DECISIONS.md" "$arch/" 2>/dev/null || true
    [ -f "$LEO/events.jsonl" ] && mv "$LEO/events.jsonl" "$arch/" 2>/dev/null || true
    cp "$LEO/PLAN.md" "$arch/" 2>/dev/null || true
  fi
  exit 0
}

# Kill switch.
if [ -f "$LEO/STOP" ]; then allow_stop "kill_switch"; fi

iter="$(jq -r '.iteration // 0' "$STATE" 2>/dev/null || echo 0)"
max_iter="$(jq -r '.max_iterations // 50' "$STATE" 2>/dev/null || echo 50)"
fails="$(jq -r '.consecutive_failures // 0' "$STATE" 2>/dev/null || echo 0)"
max_fails="$(jq -r '.max_failures // 3' "$STATE" 2>/dev/null || echo 3)"

# Budgets and repeated failure.
if [ "$iter" -ge "$max_iter" ] 2>/dev/null; then allow_stop "iteration_budget"; fi
if [ "$fails" -ge "$max_fails" ] 2>/dev/null; then allow_stop "repeated_failure"; fi

# Context budget — the real money pit. A long run accumulates context every turn; on a
# big-context model it never auto-compacts, so each turn re-bills the whole (growing)
# transcript and any fork clones it (one report: a session ballooned to ~6MB over 681
# turns). Stop when the transcript passes max_context_mb (default 5) so it cannot silently
# balloon. The brief persists -> a fresh /leopold-run resumes from PLAN.md with clean context.
max_ctx_mb="$(jq -r '.max_context_mb // 5' "$STATE" 2>/dev/null || echo 5)"
case "$max_ctx_mb" in (*[!0-9]*|"") max_ctx_mb=5 ;; esac
ctx_mb=0
tpath="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
if [ -n "$tpath" ] && [ -f "$tpath" ]; then
  ctx_bytes="$(wc -c < "$tpath" 2>/dev/null || echo 0)"
  ctx_mb="$(awk "BEGIN{printf \"%.1f\", ${ctx_bytes:-0}/1048576}" 2>/dev/null || echo 0)"
  [ "$(( ${ctx_bytes:-0} / 1048576 ))" -ge "$max_ctx_mb" ] 2>/dev/null && allow_stop "context_budget"
fi

# Plan complete? (no unchecked checkboxes remain)
PLAN="$LEO/PLAN.md"
open_items="$(grep -cE '^[[:space:]]*- \[ \]' "$PLAN" 2>/dev/null || true)"
open_items="${open_items:-0}"
if [ "$open_items" -eq 0 ] 2>/dev/null; then allow_stop "plan_complete"; fi

# Loop detection: if the SET of open plan items is byte-identical for N consecutive
# turns, the run is thrashing without progress (no item checked off, no item added) ->
# stop and report rather than burn the whole iteration budget hammering one spot.
max_np="$(jq -r '.max_no_progress // 6' "$STATE" 2>/dev/null || echo 6)"
case "$max_np" in (*[!0-9]*|"") max_np=6 ;; esac
sig="$(grep -E '^[[:space:]]*- \[ \]' "$PLAN" 2>/dev/null | cksum | awk '{print $1}')"
last_sig="$(jq -r '.progress_sig // empty' "$STATE" 2>/dev/null || true)"
np="$(jq -r '.no_progress // 0' "$STATE" 2>/dev/null || echo 0)"
case "$np" in (*[!0-9]*|"") np=0 ;; esac
if [ "$sig" = "$last_sig" ] && [ -n "$last_sig" ]; then np=$((np + 1)); else np=0; fi
if [ "$np" -ge "$max_np" ] 2>/dev/null; then allow_stop "no_progress"; fi

# Otherwise: continue. Increment the iteration counter; persist the progress signature.
next=$((iter + 1))
tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
jq --argjson n "$next" --arg t "$now" --argjson np "$np" --arg sig "$sig" --argjson cm "${ctx_mb:-0}" \
   '.iteration=$n | .last_turn=$t | .no_progress=$np | .progress_sig=$sig | .context_mb=$cm' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
log_event "{\"ts\":\"$now\",\"event\":\"turn_start\",\"iteration\":$next,\"open_items\":$open_items,\"no_progress\":$np}"

reason="Leopold autonomous mode is ACTIVE (turn $next/$max_iter, $open_items open plan items). Do not stop. Steps: (1) Read .leopold/PLAN.md and pick the next unchecked item. (2) Complete it; reach for the gstack playbook skill that fits the situation. (3) On any fork, apply .leopold/CHARTER.md and the decision protocol: if the call is reversible OR the charter is clear, decide it yourself, append the decision to .leopold/DECISIONS.md, and keep going; stop only for an irreversible AND ambiguous fork, a charter contradiction, or a mission-premise change. (4) Mark the finished item as done ([x]) in PLAN.md. Hard rules: git commit/push/publish stay locked; never edit files outside this project; never touch .leopold/GUARDRAILS.md or the hooks. When the plan is complete or a stop condition is met, write a short final summary and then stop."

jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
