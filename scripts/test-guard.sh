#!/usr/bin/env bash
# Red-team suite for the Leopold PreToolUse guard (hooks/guard-irreversible.sh).
# Every bypass attempt is a test: feed a crafted tool call, assert deny / allow.
# Run: make test-guard   (or: bash scripts/test-guard.sh)
set -u

GUARD="$(cd "$(dirname "$0")/.." && pwd)/hooks/guard-irreversible.sh"
POLICY="$(cd "$(dirname "$0")/.." && pwd)/hooks/permission-policy.sh"
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/.leopold" "$TMP/src"
active() { echo "$1" > "$TMP/.leopold/state.json"; }
active '{"active":true,"iteration":1}'

pass=0; fail=0
run_bash() { jq -cn --arg c "$1" --arg cwd "$TMP" '{tool_name:"Bash",cwd:$cwd,tool_input:{command:$c}}' | bash "$GUARD" 2>/dev/null; }
run_edit() { jq -cn --arg p "$1" --arg cwd "$TMP" '{tool_name:"Edit",cwd:$cwd,tool_input:{file_path:$p}}' | bash "$GUARD" 2>/dev/null; }
is_deny()  { printf '%s' "$1" | grep -q '"permissionDecision":"deny"'; }

ck_deny()  { if is_deny "$2"; then pass=$((pass+1)); else fail=$((fail+1)); printf '  \033[31mFAIL\033[0m want DENY : %s\n' "$1"; fi; }
ck_allow() { if [ -z "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf '  \033[31mFAIL\033[0m want ALLOW: %s\n' "$1"; fi; }

echo "== must DENY (git commit / push only — incl. bypass attempts) =="
DENY=(
  'git commit -m x' 'git -c user.name=foo commit -m x' 'git -C /r commit -m x'
  'git --git-dir=/x commit' 'git -c a=b -c c=d commit'
  '/usr/bin/git commit -m x' 'env git commit -m x' 'git  -c  x=y   commit'
  'git push' 'git push origin main' 'git push --force' 'git push -f origin main' 'git -c x=y push'
)
for c in "${DENY[@]}"; do ck_deny "$c" "$(run_bash "$c")"; done

echo "== must ALLOW (everything that is not git commit/push) =="
ALLOW=(
  'rm -rf /x/scratch' 'rm file.txt' 'find . -delete' 'find . -exec rm {} +'
  'git reset --hard' 'git clean -fd' 'git branch -D feat'
  'gh pr create' 'gh release create v1' 'npm publish' 'cargo publish'
  'git status' 'git add -A' 'git log --oneline' 'git diff' 'ls -la' 'echo hi' 'mkdir build' 'git fetch'
)
for c in "${ALLOW[@]}"; do ck_allow "$c" "$(run_bash "$c")"; done

echo "== gated tokens / non-Bash tools / state =="
touch "$TMP/.leopold/ALLOW_GIT"
ck_allow 'git commit (ALLOW_GIT present)' "$(run_bash 'git commit -m ok')"
rm -f "$TMP/.leopold/ALLOW_GIT"
touch "$TMP/.leopold/ALLOW_PUSH"
ck_allow 'git push (ALLOW_PUSH present)' "$(run_bash 'git push origin main')"
ck_deny  'force-push denied even with ALLOW_PUSH' "$(run_bash 'git push --force')"
rm -f "$TMP/.leopold/ALLOW_PUSH"
ck_allow 'edits are never guarded'   "$(run_edit "$TMP/.leopold/GUARDRAILS.md")"
ck_allow 'edit a normal source file' "$(run_edit "$TMP/src/main.ts")"

active 'not valid json {'
ck_deny  'malformed state.json fails CLOSED (still blocks commit)' "$(run_bash 'git commit -m x')"
active '{"active":false}'
ck_allow 'inactive run does not guard' "$(run_bash 'git commit -m x')"

echo "== whitespace/tab evasion =="
active '{"active":true,"iteration":1}'
ck_deny  'tab-separated git -c commit' "$(run_bash "$(printf 'git\t-c\tx=y\tcommit')")"

echo "== the denial names the run that holds the lock (second window knows whose run it is) =="
reason() { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null; }
ck_has()  { if printf '%s' "$2" | grep -qF -- "$3"; then pass=$((pass+1)); else fail=$((fail+1)); printf '  \033[31mFAIL\033[0m want "%s" in: %s\n' "$3" "$1"; fi; }
ck_hasnt(){ if printf '%s' "$2" | grep -qF -- "$3"; then fail=$((fail+1)); printf '  \033[31mFAIL\033[0m did not want "%s" in: %s\n' "$3" "$1"; else pass=$((pass+1)); fi; }
active '{"active":true,"iteration":1,"owner":{"session_id":"AAAA-1111-owner","engine":"skill","harness":"claude"}}'
out="$(run_bash 'git commit -m x')"; ck_deny 'still denied with an owner' "$out"
ck_has  'commit denial names the owning session' "$(reason "$out")" 'conducted by session AAAA-111 (skill)'
ck_has  'push denial names the owning session'   "$(reason "$(run_bash 'git push')")" 'conducted by session AAAA-111'
ck_has  'force-push denial names it too'         "$(reason "$(run_bash 'git push --force')")" 'conducted by session AAAA-111'
active '{"active":true,"iteration":1,"session_id":"OLD-OWNER-legacy"}'
ck_has  'a legacy top-level session_id is named as the owner' "$(reason "$(run_bash 'git commit -m x')")" 'conducted by session OLD-OWNE'
active '{"active":true,"iteration":1,"orchestrator_pid":4242}'
ck_has  'a driver run is named as the owner' "$(reason "$(run_bash 'git commit -m x')")" 'conducted by leopold run (driver)'
active '{"active":true,"iteration":1}'
ck_hasnt 'no owner: the denial is byte-for-byte what it was' "$(reason "$(run_bash 'git commit -m x')")" 'conducted by'

echo "== the permission policy answers with the guard's verdict, command for command =="
# hooks/permission-policy.sh answers a PermissionRequest for the session conducting the
# run. Its ONE exception is the git lock, and it does not re-implement it: it hands the
# payload to guard-irreversible.sh and repeats the deny verbatim. So the red-team list
# above is the policy's list too — every DENY command must come back as a policy deny
# carrying THE GUARD'S OWN REASON, and every ALLOW command as a policy allow. A second
# copy of the git rules living in the policy would pass a "deny/allow" test while
# drifting on the reason; comparing the reason string is what makes the two one decision.
#
# MUTATION-VERIFIED: delete the guard call from hooks/permission-policy.sh (allow
# unconditionally) and the DENY block below fails 14 times; re-implement the git check
# locally with a reason of its own and the reason comparison fails.
active '{"active":true,"iteration":1,"owner":{"session_id":"S-OWNER","engine":"skill","harness":"claude"}}'
run_perm() { # <command> [session]
  jq -cn --arg c "$1" --arg cwd "$TMP" --arg s "${2:-S-OWNER}" \
    '{hook_event_name:"PermissionRequest",session_id:$s,cwd:$cwd,tool_name:"Bash",tool_input:{command:$c}}' \
    | bash "$POLICY" 2>/dev/null
}
# No output at all is the third answer: the harness prompts exactly as it does today.
p_behavior() { [ -n "$1" ] || { echo none; return; }; printf '%s' "$1" | jq -r '.hookSpecificOutput.decision.behavior // "none"' 2>/dev/null || echo none; }
p_message()  { printf '%s' "$1" | jq -r '.hookSpecificOutput.decision.message // ""' 2>/dev/null || true; }
ck_eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf '  \033[31mFAIL\033[0m %s: expected %s, got %s\n' "$1" "$2" "$3"; fi; }

for c in "${DENY[@]}"; do
  out="$(run_perm "$c")"
  ck_eq "policy denies: $c" "deny" "$(p_behavior "$out")"
  ck_eq "policy repeats the guard's reason: $c" "$(reason "$(run_bash "$c")")" "$(p_message "$out")"
done
for c in "${ALLOW[@]}"; do
  ck_eq "policy allows: $c" "allow" "$(p_behavior "$(run_perm "$c")")"
done

# The tokens are the guard's, honored identically because the guard is the one reading them.
touch "$TMP/.leopold/ALLOW_GIT"
ck_eq "policy allows git commit with ALLOW_GIT" "allow" "$(p_behavior "$(run_perm 'git commit -m ok')")"
rm -f "$TMP/.leopold/ALLOW_GIT"
touch "$TMP/.leopold/ALLOW_PUSH"
ck_eq "policy allows git push with ALLOW_PUSH"  "allow" "$(p_behavior "$(run_perm 'git push origin main')")"
ck_eq "policy still denies force-push with ALLOW_PUSH" "deny" "$(p_behavior "$(run_perm 'git push --force')")"
rm -f "$TMP/.leopold/ALLOW_PUSH"

# The reason a person reads is the git lock's, owner note included — not a paraphrase.
out="$(run_perm 'git commit -m x')"
ck_has  'the policy deny names the owning session' "$(p_message "$out")" 'conducted by session S-OWNER (skill)'
ck_has  'and names the escape token'               "$(p_message "$out")" 'touch .leopold/ALLOW_GIT'

# Scope: only the session conducting the run is answered, and only while it is active.
ck_eq "a foreign session gets today's prompt (no output)"  "none" "$(p_behavior "$(run_perm 'rm -rf build/' OTHER-SESSION)")"
ck_eq "...and is not answered for git either"              "none" "$(p_behavior "$(run_perm 'git commit -m x' OTHER-SESSION)")"
active '{"active":false}'
ck_eq "an inactive run is not answered"                    "none" "$(p_behavior "$(run_perm 'rm -rf build/')")"
active 'not valid json {'
ck_eq "unparseable state denies (a guard fails closed)"    "deny" "$(p_behavior "$(run_perm 'rm -rf build/')")"
ck_has "...and says why"                                   "$(p_message "$(run_perm 'rm -rf build/')")" 'does not parse'
rm -f "$TMP/.leopold/state.json"
ck_eq "no state.json at all: today's prompt"               "none" "$(p_behavior "$(run_perm 'rm -rf build/')")"

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mguard red-team: %d passed, 0 failed\033[0m\n' "$pass"
else
  printf '\033[31mguard red-team: %d passed, %d FAILED\033[0m\n' "$pass" "$fail"
fi
[ "$fail" -eq 0 ]
