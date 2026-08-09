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

# --- Repeated failure: ONE persona-led change of approach, then the run stops ---
# A budget stops the run; running out of ideas is a decision. The ceiling buys exactly one
# differently-framed attempt (mirrors packages/driver/src/rescue.ts), never a bigger
# max_failures. Reaching the ceiling a second time stops with repeated_failure as always.
rm -f "$T/.leopold/events.jsonl"
echo '{"active":true,"iteration":1,"max_iterations":50,"consecutive_failures":3,"max_failures":3}' > "$T/.leopold/state.json"
printf '# Plan\n- [ ] stuck item\n' > "$T/.leopold/PLAN.md"
out="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh")"
assert "the failure ceiling buys one more attempt instead of stopping" "block" "$(dec "$out")"
assert "that attempt is told to take a different approach under a synthesized role" "1" \
  "$(printf '%s' "$out" | jq -r '.reason' 2>/dev/null | grep -c 'LAST ATTEMPT ON THIS ITEM')"
assert "the rescued attempt must write the call to DECISIONS.md" "1" \
  "$(printf '%s' "$out" | jq -r '.reason' 2>/dev/null | grep -c 'DECISIONS.md')"
assert "the failure ceiling itself is NOT raised" "3" "$(jq -r '.max_failures' "$T/.leopold/state.json" 2>/dev/null)"
assert "the run is not stopped by the rescue" "" "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"
assert "the rescue is marked spent for the run" "true" "$(jq -r '.failure_rescue_used // false' "$T/.leopold/state.json" 2>/dev/null)"
assert "the rescue is on the event stream" "1|3" \
  "$(jq -r 'select(.event=="failure_rescue") | "\(.extra_attempts)|\(.max_failures)"' "$T/.leopold/events.jsonl" 2>/dev/null | tail -1)"

# The rescued attempt FAILED: the agent left consecutive_failures at the ceiling, which is
# what a failure looks like on this engine. Now the run stops.
out="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh")"
assert "the rescued attempt failing too stops the run" "repeated_failure" \
  "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"
assert "and it stops for real (no re-injection)" "" "$out"

# ...and the other half of that fork, which nothing used to assert. A rescued attempt that
# SUCCEEDS resets consecutive_failures (skills/leopold-run/SKILL.md tells the agent to, the
# driver does it in loop.ts) and the run must carry on. Without the reset the counter is
# stuck at the ceiling forever, so the last chance the hook just bought would be spent on a
# turn whose success the very next turn throws away — and the test above passes either way,
# because "nothing changed" and "it worked" look identical when nobody resets the counter.
rm -f "$T/.leopold/events.jsonl"
echo '{"active":true,"iteration":1,"max_iterations":50,"consecutive_failures":0,"max_failures":3,"failure_rescue_used":true}' > "$T/.leopold/state.json"
printf '# Plan\n- [x] stuck item\n- [ ] later work\n' > "$T/.leopold/PLAN.md"
out="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh")"
assert "a rescued attempt that SUCCEEDS lets the run continue" "block" "$(dec "$out")"
assert "a succeeded rescue does not stop the run" "" \
  "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"
assert "and it is not framed as a last attempt any more" "0" \
  "$(printf '%s' "$out" | jq -r '.reason' 2>/dev/null | grep -c 'LAST ATTEMPT ON THIS ITEM')"

# The rescue is DECIDED at the ceiling but SPENT only when the turn actually happens. Four
# more stop conditions come after that decision; if one fires, the rescue must survive
# unspent and no `failure_rescue` event may claim an attempt that never ran.
rm -f "$T/.leopold/events.jsonl"
echo '{"active":true,"iteration":1,"max_iterations":50,"consecutive_failures":3,"max_failures":3,"max_context_mb":1}' > "$T/.leopold/state.json"
printf '# Plan\n- [ ] stuck item\n' > "$T/.leopold/PLAN.md"
big="$T/big-transcript.jsonl"; head -c 1300000 /dev/zero | tr '\0' 'x' > "$big"
out="$(printf '{"cwd":"%s","transcript_path":"%s"}' "$T" "$big" | bash "$HOOKS/stop-continuity.sh")"
assert "a context budget on the same turn still stops the run" "context_budget" \
  "$(jq -r '.stopped_reason // ""' "$T/.leopold/state.json" 2>/dev/null)"
assert "...and the rescue is NOT burned by a turn that never ran" "false" \
  "$(jq -r '.failure_rescue_used // false' "$T/.leopold/state.json" 2>/dev/null)"
assert "...and no failure_rescue event claims an attempt that never happened" "0" \
  "$(grep -c '"event":"failure_rescue"' "$T/.leopold/events.jsonl" 2>/dev/null | head -1)"
rm -f "$big"

# A run below the ceiling is untouched: no rescue, no change-of-approach framing.
echo '{"active":true,"iteration":1,"max_iterations":50,"consecutive_failures":2,"max_failures":3}' > "$T/.leopold/state.json"
out="$(printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh")"
assert "below the ceiling nothing changes" "block" "$(dec "$out")"
assert "below the ceiling no rescue framing is injected" "0" \
  "$(printf '%s' "$out" | jq -r '.reason' 2>/dev/null | grep -c 'LAST ATTEMPT ON THIS ITEM')"
assert "below the ceiling the rescue is still unspent" "false" \
  "$(jq -r '.failure_rescue_used // false' "$T/.leopold/state.json" 2>/dev/null)"

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

# --- Node kinds: a @human node is EXECUTED under a synthesized role ---
# The plan asked a person to decide; under the default posture (`autonomy: full`) no
# person is coming, so the run synthesizes the role that decision needs, takes it, and
# keeps going. The driver does exactly that (packages/driver/src/loop.ts + persona.ts) and
# the in-session engine must resolve the same node the same way — under `autonomy: ask`
# BOTH stop with `awaiting_human` instead. (packages/driver/test/hook-kinds.test.ts parses
# the same plans with both parsers under both postures and fails on any drift; these are
# the behavior assertions.)
HUMAN_OUT=""; HUMAN_RESULT=""
# Echoes AND records "<decision>/<stopped_reason>": call it in `$( )` for a one-line
# assertion, or plainly and read $HUMAN_RESULT / $HUMAN_OUT when the re-injected reason
# itself is what is under test (a command substitution runs in a subshell, so the globals
# would not survive one).
human_run() { # $1 = plan text, $2 = LEOPOLD_AUTONOMY value ("" = unset)
  printf '%s' "$1" > "$T/.leopold/PLAN.md"
  echo '{"active":true,"iteration":1,"max_iterations":50}' > "$T/.leopold/state.json"
  local d
  # LEOPOLD_AUTONOMY is always passed explicitly, so an ambient one cannot flip the suite.
  HUMAN_OUT="$(printf '{"cwd":"%s"}' "$T" | LEOPOLD_AUTONOMY="${2-}" bash "$HOOKS/stop-continuity.sh" 2>/dev/null)"
  d="$(dec "$HUMAN_OUT")"; [ -n "$d" ] || d="allow"   # no stdout = the hook allowed the stop
  HUMAN_RESULT="$d/$(jq -r '.stopped_reason // "-"' "$T/.leopold/state.json" 2>/dev/null)"
  printf '%s' "$HUMAN_RESULT"
}
HUMAN_PLAN='# Plan
- [x] shipped
- [ ] @human Ask the team about pricing
- [ ] later work
'

rm -f "$T/.leopold/GUARDRAILS.md" "$T/.leopold/events.jsonl"
human_run "$HUMAN_PLAN" >/dev/null
assert "autonomy full: a @human item no longer ends the turn" "block/-" "$HUMAN_RESULT"
assert "... the turn is told to synthesize the role and take it" "1" \
  "$(printf '%s' "$HUMAN_OUT" | jq -r '.reason' 2>/dev/null | grep -c 'THIS ITEM IS A @human NODE (plan item 2: Ask the team about pricing)')"
assert "... and to record the call with a Reversal" "1" \
  "$(printf '%s' "$HUMAN_OUT" | jq -r '.reason' 2>/dev/null | grep -c 'DECISIONS.md.*Reversal')"
assert "... the trust boundary is restated, not moved" "1" \
  "$(printf '%s' "$HUMAN_OUT" | jq -r '.reason' 2>/dev/null | grep -c 'you do not ship')"
assert "... the run records the persona fork, not awaiting_human" "human|2|Ask the team about pricing" \
  "$(jq -r 'select(.event=="persona") | "\(.fork)|\(.item)|\(.text)"' "$T/.leopold/events.jsonl" 2>/dev/null | tail -1)"
assert "... and nothing is awaiting a human" "0" \
  "$(grep -c '"event":"awaiting_human"' "$T/.leopold/events.jsonl" 2>/dev/null || true)"

# `autonomy: ask` in GUARDRAILS.md restores the halt, byte for byte.
printf '# Guardrails\n- autonomy: ask   # a person decides @human nodes\n' > "$T/.leopold/GUARDRAILS.md"
rm -f "$T/.leopold/events.jsonl"
assert "autonomy ask: a @human item ends the turn with awaiting_human" "allow/awaiting_human" \
  "$(human_run "$HUMAN_PLAN")"
assert "... names the item in the run log" "2|Ask the team about pricing" \
  "$(jq -r 'select(.event=="awaiting_human") | "\(.item)|\(.text)"' "$T/.leopold/events.jsonl" 2>/dev/null | tail -1)"
printf '# Guardrails\n- autonomy: whatever\n' > "$T/.leopold/GUARDRAILS.md"
assert "an autonomy value neither engine knows falls back to full" "block/-" "$(human_run "$HUMAN_PLAN")"
rm -f "$T/.leopold/GUARDRAILS.md"

# The other place the posture can come from, and its precedence — env beats GUARDRAILS,
# matching resolveAutonomy() in packages/driver/src/config.ts.
assert "LEOPOLD_AUTONOMY=ask restores the halt" "allow/awaiting_human" "$(human_run "$HUMAN_PLAN" ask)"
printf '# Guardrails\n- autonomy: ask\n' > "$T/.leopold/GUARDRAILS.md"
assert "an explicit LEOPOLD_AUTONOMY=full beats GUARDRAILS" "block/-" "$(human_run "$HUMAN_PLAN" full)"
rm -f "$T/.leopold/GUARDRAILS.md"

assert "a @node human marker line resolves the same way" "block/-" \
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
# The persona record is ONE per node, not one per turn. This branch is re-entered every
# turn the @human item stays open, so a node taking five turns wrote five identical
# `persona` events -- and leopold-watch.py renders `persona` as sev-high, so the Canvas
# showed five high-severity entries for a single decision. The driver logs it once, inside
# processItem; the two engines must say the same thing.
rm -f "$T/.leopold/events.jsonl"
echo '{"active":true,"iteration":1,"max_iterations":50,"consecutive_failures":0,"max_failures":3}' > "$T/.leopold/state.json"
printf '# Plan\n- [ ] @human Approve the cutover\n- [ ] later work\n' > "$T/.leopold/PLAN.md"
for _ in 1 2 3 4 5; do printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh" >/dev/null 2>&1; done
assert "five turns on one @human node write ONE persona record" "1" \
  "$(grep -c '"event":"persona"' "$T/.leopold/events.jsonl" 2>/dev/null | head -1)"
printf '# Plan\n- [x] @human Approve the cutover\n- [ ] @human Approve the rollback\n' > "$T/.leopold/PLAN.md"
printf '{"cwd":"%s"}' "$T" | bash "$HOOKS/stop-continuity.sh" >/dev/null 2>&1
assert "...and a DIFFERENT @human node gets its own" "2" \
  "$(grep -c '"event":"persona"' "$T/.leopold/events.jsonl" 2>/dev/null | head -1)"

assert "a plan with no kinds is unchanged" "block/-" \
  "$(human_run '# Plan
- [ ] plain item
- [ ] (after: 1) another
')"

echo
if [ "$fail" -eq 0 ]; then echo "all hook behavior tests passed"; else echo "HOOK TESTS FAILED"; exit 1; fi
