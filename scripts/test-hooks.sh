#!/usr/bin/env bash
# Behavior tests for the Leopold hooks. Exits non-zero on any failure.
# Requires jq. Run via `make hooks-test` or directly.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS="$ROOT/hooks"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/.leopold"
fail=0

assert() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "  ok: $1"
  else
    echo "  FAIL: $1 (expected '$2', got '$3')"; fail=1
  fi
}
dec() { printf '%s' "$1" | jq -r '.decision // "none"' 2>/dev/null || echo none; }
perm() { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo allow; }

# --- Stop hook ---
echo '{"active":true,"iteration":1,"max_iterations":50}' > "$T/.leopold/state.json"
printf '# Plan\n- [ ] open item\n' > "$T/.leopold/PLAN.md"
out="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh")"
assert "stop hook continues when work remains" "block" "$(dec "$out")"

echo '{"active":true,"iteration":1}' > "$T/.leopold/state.json"
printf '# Plan\n- [x] done\n' > "$T/.leopold/PLAN.md"
out="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh")"
assert "stop hook halts when plan complete" "" "$out"

echo '{"active":false}' > "$T/.leopold/state.json"
out="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh")"
assert "stop hook inert when run inactive" "" "$out"

# --- Guard hook ---
echo '{"active":true}' > "$T/.leopold/state.json"
out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard denies git commit (no token)" "deny" "$(perm "$out")"

touch "$T/.leopold/ALLOW_GIT"
out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard allows commit with ALLOW_GIT" "" "$out"
rm -f "$T/.leopold/ALLOW_GIT"

out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git add -A"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard allows git add" "" "$out"

out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard denies git push" "deny" "$(perm "$out")"

out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard denies force-push" "deny" "$(perm "$out")"

out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"rm -rf build"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard allows rm -rf (only git is locked)" "" "$out"

out="$(printf '{"cwd":"%s","tool_name":"Task","tool_input":{"description":"x"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard allows subagents (no cap)" "" "$out"

echo '{"active":false}' > "$T/.leopold/state.json"
out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard inert when run inactive" "" "$out"

# --- Token hygiene on stop ---
echo '{"active":true,"iteration":1}' > "$T/.leopold/state.json"
printf '# Plan\n- [x] done\n' > "$T/.leopold/PLAN.md"
touch "$T/.leopold/ALLOW_GIT" "$T/.leopold/STOP"
printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh" >/dev/null 2>&1
assert "stop clears ALLOW_GIT token" "cleared" "$([ -f "$T/.leopold/ALLOW_GIT" ] && echo present || echo cleared)"
assert "stop clears STOP file" "cleared" "$([ -f "$T/.leopold/STOP" ] && echo present || echo cleared)"

# --- Loop detection (no progress for N turns) ---
echo '{"active":true,"iteration":0,"max_iterations":50,"max_no_progress":2}' > "$T/.leopold/state.json"
printf '# Plan\n- [ ] stuck item\n' > "$T/.leopold/PLAN.md"
for _ in 1 2 3; do printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh" >/dev/null 2>&1; done
assert "stop hook halts on a no-progress loop" "no_progress" "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"

# --- State validation: fail safe + loud ---
echo '{"active":true,"iteration":"abc","max_iterations":50}' > "$T/.leopold/state.json"
printf '# Plan\n- [ ] x\n' > "$T/.leopold/PLAN.md"
printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh" >/dev/null 2>&1
assert "non-numeric budget field stops the run" "state_invalid" "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"

printf 'not json {' > "$T/.leopold/state.json"
printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh" >/dev/null 2>&1
assert "malformed state.json stops the run" "state_invalid" "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"

# --- Context budget (transcript over max_context_mb) ---
echo '{"active":true,"iteration":1,"max_context_mb":1}' > "$T/.leopold/state.json"
printf '# Plan\n- [ ] open\n' > "$T/.leopold/PLAN.md"
head -c 1200000 /dev/zero | tr '\0' a > "$T/transcript.jsonl"
printf '{"cwd":"%s","transcript_path":"%s/transcript.jsonl"}' "$T" "$T" | bash "$HOOKS/stop-continuity.sh" >/dev/null 2>&1
assert "context budget stops the run" "context_budget" "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"

# --- Node kinds: a @human node ends the turn and asks ---
# The driver stops a run with `awaiting_human` when it reaches a human node; the
# in-session engine does the same, so a plan means the same thing on both engines.
# (packages/driver/test/hook-kinds.test.ts parses the same plans with both parsers and
# fails on any drift; these are the behavior assertions.)
human_run() { # $1 = plan text -> echoes "<decision>/<stopped_reason>"
  printf '%s' "$1" > "$T/.leopold/PLAN.md"
  echo '{"active":true,"iteration":1,"max_iterations":50}' > "$T/.leopold/state.json"
  local o d
  o="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh" 2>/dev/null)"
  d="$(dec "$o")"; [ -n "$d" ] || d="allow"   # no stdout = the hook allowed the stop
  printf '%s/%s' "$d" "$(jq -r '.stopped_reason // "-"' "$T/.leopold/state.json" 2>/dev/null)"
}

assert "a @human item ends the turn with awaiting_human" "allow/awaiting_human" \
  "$(human_run '# Plan
- [x] shipped
- [ ] @human Ask the team about pricing
- [ ] later work
')"
assert "... names the item in the run log" "2|Ask the team about pricing" \
  "$(jq -r 'select(.event=="awaiting_human") | "\(.item)|\(.text)"' "$T/.leopold/events.jsonl" 2>/dev/null | tail -1)"
assert "a @node human marker line stops too" "allow/awaiting_human" \
  "$(human_run '# Plan
- [ ] Migrate the database
      @node human ops
')"
assert "a done @human item is not the node we are at" "block/-" \
  "$(human_run '# Plan
- [x] @human already answered
- [ ] ordinary work
')"
assert "@gate keeps the run going" "block/-" \
  "$(human_run '# Plan
- [ ] @gate security Review the auth diff
')"
assert "@needs human is a need, not a node kind" "block/-" \
  "$(human_run '# Plan
- [ ] Ship the thing
      @needs human
')"
assert "a plan with no kinds is unchanged" "block/-" \
  "$(human_run '# Plan
- [ ] plain item
- [ ] (after: 1) another
')"

echo
if [ "$fail" -eq 0 ]; then echo "all hook behavior tests passed"; else echo "HOOK TESTS FAILED"; exit 1; fi
