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

out="$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"rm -rf build"}}' "$T" | bash "$HOOKS/guard-irreversible.sh")"
assert "guard denies rm -rf" "deny" "$(perm "$out")"

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

echo
if [ "$fail" -eq 0 ]; then echo "all hook behavior tests passed"; else echo "HOOK TESTS FAILED"; exit 1; fi
