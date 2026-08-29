#!/usr/bin/env bash
# Behavior tests for the enhance extension's harness port
# (extensions/enhance/install.sh + manage.sh + the engine's harness seam).
#
# HERMETIC. HOME points inside a temp dir — so ~/.claude and ~/.codex ARE the temp
# dirs — and PATH is rebuilt from scratch with stubs, so nothing here reaches the
# network or writes into the developer's real harness homes. A test that mutates
# your real ~/.codex is not a test.
#
# scripts/test-enhance.sh covers the engine's gate and rewriter behavior; this file
# covers the install/wiring/reporting layer and the one thing that genuinely differs
# between the harnesses — how an injected reading is handed back.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="$ROOT/extensions/enhance/install.sh"
MANAGE="$ROOT/extensions/enhance/manage.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then bad "$1"; else ok "$1"; fi; }

# Names only, same guard as the other hermetic suites: a live agent session writes
# into its own home while this runs, and what an escaped write looks like is a NEW
# entry (enhance/, config.toml), which is exactly what this catches.
real_codex_fp()  { ls -A "$HOME/.codex"  2>/dev/null | sort | cksum; }
real_claude_fp() { ls -A "$HOME/.claude" 2>/dev/null | sort | cksum; }
CODEX_BEFORE="$(real_codex_fp)"; CLAUDE_BEFORE="$(real_claude_fp)"
REAL_HOME="$HOME"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
STUB="$TD/bin"; mkdir -p "$STUB"

# A `claude` that stands in for the Haiku rewriter (never on PATH by default: the
# tests that want it point LEOPOLD_ENHANCE_CLAUDE_BIN at it).
cat > "$TD/stub-claude" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'Objective: fix the login flow\nContext: test\nConstraints: none\nDone when: login works\nAssumptions: none\n'
EOF
chmod +x "$TD/stub-claude"
for t in bash sh env grep sed awk cat cut head tail sort tr wc cp mv rm mkdir rmdir dirname basename \
         mktemp ls printf jq python3 chmod cksum du diff touch; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$STUB/$t"
done

# Every invocation runs in this sealed environment: HOME is the temp dir, so the
# harness homes resolve there without any *_HOME override doing the work for us.
run() { # <home-dir> <harness> <script> <arg...>
  local h="$1" harness="$2" script="$3"; shift 3
  env -i PATH="$STUB" HOME="$h" LEOPOLD_HARNESS="$harness" TERM=dumb \
      LEOPOLD_ENHANCE_NO_PROBE=1 CI=1 \
      bash "$script" "$@" 2>&1
}

# Fire the wired hook exactly as a harness would: the engine at the vendored path,
# reading the harness's own payload shape on stdin.
fire() { # <home-dir> <enhance-dir> <harness: claude|codex> <session> <prompt> [extra-env...]
  local h="$1" dir="$2" kind="$3" sid="$4" prompt="$5"; shift 5
  local idkey='"prompt_id":"p1"'
  [ "$kind" = codex ] && idkey='"turn_id":"t1"'
  printf '{"session_id":"%s",%s,"transcript_path":"","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s"}' \
    "$sid" "$idkey" "$h" "$prompt" \
  | env -i PATH="$STUB" HOME="$h" TERM=dumb "$@" python3 "$dir/enhance.py" --event user-prompt 2>&1
}

toml_ok() { python3 -c 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))' "$1" 2>/dev/null; }
toml_hook_cmd() { python3 - "$1" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
print(d["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"])
PY
}
toml_hook_n() { python3 - "$1" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
print(len(d.get("hooks", {}).get("UserPromptSubmit", [])))
PY
}

# =============================================================================
echo "enhance extension — Codex-only home (no ~/.claude anywhere)"
# =============================================================================
CX="$TD/codex-only"; mkdir -p "$CX/.codex"
CFG="$CX/.codex/config.toml"
printf 'model = "gpt-5.1-codex"\n' > "$CFG"

out="$(run "$CX" codex "$INSTALL")"
check "install exits clean" "$?" "0"
ENH="$CX/.codex/enhance"
check "engine vendored into the Codex home"  "$( [ -f "$ENH/enhance.py" ] && echo yes || echo no )" "yes"
check "state seeded off"                     "$(jq -r .enabled "$ENH/state.json")" "false"
check "no ~/.claude was created"             "$( [ -e "$CX/.claude" ] && echo yes || echo no )" "no"
check "config.toml still parses as TOML"     "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
check "one UserPromptSubmit hook"            "$(toml_hook_n "$CFG")" "1"
check "the hook points at the vendored engine" \
  "$(toml_hook_cmd "$CFG")" "python3 $ENH/enhance.py --event user-prompt"
check "the user's own config key survived"   "$(grep -c '^model = "gpt-5.1-codex"$' "$CFG")" "1"
check "one managed enhance block"            "$(grep -c '^# >>> leopold:enhance (managed) >>>$' "$CFG")" "1"
hasnt "install never names a Claude path"    "$out" "\.claude"
has   "install states the Codex trust gate"  "$out" "inert until you approve it once"

echo
echo "enhance extension — install is idempotent (run it three times)"
cp "$CFG" "$TD/after-first.toml"
run "$CX" codex "$INSTALL" >/dev/null
run "$CX" codex "$INSTALL" >/dev/null
check "config.toml unchanged by the 2nd and 3rd install" \
  "$(diff -q "$TD/after-first.toml" "$CFG" >/dev/null && echo same || echo changed)" "same"
check "still exactly one UserPromptSubmit hook" "$(toml_hook_n "$CFG")" "1"
check "still one managed enhance block"         "$(grep -c '^# >>> leopold:enhance (managed) >>>$' "$CFG")" "1"

echo
echo "enhance extension — disabled means a silent pass-through, same as on Claude"
check "state is still off"           "$(jq -r .enabled "$ENH/state.json")" "false"
check "a Codex prompt passes through untouched" "$(fire "$CX" "$ENH" codex s1 'fix login')" ""
check "a Claude prompt passes through untouched" "$(fire "$CX" "$ENH" claude s2 'fix login')" ""
check "the wiring is still there while it is off" "$(toml_hook_n "$CFG")" "1"

echo
echo "enhance extension — enabled, the injection is handed back per harness"
# Codex REJECTS a plain-text UserPromptSubmit hook ("hook: UserPromptSubmit Failed",
# verified live on codex-cli 0.146.0); Claude Code injects stdout as-is. Same
# content, two envelopes — and the Claude one must stay byte-for-byte what it was.
printf '{"enabled":true,"model":"haiku"}' > "$ENH/state.json"
cxout="$(fire "$CX" "$ENH" codex s3 'fix login' LEOPOLD_ENHANCE_CLAUDE_BIN="$TD/stub-claude")"
check "Codex gets valid JSON" "$(printf '%s' "$cxout" | jq -e . >/dev/null 2>&1 && echo yes || echo no)" "yes"
check "in the additionalContext envelope" \
  "$(printf '%s' "$cxout" | jq -r '.hookSpecificOutput.hookEventName')" "UserPromptSubmit"
has "carrying the enhance block"    "$(printf '%s' "$cxout" | jq -r '.hookSpecificOutput.additionalContext')" "\[leopold-enhance"
has "and the raw-prompt-wins rule"  "$(printf '%s' "$cxout" | jq -r '.hookSpecificOutput.additionalContext')" "THE RAW PROMPT WINS"

clout="$(fire "$CX" "$ENH" claude s4 'fix login' LEOPOLD_ENHANCE_CLAUDE_BIN="$TD/stub-claude")"
has   "Claude Code still gets plain text" "$clout" "\[leopold-enhance"
hasnt "Claude Code never gets JSON"       "$clout" "hookSpecificOutput"
check "the ledger records which harness asked" \
  "$(jq -r -s '[.[] | select(.injected) | .harness] | join(",")' "$ENH/enhancements.jsonl")" "codex,claude"

echo
echo "enhance extension — status and doctor report the Codex harness"
st="$(run "$CX" codex "$MANAGE" status)"
has   "status reports the shared on/off state" "$st" "^on ("
has   "status reports the Codex hook as wired" "$st" "Codex CLI: hook wired"
hasnt "status never names Claude Code here"    "$st" "Claude Code"
doc="$(run "$CX" codex "$MANAGE" doctor)"
has   "doctor names the harness"        "$doc" "Codex CLI:"
has   "doctor reports 1/1 wired"        "$doc" "hook:   1/1 wired"
has   "doctor states the trust gate"    "$doc" "inert until you approve it once"
has   "doctor is honest about the rewriter needing the claude CLI" "$doc" "rewriter: UNAVAILABLE"
hasnt "doctor never points at a Claude path" "$doc" "/\.claude"
hasnt "doctor reports nothing missing"  "$doc" "missing"

echo
echo "enhance extension — remove unwires Codex and takes the data with it"
run "$CX" codex "$MANAGE" remove >/dev/null
check "config.toml still parses"          "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
check "no enhance hook left"              "$(grep -c 'enhance.py --event' "$CFG")" "0"
check "no managed enhance block left"     "$(grep -c 'leopold:enhance (managed)' "$CFG")" "0"
check "the user's own config key survived" "$(grep -c '^model = "gpt-5.1-codex"$' "$CFG")" "1"
check "the data dir is gone"              "$( [ -e "$ENH" ] && echo yes || echo no )" "no"

# =============================================================================
echo
echo "enhance extension — one switch for both harnesses"
# =============================================================================
BOTH="$TD/both"; mkdir -p "$BOTH/.claude" "$BOTH/.codex"
run "$BOTH" all "$INSTALL" >/dev/null
SET="$BOTH/.claude/settings.json"; CFG2="$BOTH/.codex/config.toml"
SHARED="$BOTH/.claude/enhance"
check "one data dir, under the Claude home (no migration for existing installs)" \
  "$( [ -d "$SHARED" ] && [ ! -d "$BOTH/.codex/enhance" ] && echo yes || echo no )" "yes"
check "Claude Code got its hook" \
  "$(jq '[.hooks.UserPromptSubmit[]?.hooks[]? | select(.command | test("enhance.py --event"))] | length' "$SET")" "1"
check "Claude's hook carries the 30s timeout" \
  "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].timeout' "$SET")" "30"
check "Codex got its hook" "$(toml_hook_n "$CFG2")" "1"
check "both point at the same engine" \
  "$(toml_hook_cmd "$CFG2")" "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$SET")"

# The point of the shared dir: flip it from one harness, read it from the other.
run "$BOTH" codex "$MANAGE" toggle on >/dev/null
has "toggled on from Codex, Claude Code sees it on" "$(run "$BOTH" claude "$MANAGE" status)" "^on ("
run "$BOTH" claude "$MANAGE" toggle off >/dev/null
has "toggled off from Claude Code, Codex sees it off" "$(run "$BOTH" codex "$MANAGE" status)" "^off"
st="$(run "$BOTH" all "$MANAGE" status)"
has "status reports both harnesses" "$st" "Claude Code: hook wired"
has "and the Codex one too"         "$st" "Codex CLI: hook wired"
check "status is one line (the menu renders it inline)" "$(printf '%s\n' "$st" | wc -l | tr -d " ")" "1"

run "$BOTH" all "$MANAGE" remove >/dev/null
check "remove unwired Claude Code"  "$(grep -c 'enhance.py --event' "$SET")" "0"
check "remove unwired Codex"        "$(grep -c 'enhance.py --event' "$CFG2")" "0"
check "settings.json still parses"  "$(jq -e . "$SET" >/dev/null 2>&1 && echo yes || echo no)" "yes"

echo
echo "enhance extension — nothing escaped the temp dirs"
HOME="$REAL_HOME"
check "the real ~/.codex gained no new entries"  "$(real_codex_fp)"  "$CODEX_BEFORE"
check "the real ~/.claude gained no new entries" "$(real_claude_fp)" "$CLAUDE_BEFORE"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s passed, 0 failed\033[0m\n' "$PASS"
else
  printf '\033[31m%s passed, %s FAILED\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
