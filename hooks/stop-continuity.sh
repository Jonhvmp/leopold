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
active="$(jq -r '.active // false' "$STATE" 2>/dev/null || echo false)"
[ "$active" = "true" ] || exit 0

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

# Plan complete? (no unchecked checkboxes remain)
PLAN="$LEO/PLAN.md"
open_items="$(grep -cE '^[[:space:]]*- \[ \]' "$PLAN" 2>/dev/null || true)"
open_items="${open_items:-0}"
if [ "$open_items" -eq 0 ] 2>/dev/null; then allow_stop "plan_complete"; fi

# Otherwise: continue. Increment the iteration counter.
next=$((iter + 1))
tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
jq --argjson n "$next" --arg t "$now" '.iteration=$n | .last_turn=$t' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
log_event "{\"ts\":\"$now\",\"event\":\"turn_start\",\"iteration\":$next,\"open_items\":$open_items}"

reason="Leopold autonomous mode is ACTIVE (turn $next/$max_iter, $open_items open plan items). Do not stop. Steps: (1) Read .leopold/PLAN.md and pick the next unchecked item. (2) Complete it; reach for the gstack playbook skill that fits the situation. (3) On any fork, apply .leopold/CHARTER.md and the decision protocol: if the call is reversible OR the charter is clear, decide it yourself, append the decision to .leopold/DECISIONS.md, and keep going; stop only for an irreversible AND ambiguous fork, a charter contradiction, or a mission-premise change. (4) Mark the finished item as done ([x]) in PLAN.md. Hard rules: git commit/push/publish stay locked; never edit files outside this project; never touch .leopold/GUARDRAILS.md or the hooks. When the plan is complete or a stop condition is met, write a short final summary and then stop."

jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
