#!/usr/bin/env bash
# Behavior tests for the prompt enhancer (extensions/enhance/payload/enhance.py).
# Hermetic: CLAUDE_HOME points at a temp dir and `claude` is a local stub, so no
# network and no touching the real ~/.claude. Exits non-zero on any failure.
# Requires python3 + jq. Run via `make enhance-test` or directly.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$ROOT/extensions/enhance/payload/enhance.py"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export CLAUDE_HOME="$T/.claude"
ENH="$CLAUDE_HOME/enhance"
LEDGER="$ENH/enhancements.jsonl"
mkdir -p "$ENH/sessions" "$T/bin" "$T/proj"

# the outer session must not leak into the tests
unset LEOPOLD_ENHANCE_ACTIVE LEOPOLD_ENHANCE_DISABLE LEOPOLD_ENHANCE_DEBUG 2>/dev/null || true
unset LEOPOLD_ENHANCE_MIN_SCORE LEOPOLD_ENHANCE_MAX_WORDS LEOPOLD_ENHANCE_COOLDOWN_S 2>/dev/null || true

fail=0
assert() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "  ok: $1"
  else
    echo "  FAIL: $1 (expected '$2', got '$3')"; fail=1
  fi
}

# --- stubs standing in for the real `claude` binary --------------------------
cat > "$T/bin/stub-claude" <<STUB
#!/usr/bin/env bash
touch "$T/stub-called"
cat > "$T/stub-stdin"
printf 'Objective: fix the login flow\nContext: test\nConstraints: none\nDone when: login works\nAssumptions: none\n'
STUB
cat > "$T/bin/stub-claude-fail" <<STUB
#!/usr/bin/env bash
cat >/dev/null
exit 1
STUB
cat > "$T/bin/stub-claude-hang" <<STUB
#!/usr/bin/env bash
cat >/dev/null
sleep 5
STUB
chmod +x "$T/bin/"stub-claude*
export LEOPOLD_ENHANCE_CLAUDE_BIN="$T/bin/stub-claude"

enabled_state() { printf '{"enabled":true,"model":"haiku"}' > "$ENH/state.json"; }
hook() { # session_id prompt [cwd]
  printf '{"session_id":"%s","prompt_id":"p1","transcript_path":"","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":%s}' \
    "$1" "${3:-$T/proj}" "$(printf '%s' "$2" | jq -Rs .)" \
    | python3 "$ENGINE" --event user-prompt
}
ledger_lines() { [ -f "$LEDGER" ] && wc -l < "$LEDGER" | tr -d ' ' || echo 0; }

# --- gating: everything below must emit NOTHING and exit 0 -------------------
printf '{"enabled":false}' > "$ENH/state.json"
assert "disabled state emits nothing" "" "$(hook s-off 'fix login')"

rm -f "$ENH/state.json"
assert "missing state emits nothing" "" "$(hook s-nostate 'fix login')"

enabled_state
assert "kill switch emits nothing" "" "$(LEOPOLD_ENHANCE_DISABLE=1 hook s-kill 'fix login')"

rm -f "$T/stub-called"
assert "recursion guard emits nothing" "" "$(LEOPOLD_ENHANCE_ACTIVE=1 hook s-rec 'fix login')"
assert "recursion guard never spawns claude" "absent" "$([ -f "$T/stub-called" ] && echo called || echo absent)"

assert "slash command skipped" "" "$(hook s-slash '/leopold-status')"
assert "bash-mode prompt skipped" "" "$(hook s-bang '! ls -la')"
assert "ack 'ok' skipped" "" "$(hook s-ack1 'ok')"
assert "ack 'sim' skipped" "" "$(hook s-ack2 'sim')"
assert "numeric ack '2' skipped" "" "$(hook s-ack3 '2')"

mkdir -p "$T/proj-run/.leopold"
printf '{"active":true}' > "$T/proj-run/.leopold/state.json"
assert "active leopold run skipped" "" "$(hook s-run 'fix login' "$T/proj-run")"

assert "anchored prompt passes through (false-positive regression)" "" \
  "$(hook s-anchor 'fix the retry loop in src/api/client.ts')"
assert "pasted code fence passes through" "" \
  "$(hook s-fence "$(printf 'fix this\n```\nboom\n```')")"
assert "long detailed prompt passes through" "" \
  "$(hook s-long "$(yes 'word' | head -70 | tr '\n' ' ')")"

assert "no ledger lines from skipped prompts" "0" "$(ledger_lines)"

# --- the happy path -----------------------------------------------------------
rm -f "$T/stub-called"
out="$(hook s-weak 'fix login')"
case "$out" in
  *"[leopold-enhance"*) echo "  ok: weak prompt gets the enhance block" ;;
  *) echo "  FAIL: weak prompt gets the enhance block (got '$out')"; fail=1 ;;
esac
case "$out" in
  *"THE RAW PROMPT WINS"*) echo "  ok: injection carries the raw-prompt-wins rule" ;;
  *) echo "  FAIL: injection carries the raw-prompt-wins rule"; fail=1 ;;
esac
assert "happy path spawned claude" "called" "$([ -f "$T/stub-called" ] && echo called || echo absent)"
assert "ledger has exactly one line" "1" "$(ledger_lines)"
assert "ledger line is injected:true" "true" "$(tail -1 "$LEDGER" | jq -r '.injected')"
assert "ledger session id recorded" "s-weak" "$(tail -1 "$LEDGER" | jq -r '.session_id')"
assert "ledger score gated at threshold" "true" "$(tail -1 "$LEDGER" | jq -r '.score >= 4')"

# --- cooldown: same session immediately again ---------------------------------
assert "cooldown suppresses immediate repeat" "" "$(hook s-weak 'arruma o login')"
assert "cooldown adds no ledger line" "1" "$(ledger_lines)"

# --- /skill briefs: the ARGUMENT is gated, not the command ---------------------
out="$(hook s-brief1 '/leopold-brief adiciona microinteracoes no onboarding com boas tecnicas sem exagero')"
case "$out" in
  *"[leopold-enhance"*) echo "  ok: weak /skill brief gets the enhance block" ;;
  *) echo "  FAIL: weak /skill brief gets the enhance block (got '$out')"; fail=1 ;;
esac
case "$(cat "$T/stub-stdin")" in
  *"RAW PROMPT:"*"/leopold-brief"*) echo "  FAIL: command prefix must be stripped from the rewriter payload"; fail=1 ;;
  *"RAW PROMPT:"*"adiciona microinteracoes"*) echo "  ok: rewriter sees the bare argument (no /command anchor)" ;;
  *) echo "  FAIL: rewriter sees the bare argument"; fail=1 ;;
esac
assert "ledger marks the skill brief" "true" "$(tail -1 "$LEDGER" | jq -r '.skill_brief')"

out="$(hook s-brief2 '/leopold-enhance add microinteracoes no onboarding de forma gostosa sem exagero')"
case "$out" in
  *"[leopold-enhance"*) echo "  ok: task brief on the enhancer's own skill is enhanced (/leopold-enhance <task>)" ;;
  *) echo "  FAIL: task brief on the enhancer's own skill is enhanced (got '$out')"; fail=1 ;;
esac

assert "own control verbs stay skipped" "" \
  "$(hook s-ownverb '/leopold-enhance preview este texto fraco de teste aqui agora mesmo')"
assert "short skill args stay skipped" "" "$(hook s-shortargs '/model opus')"
assert "anchored skill args pass through" "" \
  "$(hook s-briefanchor '/leopold-brief fix the retry loop in src/api/client.ts please right now')"

# --- failure paths stay silent and fail open ----------------------------------
out="$(LEOPOLD_ENHANCE_CLAUDE_BIN="$T/bin/stub-claude-fail" hook s-fail 'melhora a busca')"
assert "rewriter failure emits nothing" "" "$out"
assert "rewriter failure logged as injected:false" "false" "$(tail -1 "$LEDGER" | jq -r '.injected')"
assert "rewriter failure records the error" "exit_1" "$(tail -1 "$LEDGER" | jq -r '.error')"

start="$(date +%s)"
out="$(LEOPOLD_ENHANCE_CLAUDE_BIN="$T/bin/stub-claude-hang" LEOPOLD_ENHANCE_TIMEOUT_S=1 hook s-hang 'conserta o build')"
took=$(( $(date +%s) - start ))
assert "hung rewriter emits nothing" "" "$out"
assert "hung rewriter logged as timeout" "timeout" "$(tail -1 "$LEDGER" | jq -r '.error')"
assert "timeout respected (took ${took}s)" "yes" "$([ "$took" -le 4 ] && echo yes || echo no)"

# --- self-heal: exit errors downgrade safe mode; timeouts never do --------------
enabled_state
LEOPOLD_ENHANCE_CLAUDE_BIN="$T/bin/stub-claude-hang" LEOPOLD_ENHANCE_TIMEOUT_S=1 hook s-heal1 'melhora o cache' >/dev/null
LEOPOLD_ENHANCE_CLAUDE_BIN="$T/bin/stub-claude-hang" LEOPOLD_ENHANCE_TIMEOUT_S=1 hook s-heal2 'melhora o deploy' >/dev/null
assert "timeouts never downgrade safe mode" "true" "$(jq -r '.safe_mode != false' "$ENH/state.json")"
LEOPOLD_ENHANCE_CLAUDE_BIN="$T/bin/stub-claude-fail" hook s-heal3 'melhora o setup' >/dev/null
LEOPOLD_ENHANCE_CLAUDE_BIN="$T/bin/stub-claude-fail" hook s-heal4 'melhora a doc' >/dev/null
assert "repeated exit errors downgrade safe mode" "false" "$(jq -r '.safe_mode' "$ENH/state.json")"

# --- charter awareness ---------------------------------------------------------
mkdir -p "$T/proj-charter/.leopold"
printf '{"active":false}' > "$T/proj-charter/.leopold/state.json"
printf '# Charter\nCHARTER_MARKER_XYZ: prefer boring technology\n' > "$T/proj-charter/.leopold/CHARTER.md"
hook s-charter 'fix login' "$T/proj-charter" >/dev/null
case "$(cat "$T/stub-stdin")" in
  *CHARTER_MARKER_XYZ*) echo "  ok: charter excerpt reaches the rewriter" ;;
  *) echo "  FAIL: charter excerpt reaches the rewriter"; fail=1 ;;
esac
case "$(cat "$T/stub-stdin")" in
  *"RAW PROMPT:"*"fix login"*) echo "  ok: raw prompt reaches the rewriter" ;;
  *) echo "  FAIL: raw prompt reaches the rewriter"; fail=1 ;;
esac
assert "charter usage recorded in ledger" "true" "$(tail -1 "$LEDGER" | jq -r '.charter_used')"

# --- toggle / status / preview (the control plane) ------------------------------
assert "toggle off" "enhance: off" "$(python3 "$ENGINE" --event toggle off)"
assert "status reports off" "off" "$(python3 "$ENGINE" --event status)"
assert "toggled-off hook emits nothing" "" "$(hook s-toggled 'fix login')"
out="$(python3 "$ENGINE" --event toggle on)"  # triggers a probe (stubbed claude answers)
case "$out" in
  "enhance: on"*) echo "  ok: toggle on" ;;
  *) echo "  FAIL: toggle on (got '$out')"; fail=1 ;;
esac
case "$(python3 "$ENGINE" --event status)" in
  "on ("*) echo "  ok: status reports on" ;;
  *) echo "  FAIL: status reports on"; fail=1 ;;
esac

out="$(python3 "$ENGINE" --event preview 'fix the retry loop in src/api/client.ts')"
case "$out" in
  *"PASS-THROUGH"*) echo "  ok: preview verdict for a strong prompt" ;;
  *) echo "  FAIL: preview verdict for a strong prompt (got '$out')"; fail=1 ;;
esac
before="$(ledger_lines)"
out="$(python3 "$ENGINE" --event preview 'fix login')"
case "$out" in
  *"ENHANCE"*"[leopold-enhance"*) echo "  ok: preview renders the would-be injection" ;;
  *) echo "  FAIL: preview renders the would-be injection (got '$out')"; fail=1 ;;
esac
assert "preview never writes the ledger" "$before" "$(ledger_lines)"

echo
if [ "$fail" -eq 0 ]; then echo "all enhance behavior tests passed"; else echo "ENHANCE TESTS FAILED"; exit 1; fi
