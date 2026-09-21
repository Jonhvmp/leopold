#!/usr/bin/env bash
# Behavior tests for the hook-event probe's dump hook (scripts/probe/dump-hook.sh) and
# the render step (scripts/probe/render-hook-events.py).
#
# The live probe (scripts/probe-hook-events.sh) costs real model calls and is never part
# of `make test`; what CAN be pinned hermetically is the contract the reference page
# relies on: the hook files a payload under the event named by its ARGUMENT (a payload
# without hook_event_name still lands in the right file), appends the bytes verbatim,
# answers each reply mode in the harness's documented shape, blocks only once per run
# on the Stop family, never breaks the session it observes, and the renderer writes one
# section per matrix event with no blank row.
#
# HERMETIC: every path is inside a temp dir; no harness is launched.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP="$ROOT/scripts/probe/dump-hook.sh"
RENDER="$ROOT/scripts/probe/render-hook-events.py"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
OUT="$TD/out"

echo "dump-hook.sh — filing"

# --- 1. the event name is the ARGUMENT: a payload without hook_event_name still files right
printf '{"session_id":"s1","tool_name":"Bash"}' | bash "$DUMP" PreToolUse --out "$OUT" --harness claude --run r1 >/dev/null; rc=$?
check "exit 0 in observe mode" "$rc" "0"
check "filed under the argument name, not the payload" "$( [ -f "$OUT/claude/PreToolUse.jsonl" ] && echo yes || echo no )" "yes"
check "meta records hook_event_name absent" "$(jq -r '.has_hook_event_name' "$OUT/claude/PreToolUse.meta.jsonl")" "false"
check "meta records session_id present"     "$(jq -r '.has_session_id' "$OUT/claude/PreToolUse.meta.jsonl")" "true"
check "meta carries the run name"           "$(jq -r '.run' "$OUT/claude/PreToolUse.meta.jsonl")" "r1"
# When the payload DOES name an event, the argument still decides the file: the doc's
# claim is that the harness's name is recorded, never trusted for filing.
printf '{"hook_event_name":"PreToolUse","session_id":"s1"}' | bash "$DUMP" PostToolUse --out "$OUT" --harness claude --run r1 >/dev/null
check "the argument wins over the payload's hook_event_name" "$( [ -f "$OUT/claude/PostToolUse.jsonl" ] && echo yes || echo no )" "yes"
check "and nothing extra lands under the payload's name" "$(wc -l < "$OUT/claude/PreToolUse.jsonl" | tr -d ' ')" "1"

# --- 2. verbatim: the bytes in the file are the bytes on stdin (unicode, nested, spacing)
raw='{"hook_event_name":"Stop","session_id":"s2","last_assistant_message":"héllo — \"quoted\"  spaced","nested":{"a":[1,2,{"b":null}]}}'
printf '%s' "$raw" | bash "$DUMP" Stop --out "$OUT" --harness codex --run r1 >/dev/null
check "payload appended verbatim" "$(cat "$OUT/codex/Stop.jsonl")" "$raw"
check "the record carries the same payload, byte for byte" "$(jq -r '.payload' "$OUT/codex/Stop.meta.jsonl")" "$raw"
check "the record is one line of valid JSON" "$(jq -c 'has("payload") and has("run")' "$OUT/codex/Stop.meta.jsonl")" "true"
printf '%s' "$raw" | bash "$DUMP" Stop --out "$OUT" --harness codex --run r1 >/dev/null
check "second firing appends a second line" "$(wc -l < "$OUT/codex/Stop.jsonl" | tr -d ' ')" "2"
check "each firing gets one meta line"      "$(wc -l < "$OUT/codex/Stop.meta.jsonl" | tr -d ' ')" "2"

# --- 3. env facts: the argument wins over PROBE_* env, and env is a fallback
printf '{}' | PROBE_OUT="$TD/envout" PROBE_HARNESS=envh PROBE_RUN=envrun bash "$DUMP" SessionStart >/dev/null
check "PROBE_OUT/PROBE_HARNESS env fallback works" "$( [ -f "$TD/envout/envh/SessionStart.jsonl" ] && echo yes || echo no )" "yes"
check "PROBE_RUN env fallback recorded" "$(jq -r '.run' "$TD/envout/envh/SessionStart.meta.jsonl")" "envrun"
printf '{}' | PROBE_OUT="$TD/envout" PROBE_HARNESS=envh bash "$DUMP" SessionStart --harness argh >/dev/null
check "--harness argument wins over env" "$( [ -f "$TD/envout/argh/SessionStart.jsonl" ] && echo yes || echo no )" "yes"
printf '{}' | bash "$DUMP" SessionStart >/dev/null; rc=$?
check "no --out and no PROBE_OUT: silent exit 0 (never breaks the session)" "$rc" "0"

echo
echo "dump-hook.sh — reply modes"

reply() { printf '%s' "$2" | bash "$DUMP" "$1" --out "$OUT" --harness claude --run "${4:-modes}" --mode "$3"; }
check "allow on PreToolUse" "$(reply PreToolUse '{}' allow | jq -r '.hookSpecificOutput.permissionDecision')" "allow"
check "allow on PermissionRequest" "$(reply PermissionRequest '{}' allow | jq -r '.hookSpecificOutput.decision.behavior')" "allow"
check "deny on PreToolUse" "$(reply PreToolUse '{}' deny | jq -r '.hookSpecificOutput.permissionDecision')" "deny"
check "deny names the event in hookEventName" "$(reply PreToolUse '{}' deny | jq -r '.hookSpecificOutput.hookEventName')" "PreToolUse"
check "deny on PermissionRequest carries a message" "$(reply PermissionRequest '{}' deny | jq -r '.hookSpecificOutput.decision.message')" "PROBE_DENY"
check "allow on an event with no allow shape is silent" "$(reply Stop '{}' allow | wc -c | tr -d ' ')" "0"
check "systemMessage shape" "$(reply PostToolUse '{}' systemMessage | jq -r '.systemMessage')" "PROBE_SYSMSG PostToolUse"
check "additionalContext shape" "$(reply SessionStart '{}' additionalContext | jq -r '.hookSpecificOutput.additionalContext' | cut -d' ' -f1-2)" "PROBE_CTX SessionStart"
check "elicit on Elicitation: accept + content" "$(reply Elicitation '{}' elicit | jq -c '.hookSpecificOutput | [.action, .content.answer]')" '["accept","PROBE_ELICIT"]'
check "elicit on another event is silent" "$(reply PreToolUse '{}' elicit | wc -c | tr -d ' ')" "0"

# --- 4. the Stop family blocks ONCE per (run, event): a hook that blocked every stop
#        would never let the session end
check "block on Stop, first firing"  "$(reply Stop '{}' deny once-a | jq -r '.decision')" "block"
check "block on Stop, second firing: silent" "$(reply Stop '{}' deny once-a | wc -c | tr -d ' ')" "0"
check "a different run blocks again" "$(reply Stop '{}' deny once-b | jq -r '.decision')" "block"
check "a different event in the same run blocks" "$(reply SubagentStop '{}' deny once-a | jq -r '.decision')" "block"
printf '{}' | bash "$DUMP" TaskCompleted --out "$OUT" --harness claude --run e2 --mode exit2 >/dev/null 2>"$TD/err"; rc=$?
check "exit2: exit code 2 on the first firing" "$rc" "2"
check "exit2: reason on stderr" "$(cat "$TD/err")" "probe exit2 TaskCompleted"
printf '{}' | bash "$DUMP" TaskCompleted --out "$OUT" --harness claude --run e2 --mode exit2 >/dev/null 2>/dev/null; rc=$?
check "exit2: exit 0 on the second firing of the same run" "$rc" "0"
check "exit2 firings are both filed" "$(wc -l < "$OUT/claude/TaskCompleted.jsonl" | tr -d ' ')" "2"
check "meta records the exit given" "$(jq -r '.exit' "$OUT/claude/TaskCompleted.meta.jsonl" | tr '\n' ',')" "2,0,"

# --- 5. worktree mode does the work the harness delegates and echoes the path
PR="$TD/proj"; mkdir -p "$PR"; ( cd "$PR" && git init -q . && printf 'x\n' > f && git add f && git -c user.name=t -c user.email=t@t commit -qm i )
wt="$(printf '{"cwd":"%s","name":"probe-wt","hook_event_name":"WorktreeCreate"}' "$PR" | bash "$DUMP" WorktreeCreate --out "$OUT" --harness claude --run wt --mode worktree)"
check "worktree mode echoes the created path" "$wt" "$PR/.probe-worktrees/probe-wt"
check "and the worktree exists" "$(git -C "$PR" worktree list | grep -c probe-wt)" "1"
printf '{"cwd":"%s","worktree_path":"%s","hook_event_name":"WorktreeRemove"}' "$PR" "$wt" | bash "$DUMP" WorktreeRemove --out "$OUT" --harness claude --run wt --mode worktree >/dev/null
check "worktree mode removes it on WorktreeRemove" "$(git -C "$PR" worktree list | grep -c probe-wt)" "0"

echo
echo "render-hook-events.py — one section per matrix event, never a blank row"

# A minimal capture: a manifest naming a two-event matrix per harness, one captured
# event per harness, one evidence line, one trigger for the missing events.
ROUT="$TD/render"; mkdir -p "$ROUT/claude" "$ROUT/codex"
cat > "$ROUT/manifest.json" <<'JSON'
{"probed_at":"2026-01-01T00:00:00Z","versions":{"claude":"9.9.9 (Claude Code)","codex":"codex-cli 9.9.9","jq":"jq-1","python":"Python 3","bash":"5","os":"Test"},
 "claude_model_alias":"haiku","temp_root":"/tmp/x",
 "events":{"claude":["SessionStart","Setup"],"codex":["SessionStart","Interrupt"]},
 "fingerprints":{"claude_before":"1","codex_before":"2","claude_after":"1","codex_after":"3"},
 "runs":[{"harness":"claude","name":"tools","rc":0,"seconds":3,"args":"claude -p","prompt":"p","note":""}],
 "triggers":{"claude":{"Setup":["claude -p --init"]},"codex":{"Interrupt":["SIGINT mid-turn"]}}}
JSON
BIG="$(head -c 700 /dev/zero | tr '\0' 'a')"
printf '{"session_id":"s","hook_event_name":"SessionStart","source":"startup","big":"%s"}\n' "$BIG" > "$ROUT/claude/SessionStart.jsonl"
printf '{"ts":"t","run":"tools","mode":"observe","has_hook_event_name":"true","has_session_id":"true","payload":"{\\"session_id\\":\\"s\\",\\"hook_event_name\\":\\"SessionStart\\",\\"source\\":\\"startup\\",\\"big\\":\\"%s\\"}"}\n' "$BIG" > "$ROUT/claude/SessionStart.meta.jsonl"
# A verbatim line whose record was lost (the hook killed between its two writes) must
# still be quoted, attributed to no run — never dropped.
printf '{"session_id":"s2","hook_event_name":"SessionStart","source":"resume"}\n' >> "$ROUT/claude/SessionStart.jsonl"
printf '{"session_id":"s","hook_event_name":"SessionStart","model":"m"}\n' > "$ROUT/codex/SessionStart.jsonl"
printf '{"ts":"t","run":"tools","mode":"observe","has_hook_event_name":"true","has_session_id":"false","payload":"{\\"session_id\\":\\"s\\",\\"hook_event_name\\":\\"SessionStart\\",\\"model\\":\\"m\\"}"}\n' > "$ROUT/codex/SessionStart.meta.jsonl"
printf '{"harness":"claude","event":"SessionStart","reply":"systemMessage","result":"honored","evidence":"seen","run":"tools"}\n' > "$ROUT/evidence.jsonl"
DOCS="$TD/docs/reference"; mkdir -p "$DOCS"; printf '0.0.0\n' > "$TD/VERSION"
python3 "$RENDER" "$ROUT" --docs "$DOCS" >/dev/null; rc=$?
check "renderer exits 0" "$rc" "0"
for f in hook-events.md hook-events.pt-BR.md; do
  check "$f: a section for every Claude event"  "$(grep -c '^### `\(SessionStart\|Setup\)` — Claude Code' "$DOCS/$f")" "2"
  check "$f: a section for every Codex event"   "$(grep -c '^### `\(SessionStart\|Interrupt\)` — Codex CLI' "$DOCS/$f")" "2"
  check "$f: a missing event names the trigger tried" "$(grep -c 'claude -p --init' "$DOCS/$f")" "1"
  check "$f: the version string is quoted from the manifest" "$( [ "$(grep -c '9.9.9 (Claude Code)' "$DOCS/$f")" -ge 3 ] && echo yes || echo no )" "yes"
  check "$f: the matrix has no blank fired cell" "$(grep -E '^\| `(SessionStart|Setup|Interrupt)` \| *\|' "$DOCS/$f" | wc -l | tr -d ' ')" "0"
  check "$f: session_id absence is stated"      "$(grep -c '`session_id`: absent' "$DOCS/$f")" "1"
  check "$f: a long value is elided with the byte count" "$(grep -c '…\[+220 chars\]' "$DOCS/$f")" "1"
  check "$f: the reply evidence is rendered"    "$(grep -c '`systemMessage` → \*\*\(honored\|honrada\)\*\*' "$DOCS/$f")" "1"
  check "$f: a changed fingerprint is not hidden" "$( [ "$(grep -c 'CHANGED\|MUDOU' "$DOCS/$f")" -ge 2 ] && echo yes || echo no )" "yes"
done
check "an unattributed verbatim line is still quoted (en)" "$(grep -c '"source":"resume"' "$DOCS/hook-events.md")" "1"
check "and counted as a firing (en)" "$(grep -c 'Fired 2 time(s)' "$DOCS/hook-events.md")" "1"
check "the codex fingerprint change is reported as changed (en)" "$(grep -c '`~/.codex` CHANGED' "$DOCS/hook-events.md")" "1"
check "the claude fingerprint is reported unchanged (en)"        "$(grep -c '`~/.claude` unchanged' "$DOCS/hook-events.md")" "1"
check "typed-by-hand versions never appear: the header quotes --version output" "$(grep -c '| Claude Code CLI (`claude --version`) | `9.9.9 (Claude Code)` |' "$DOCS/hook-events.md")" "1"

echo
if [ "$FAIL" = 0 ]; then echo "probe dump-hook + renderer: all $PASS checks passed"; exit 0; fi
echo "probe dump-hook + renderer: $FAIL of $((PASS+FAIL)) checks FAILED"; exit 1
