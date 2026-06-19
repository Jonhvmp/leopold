#!/usr/bin/env bash
# ovmem installer - Full OpenAI profile (verified end-to-end).
#
# Steps: prereqs -> install OpenViking -> validate OpenAI key (chat + embeddings)
#        -> write ov.conf -> server wrapper + start -> vendor scripts -> wire 4 hooks
#        -> round-trip verify (session -> extract). Idempotent; backs up what it touches.
#
# Local/Ollama profiles are not wired yet (see README.md). This profile needs an
# OpenAI key with BOTH the embedding and the model.request (chat) scopes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/payload"

CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
OVMEM_DIR="$CLAUDE/ovmem"
SETTINGS="$CLAUDE/settings.json"
OV_DIR="$HOME/.openviking"
OV_CONF="$OV_DIR/ov.conf"
WORKSPACE="$OV_DIR/data"
BIN="$HOME/.local/bin"
HEALTH="http://127.0.0.1:1933/health"
API="http://127.0.0.1:1933/api/v1"
OPENVIKING_PIN="openviking==0.3.21"   # the version this installer was verified against

say()  { printf "\033[36m->\033[0m %s\n" "$*"; }
ok()   { printf "   \033[32mok\033[0m   %s\n" "$*"; }
warn() { printf "   \033[33mwarn\033[0m %s\n" "$*"; }
die()  { printf "\033[31mx\033[0m %s\n" "$*" >&2; exit 1; }

# ---- 0. platform ------------------------------------------------------------
# Supported: Linux and macOS (POSIX). Native Windows is not supported - run
# inside WSL, where Claude Code and this stack get a POSIX shell.
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux|Darwin) : ;;
  MINGW*|MSYS*|CYGWIN*|Windows*) die "Native Windows is not supported. Run this inside WSL (https://learn.microsoft.com/windows/wsl/)." ;;
  *) warn "unrecognized OS '$(uname -s 2>/dev/null)'; proceeding, but only Linux/macOS are tested." ;;
esac

# portable: PID listening on tcp/1933 (lsof on macOS/Linux, ss as a Linux fallback)
port_pid() {
  if command -v lsof >/dev/null 2>&1; then lsof -ti tcp:1933 2>/dev/null | head -1
  elif command -v ss >/dev/null 2>&1; then ss -tlnp 2>/dev/null | grep ':1933' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1
  fi
}

# ---- 1. prereqs -------------------------------------------------------------
say "checking prerequisites"
command -v curl    >/dev/null 2>&1 || die "curl is required"
command -v jq      >/dev/null 2>&1 || die "jq is required (https://jqlang.github.io/jq/)"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
if ! command -v uv >/dev/null 2>&1; then
  warn "uv not found - installing it (https://docs.astral.sh/uv/)"
  curl -LsSf https://astral.sh/uv/install.sh | sh || die "uv install failed; install it manually and re-run"
  export PATH="$HOME/.local/bin:$PATH"
fi
ok "curl, jq, python3, uv present"

# ---- 2. OpenViking ----------------------------------------------------------
if command -v openviking-server >/dev/null 2>&1; then
  ok "OpenViking already installed ($(openviking-server --version 2>/dev/null | head -1 || echo present))"
else
  say "installing OpenViking ($OPENVIKING_PIN)"
  uv tool install "$OPENVIKING_PIN" || die "uv tool install openviking failed"
  export PATH="$BIN:$PATH"
  command -v openviking-server >/dev/null 2>&1 || die "openviking-server not on PATH after install (add $BIN to PATH)"
  ok "OpenViking installed"
fi

# ---- 3. OpenAI key: prompt + validate (chat + embeddings) -------------------
validate_key() { # $1=key -> 0 if chat+embeddings both work
  local key="$1" cc ec
  cc="$(curl -s -o /tmp/ovmem_chat.json -w '%{http_code}' -m 30 https://api.openai.com/v1/chat/completions \
        -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
        -d '{"model":"gpt-4o-mini","max_tokens":5,"messages":[{"role":"user","content":"ok"}]}' 2>/dev/null || echo 000)"
  if [ "$cc" != "200" ]; then
    if grep -q "model.request" /tmp/ovmem_chat.json 2>/dev/null; then
      warn "key is missing the 'model.request' (chat) scope - extraction would 401."
    else
      warn "chat check failed (HTTP $cc): $(jq -r '.error.message // empty' /tmp/ovmem_chat.json 2>/dev/null | head -c 120)"
    fi
    return 1
  fi
  ec="$(curl -s -o /tmp/ovmem_emb.json -w '%{http_code}' -m 30 https://api.openai.com/v1/embeddings \
        -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
        -d '{"model":"text-embedding-3-small","input":"ok"}' 2>/dev/null || echo 000)"
  if [ "$ec" != "200" ]; then
    warn "embeddings check failed (HTTP $ec): $(jq -r '.error.message // empty' /tmp/ovmem_emb.json 2>/dev/null | head -c 120)"
    return 1
  fi
  return 0
}

OPENAI_KEY=""
if [ ! -t 0 ] && [ -n "${OPENAI_API_KEY:-}" ]; then
  say "non-interactive: using OPENAI_API_KEY from the environment"
  validate_key "$OPENAI_API_KEY" && OPENAI_KEY="$OPENAI_API_KEY" || die "the OPENAI_API_KEY in the environment failed validation"
else
  say "OpenAI key (needs embedding + model.request/chat scopes; input is hidden)"
  for _try in 1 2 3; do
    printf "   paste key: "; IFS= read -rs OPENAI_KEY || true; echo
    [ -n "$OPENAI_KEY" ] || { warn "empty"; continue; }
    if validate_key "$OPENAI_KEY"; then break; else OPENAI_KEY=""; fi
    [ "$_try" = "3" ] && die "key validation failed 3 times. Generate a standard key with full model permissions and retry."
  done
fi
rm -f /tmp/ovmem_chat.json /tmp/ovmem_emb.json
[ -n "$OPENAI_KEY" ] || die "no valid OpenAI key"
ok "key validated (chat + embeddings)"

# ---- 4. ov.conf -------------------------------------------------------------
say "writing $OV_CONF"
mkdir -p "$OV_DIR" "$WORKSPACE"
[ -f "$OV_CONF" ] && { cp "$OV_CONF" "$OV_CONF.ovmem.bak"; warn "backed up existing ov.conf -> $OV_CONF.ovmem.bak"; }
ROOTKEY="$(openssl rand -hex 16 2>/dev/null || echo ov-local-dev-key)"
jq -n --arg key "$OPENAI_KEY" --arg ws "$WORKSPACE" --arg rk "$ROOTKEY" '{
  storage:  {workspace: $ws},
  server:   {host:"127.0.0.1", port:1933, root_api_key:$rk},
  embedding:{dense:{provider:"openai", model:"text-embedding-3-small", api_key:$key, api_base:"https://api.openai.com/v1", dimension:1536}},
  vlm:      {provider:"openai", model:"gpt-4o-mini", api_key:$key, api_base:"https://api.openai.com/v1", temperature:0.0, max_tokens:16384, max_retries:2},
  output_language_override:"en"
}' > "$OV_CONF"
chmod 600 "$OV_CONF"
ok "ov.conf written (chmod 600; the key is stored in plaintext - keep this file private)"

# ---- 5. server wrapper + (re)start -----------------------------------------
say "installing server bootstrap + starting OpenViking"
mkdir -p "$BIN"
cat > "$BIN/openviking-start" <<EOF
#!/usr/bin/env bash
# Start OpenViking in the background if it is not already healthy.
if curl -sf http://127.0.0.1:1933/health > /dev/null 2>&1; then exit 0; fi
nohup "$BIN/openviking-server" --host 127.0.0.1 --port 1933 > /tmp/openviking.log 2>&1 &
echo \$! > /tmp/openviking.pid
EOF
chmod +x "$BIN/openviking-start"
# restart so a re-install picks up the new ov.conf (portable: no setsid/ss)
PID="$(port_pid || true)"
[ -n "$PID" ] && kill "$PID" 2>/dev/null || true
nohup "$BIN/openviking-server" --host 127.0.0.1 --port 1933 </dev/null >/tmp/openviking.log 2>&1 &
disown 2>/dev/null || true
curl -s --retry 30 --retry-delay 1 --retry-connrefused -m 60 "$HEALTH" >/dev/null 2>&1 \
  && ok "server healthy on 127.0.0.1:1933" || die "server did not become healthy; see /tmp/openviking.log"

# ---- 6. vendor scripts ------------------------------------------------------
say "installing ovmem engine into $OVMEM_DIR"
mkdir -p "$OVMEM_DIR/state"
cp "$PAYLOAD/ovmem.py"          "$OVMEM_DIR/ovmem.py"
cp "$PAYLOAD/ovmem-cleanup.py"  "$OVMEM_DIR/ovmem-cleanup.py"
cp "$PAYLOAD/RUNTIME.md"        "$OVMEM_DIR/README.md" 2>/dev/null || true
ok "ovmem.py + ovmem-cleanup.py installed"

# ---- 7. wire the 4 hooks (idempotent, with backup) --------------------------
say "wiring hooks into $SETTINGS"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.ovmem.bak"
SS="python3 $OVMEM_DIR/ovmem.py --event session-start"
UP="python3 $OVMEM_DIR/ovmem.py --event user-prompt"
PC="python3 $OVMEM_DIR/ovmem.py --event pre-compact"
SE="python3 $OVMEM_DIR/ovmem.py --event session-end"
tmp="$(mktemp)"
jq --arg ss "$SS" --arg up "$UP" --arg pc "$PC" --arg se "$SE" '
  .hooks //= {}
  | .hooks.SessionStart //= [] | .hooks.UserPromptSubmit //= []
  | .hooks.PreCompact //= []   | .hooks.SessionEnd //= []
  | (if any(.hooks.SessionStart[]?.hooks[]?;   .command==$ss) then . else .hooks.SessionStart    += [{hooks:[{type:"command",command:$ss,timeout:12}]}] end)
  | (if any(.hooks.UserPromptSubmit[]?.hooks[]?;.command==$up) then . else .hooks.UserPromptSubmit += [{hooks:[{type:"command",command:$up,timeout:12}]}] end)
  | (if any(.hooks.PreCompact[]?.hooks[]?;     .command==$pc) then . else .hooks.PreCompact      += [{hooks:[{type:"command",command:$pc,timeout:25}]}] end)
  | (if any(.hooks.SessionEnd[]?.hooks[]?;     .command==$se) then . else .hooks.SessionEnd      += [{hooks:[{type:"command",command:$se,timeout:25}]}] end)
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
ok "4 hooks wired (backup at $SETTINGS.ovmem.bak)"

# ---- 8. round-trip verify ---------------------------------------------------
say "verifying end-to-end (commit -> extract)"
H=(-H "x-api-key: $ROOTKEY" -H "X-OpenViking-Account: default" -H "X-OpenViking-User: ${USER:-default}" -H "X-OpenViking-Agent: claude-code" -H "Content-Type: application/json")
SID="ovmem-install-check"
curl -s -m 10 -X POST "${H[@]}" -d "{\"session_id\":\"$SID\"}" "$API/sessions" >/dev/null 2>&1 || true
curl -s -m 12 -X POST "${H[@]}" -d '{"messages":[{"role":"user","content":"Install check: I prefer concise answers."},{"role":"assistant","content":"Noted: concise answers."}]}' "$API/sessions/$SID/messages/batch" >/dev/null 2>&1 || true
EXTRACT="$(curl -s -m 120 -X POST "${H[@]}" "$API/sessions/$SID/extract" 2>/dev/null || echo '{}')"
curl -s -m 8 -X DELETE "${H[@]}" "$API/sessions/$SID" >/dev/null 2>&1 || true
if echo "$EXTRACT" | jq -e '.status=="ok"' >/dev/null 2>&1; then
  ok "extraction works (memories extracted: $(echo "$EXTRACT" | jq '.result | if type=="array" then length else . end' 2>/dev/null))"
else
  warn "extraction round-trip did not confirm; check /tmp/openviking.log. Recall/capture still work."
fi

echo
ok "ovmem installed. It activates on your NEXT Claude Code session (hooks load at start)."
echo "   debug:  OVMEM_DEBUG=1 ; log at ~/.claude/ovmem/ovmem.log"
echo "   off:    OVMEM_DISABLE=1"
echo "   prune:  python3 $OVMEM_DIR/ovmem-cleanup.py        (dry-run)"
