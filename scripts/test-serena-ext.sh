#!/usr/bin/env bash
# Behavior tests for the serena extension's harness port (extensions/serena/manage.sh).
#
# HERMETIC. HOME, CLAUDE_HOME and CODEX_HOME all point inside a temp dir, and PATH is
# rebuilt from scratch with stubs for serena / serena-hooks / uv / claude, so nothing
# here installs a package, touches the network, or writes into the developer's real
# ~/.codex, ~/.claude or ~/.serena. The Codex side runs against the REAL `codex`
# binary when one is present (that is the point of the test); it is pointed at the
# temp CODEX_HOME, which codex-cli 0.146.0 honors.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGE="$ROOT/extensions/serena/manage.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then bad "$1"; else ok "$1"; fi; }

# Same guard as test-harness-lib.sh: names only, so a live agent session writing its
# own transcripts does not fail the suite. What an escaped write looks like is a NEW
# entry (leopold/, skills/, config.toml), and that is what this catches.
real_codex_fp()  { ls -A "$HOME/.codex"  2>/dev/null | sort | cksum; }
real_claude_fp() { ls -A "$HOME/.claude" 2>/dev/null | sort | cksum; }
real_serena_fp() { ls -A "$HOME/.serena" 2>/dev/null | sort | cksum; }
CODEX_BEFORE="$(real_codex_fp)"; CLAUDE_BEFORE="$(real_claude_fp)"; SERENA_BEFORE="$(real_serena_fp)"
REAL_HOME="$HOME"

CODEX_BIN="$(command -v codex 2>/dev/null || true)"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
STUB="$TD/bin"; mkdir -p "$STUB" "$TD/home" "$TD/codex" "$TD/claude"

# --- stubs -------------------------------------------------------------------
cat > "$STUB/serena" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in --version) echo "serena 9.9.9" ;; init) exit 0 ;; *) exit 0 ;; esac
EOF
cat > "$STUB/serena-hooks" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$STUB/uv" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
# A `claude` that speaks just enough of `claude mcp` to be answered per harness, and
# records what it was asked so the test can prove the Claude scope flag is still sent.
cat > "$STUB/claude" <<'EOF'
#!/usr/bin/env bash
REG="${FAKE_CLAUDE_MCP:?}"
echo "$*" >> "$REG.log"
case "${1:-}${2:+ $2}" in
  "mcp get")    shift 2; grep -qx "$1" "$REG" 2>/dev/null ;;
  "mcp add")    shift 2
                while [ $# -gt 0 ]; do
                  case "$1" in
                    --scope|-s) shift 2 ;;
                    --*) shift ;;
                    *) echo "$1" >> "$REG"; break ;;
                  esac
                done ;;
  "mcp remove") shift 2; t="$(mktemp)"; grep -vx "$1" "$REG" > "$t" 2>/dev/null; mv "$t" "$REG" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$STUB"/*
for t in bash sh env grep sed awk cat cut head tail sort tr wc cp mv rm mkdir dirname basename \
         mktemp ls printf jq python3 chmod cksum timeout diff curl; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$STUB/$t"
done
[ -n "$CODEX_BIN" ] && ln -sf "$CODEX_BIN" "$STUB/codex"

export FAKE_CLAUDE_MCP="$TD/claude-mcp-registry"
: > "$FAKE_CLAUDE_MCP"

# Every invocation below runs in this sealed environment.
run() { # <harness> <arg...>
  local h="$1"; shift
  env -i PATH="$STUB" HOME="$TD/home" \
      CLAUDE_HOME="$TD/claude" CODEX_HOME="$TD/codex" LEOPOLD_HARNESS="$h" \
      FAKE_CLAUDE_MCP="$FAKE_CLAUDE_MCP" TERM=dumb \
      bash "$MANAGE" "$@" 2>&1
}

toml_ok()   { python3 -c 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))' "$1" 2>/dev/null; }
toml_get()  { python3 - "$1" "$2" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d)
PY
}

CFG="$TD/codex/config.toml"
SET="$TD/claude/settings.json"

if [ -z "$CODEX_BIN" ]; then
  echo "serena extension — SKIPPED the Codex MCP assertions: no \`codex\` binary on PATH."
  echo "  (the hook-wiring and reporting assertions below still run)"
fi

echo "serena extension — Codex-only install into a temp CODEX_HOME"

printf 'model = "gpt-5"\n' > "$CFG"
out="$(run codex install)"
check "install exits clean" "$?" "0"

if [ -n "$CODEX_BIN" ]; then
  check "codex config.toml still parses"     "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
  check "serena registered as an MCP server" \
    "$(python3 -c 'import tomllib,sys;print("serena" in tomllib.load(open(sys.argv[1],"rb")).get("mcp_servers",{}))' "$CFG")" "True"
  check "registered with the codex context"  "$(toml_get "$CFG" 'mcp_servers.serena.args.1')" "--context=codex"
  check "registered to launch serena"        "$(toml_get "$CFG" 'mcp_servers.serena.command')" "serena"
  has   "install reports the Codex registration" "$out" "Codex CLI: MCP registered"
fi

check "four Serena hooks in config.toml" "$(grep -c 'serena-hooks ' "$CFG")" "4"
check "hooks wired with --client=codex"  "$(grep -c 'client=codex' "$CFG")" "4"
check "no claude-code client leaked in"  "$(grep -c 'client=claude-code' "$CFG")" "0"
check "one managed serena block"         "$(grep -c '^# >>> leopold:serena (managed) >>>$' "$CFG")" "1"
check "SessionStart hook declared"       "$(grep -c '^\[\[hooks.SessionStart\]\]$' "$CFG")" "1"
check "SessionEnd hook declared"         "$(grep -c '^\[\[hooks.SessionEnd\]\]$' "$CFG")" "1"
check "the user's own config key survived" "$(toml_get "$CFG" model)" "gpt-5"
check "no Claude settings.json was created" "$( [ -e "$SET" ] && echo yes || echo no )" "no"

echo
echo "serena extension — doctor is green on Codex"

doc="$(run codex doctor)"
has   "doctor names the harness"          "$doc" "Codex CLI:"
check "doctor reports 4/4 hooks"          "$(printf '%s' "$doc" | grep -c 'hooks:  4/4')" "1"
has   "doctor states the hook-trust gate" "$doc" "inert until you approve it once"
hasnt "doctor never points at a Claude path" "$doc" ".claude"
if [ -n "$CODEX_BIN" ]; then
  has   "doctor reports the MCP as registered" "$doc" "MCP:    registered"
  hasnt "doctor has nothing left unregistered" "$doc" "not registered"
fi
hasnt "doctor reports nothing missing" "$doc" "missing"

echo
echo "serena extension — install is idempotent (run it three times)"

cp "$CFG" "$TD/after-first.toml"
out2="$(run codex install)"
out3="$(run codex install)"
check "config.toml unchanged by the 2nd and 3rd install" \
  "$(diff -q "$TD/after-first.toml" "$CFG" >/dev/null && echo same || echo changed)" "same"
check "still exactly four Serena hooks" "$(grep -c 'serena-hooks ' "$CFG")" "4"
check "still one managed serena block"  "$(grep -c '^# >>> leopold:serena (managed) >>>$' "$CFG")" "1"
has   "the repeat run says the hooks are already wired" "$out3" "Serena hooks already wired"
if [ -n "$CODEX_BIN" ]; then
  has "the repeat run says the MCP is already registered" "$out2" "already registered"
  check "still exactly one mcp_servers.serena table" "$(grep -c '^\[mcp_servers.serena\]$' "$CFG")" "1"
fi

if [ -n "$CODEX_BIN" ]; then
  echo
  echo "serena extension — \`codex mcp add\` on a config that already has the hook block"
  # The real hazard of sharing one file between two writers: codex-cli rewrites
  # config.toml with its own TOML editor. If that dropped our comment markers the
  # next install would append a SECOND managed block and the hooks would double.
  env -i PATH="$STUB" HOME="$TD/home" CODEX_HOME="$TD/codex" \
      codex mcp remove serena >/dev/null 2>&1
  run codex install >/dev/null 2>&1
  check "the markers survived codex's own TOML writer" \
    "$(grep -c '^# >>> leopold:serena (managed) >>>$' "$CFG")" "1"
  check "the hooks were not doubled"     "$(grep -c 'serena-hooks ' "$CFG")" "4"
  check "the MCP entry came back"        "$(grep -c '^\[mcp_servers.serena\]$' "$CFG")" "1"
  check "config.toml still parses"       "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
fi

echo
echo "serena extension — status reports EVERY harness, not just Claude's"

both="$(run all status)"
check "status is one line (the menu renders it inline)" "$(printf '%s\n' "$both" | wc -l)" "1"
has "status reports Claude Code"   "$both" "Claude Code:"
has "status reports Codex CLI"     "$both" "Codex CLI:"
has "status shows the Codex hooks" "$both" "hooks 4/4"
has "status shows Claude unwired"  "$both" "Claude Code: MCP off, hooks 0/4"

# and now wire the Claude side too: both segments must move independently
out="$(run all install)"
both="$(run all status)"
has "after a two-harness install, Claude is on" "$both" "Claude Code: MCP on, hooks 4/4"
has "and Codex is still on"                     "$both" "Codex CLI: MCP on, hooks 4/4"
check "Claude got its own four hooks" "$(jq '[.hooks[]?[]?.hooks[]? | select(.command | test("serena-hooks "))] | length' "$SET")" "4"
check "Claude wired with --client=claude-code"  "$(grep -c 'client=claude-code' "$SET")" "4"
check "Claude keeps the mcp__serena__* matcher" "$(jq '[.hooks.PreToolUse[]? | select(.matcher == "mcp__serena__*")] | length' "$SET")" "1"
check "Claude MCP registered at user scope"     "$(grep -c -- '--scope user' "$FAKE_CLAUDE_MCP.log")" "1"
check "Codex hooks not duplicated by the two-harness run" "$(grep -c 'serena-hooks ' "$CFG")" "4"

echo
echo "serena extension — remove unwires both harnesses"

run all remove >/dev/null
check "config.toml still parses after remove" "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
check "no Serena hooks left in config.toml"   "$(grep -c 'serena-hooks ' "$CFG")" "0"
check "no managed serena block left"          "$(grep -c 'leopold:serena (managed)' "$CFG")" "0"
check "the user's own config key still there" "$(toml_get "$CFG" model)" "gpt-5"
check "no Serena hooks left in settings.json" "$(grep -c 'serena-hooks ' "$SET")" "0"
check "settings.json still parses"            "$(jq -e . "$SET" >/dev/null 2>&1 && echo yes || echo no)" "yes"
check "Claude MCP unregistered"               "$(grep -cx serena "$FAKE_CLAUDE_MCP")" "0"
if [ -n "$CODEX_BIN" ]; then
  check "Codex MCP unregistered" "$(grep -c '^\[mcp_servers.serena\]$' "$CFG")" "0"
fi

echo
echo "serena extension — nothing escaped the temp dirs"
HOME="$REAL_HOME"
check "the real ~/.codex gained no new entries"  "$(real_codex_fp)"  "$CODEX_BEFORE"
check "the real ~/.claude gained no new entries" "$(real_claude_fp)" "$CLAUDE_BEFORE"
check "the real ~/.serena gained no new entries" "$(real_serena_fp)" "$SERENA_BEFORE"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s passed, 0 failed\033[0m\n' "$PASS"
else
  printf '\033[31m%s passed, %s FAILED\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
