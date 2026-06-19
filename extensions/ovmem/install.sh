#!/usr/bin/env bash
# ovmem installer - picks a provider + models, then sets everything up.
#
# Providers:
#   openai   - one API key (needs embedding + model.request scopes). Verified.
#   bedrock  - AWS Bedrock via LiteLLM, auth with a Bedrock API key (bearer token)
#              + a region. Adds boto3 to the OpenViking venv. (chat + Titan/Cohere embed)
#
# Model lineup + prices live in models.json (the single source the menu reads).
# Flow: prereqs -> pick provider -> pick chat model -> pick embed model -> auth
#       -> write ov.conf (+ Bedrock env) -> server -> vendor scripts -> wire hooks -> verify.
#
# Interactive prompts read from /dev/tty so this works even under `curl ... | bash`.
# Headless (no terminal): set OVMEM_PROVIDER, OVMEM_CHAT_MODEL, OVMEM_EMBED_MODEL and
# OPENAI_API_KEY  (openai)  or  AWS_BEARER_TOKEN_BEDROCK + AWS_REGION  (bedrock).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/payload"
MODELS="$HERE/models.json"

CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
OVMEM_DIR="$CLAUDE/ovmem"
SETTINGS="$CLAUDE/settings.json"
OV_DIR="$HOME/.openviking"
OV_CONF="$OV_DIR/ov.conf"
WORKSPACE="$OV_DIR/data"
BIN="$HOME/.local/bin"
HEALTH="http://127.0.0.1:1933/health"
API="http://127.0.0.1:1933/api/v1"
OPENVIKING_PIN="openviking==0.3.21"

say()  { printf "\033[36m->\033[0m %s\n" "$*"; }
ok()   { printf "   \033[32mok\033[0m   %s\n" "$*"; }
warn() { printf "   \033[33mwarn\033[0m %s\n" "$*"; }
die()  { printf "\033[31mx\033[0m %s\n" "$*" >&2; exit 1; }

# ---- terminal I/O (works under curl | bash via /dev/tty) --------------------
TTY=""
if exec 3<>/dev/tty 2>/dev/null; then TTY=3; fi

ask() {  # $1 prompt  $2 default  -> echoes the answer
  local p="$1" d="${2:-}" a=""
  if [ -n "$TTY" ]; then
    if [ -n "$d" ]; then printf "%s [%s]: " "$p" "$d" >&"$TTY"; else printf "%s: " "$p" >&"$TTY"; fi
    IFS= read -r a <&"$TTY" || a=""
    [ -z "$a" ] && a="$d"
  else
    a="$d"
  fi
  printf "%s" "$a"
}

ask_secret() {  # $1 prompt -> echoes the secret (no echo on screen)
  local p="$1" a=""
  if [ -n "$TTY" ]; then
    printf "%s: " "$p" >&"$TTY"; IFS= read -rs a <&"$TTY" || a=""; printf "\n" >&"$TTY"
  fi
  printf "%s" "$a"
}

j() { jq -r "$1" "$MODELS"; }   # query models.json

# ---- 0. platform ------------------------------------------------------------
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux|Darwin) : ;;
  MINGW*|MSYS*|CYGWIN*|Windows*) die "Native Windows is not supported. Run inside WSL." ;;
  *) warn "unrecognized OS '$(uname -s 2>/dev/null)'; only Linux/macOS are tested." ;;
esac
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
[ -f "$MODELS" ]   || die "models.json not found next to the installer"
if ! command -v uv >/dev/null 2>&1; then
  warn "uv not found - installing it"
  curl -LsSf https://astral.sh/uv/install.sh | sh || die "uv install failed"
  export PATH="$HOME/.local/bin:$PATH"
fi
ok "curl, jq, python3, uv present"

# ---- 2. pick provider + models ---------------------------------------------
PROVIDER="${OVMEM_PROVIDER:-}"
if [ -z "$PROVIDER" ]; then
  if [ -n "$TTY" ]; then
    printf "\nProvider:\n  1) openai   (one API key)\n  2) bedrock  (AWS, Bedrock API key + region)\n" >&"$TTY"
    case "$(ask "select" "1")" in 2|bedrock) PROVIDER=bedrock ;; *) PROVIDER=openai ;; esac
  else
    die "headless: set OVMEM_PROVIDER=openai|bedrock"
  fi
fi
[ "$PROVIDER" = openai ] || [ "$PROVIDER" = bedrock ] || die "unknown provider: $PROVIDER"

pick_model() {  # $1 kind(chat|embed) -> echoes the chosen model id
  local kind="$1" preset="" i n choice line
  local ids=()
  case "$kind" in chat) preset="${OVMEM_CHAT_MODEL:-}";; embed) preset="${OVMEM_EMBED_MODEL:-}";; esac
  # portable array fill (no mapfile; macOS ships bash 3.2)
  while IFS= read -r line; do [ -n "$line" ] && ids+=("$line"); done < <(j ".${kind}[] | select(.provider==\"$PROVIDER\") | .id")
  [ "${#ids[@]}" -gt 0 ] || die "no $kind models for provider $PROVIDER in models.json"
  if [ -n "$preset" ]; then printf "%s" "$preset"; return; fi
  if [ -z "$TTY" ]; then die "headless: set OVMEM_$(printf '%s' "$kind" | tr '[:lower:]' '[:upper:]')_MODEL (one of: ${ids[*]})"; fi
  printf "\n%s model:\n" "$kind" >&"$TTY"
  i=1
  for id in "${ids[@]}"; do
    if [ "$kind" = chat ]; then
      printf "  %d) %-22s \$%s in / \$%s out per 1M  · ctx %s %s\n" "$i" "$id" \
        "$(j ".chat[]|select(.id==\"$id\").in")" "$(j ".chat[]|select(.id==\"$id\").out")" \
        "$(j ".chat[]|select(.id==\"$id\").ctx")" "$(j ".chat[]|select(.id==\"$id\").tag // \"\"")" >&"$TTY"
    else
      printf "  %d) %-26s \$%s per 1M  · %sd %s\n" "$i" "$id" \
        "$(j ".embed[]|select(.id==\"$id\").price")" "$(j ".embed[]|select(.id==\"$id\").dim")" \
        "$(j ".embed[]|select(.id==\"$id\").tag // \"\"")" >&"$TTY"
    fi
    i=$((i+1))
  done
  n="${#ids[@]}"
  choice="$(ask "select" "1")"
  case "$choice" in (*[!0-9]*|"") choice=1 ;; esac
  [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ] || choice=1
  printf "%s" "${ids[$((choice-1))]}"
}

CHAT_ID="$(pick_model chat)"
EMBED_ID="$(pick_model embed)"
CHAT_MODEL="$(j ".chat[]|select(.id==\"$CHAT_ID\").model")"
EMBED_MODEL="$(j ".embed[]|select(.id==\"$EMBED_ID\").model")"
EMBED_DIM="$(j ".embed[]|select(.id==\"$EMBED_ID\").dim")"
ok "provider=$PROVIDER  chat=$CHAT_ID  embed=$EMBED_ID (${EMBED_DIM}d)"

# ---- 3. OpenViking (+ boto3 for bedrock) -----------------------------------
if command -v openviking-server >/dev/null 2>&1 && [ "$PROVIDER" != bedrock ]; then
  ok "OpenViking already installed"
else
  say "installing OpenViking${PROVIDER:+ ($PROVIDER)}"
  if [ "$PROVIDER" = bedrock ]; then
    uv tool install --with boto3 "$OPENVIKING_PIN" || die "uv tool install (with boto3) failed"
  else
    command -v openviking-server >/dev/null 2>&1 || uv tool install "$OPENVIKING_PIN" || die "uv tool install failed"
  fi
  export PATH="$BIN:$PATH"
  command -v openviking-server >/dev/null 2>&1 || die "openviking-server not on PATH (add $BIN)"
  ok "OpenViking ready"
fi

# ---- 4. auth ----------------------------------------------------------------
OPENAI_KEY=""; AWS_TOKEN=""; AWS_REGION_V=""
if [ "$PROVIDER" = openai ]; then
  validate_openai() {  # $1 key
    local cc ec
    cc="$(curl -s -o /tmp/ovm_c.json -w '%{http_code}' -m 30 https://api.openai.com/v1/chat/completions \
      -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
      -d "{\"model\":\"$CHAT_MODEL\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}]}" 2>/dev/null || echo 000)"
    if [ "$cc" != 200 ]; then
      grep -q "model.request" /tmp/ovm_c.json 2>/dev/null \
        && warn "key is missing the model.request (chat) scope" \
        || warn "chat check failed (HTTP $cc): $(jq -r '.error.message//empty' /tmp/ovm_c.json 2>/dev/null|head -c 100)"
      return 1
    fi
    ec="$(curl -s -o /tmp/ovm_e.json -w '%{http_code}' -m 30 https://api.openai.com/v1/embeddings \
      -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
      -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"ok\"}" 2>/dev/null || echo 000)"
    [ "$ec" = 200 ] || { warn "embeddings check failed (HTTP $ec)"; return 1; }
    return 0
  }
  if [ -z "$TTY" ]; then
    OPENAI_KEY="${OPENAI_API_KEY:-}"; [ -n "$OPENAI_KEY" ] || die "headless: set OPENAI_API_KEY"
    validate_openai "$OPENAI_KEY" || die "OPENAI_API_KEY failed validation"
  else
    say "OpenAI key (needs embedding + model.request scopes; hidden input)"
    for _t in 1 2 3; do
      OPENAI_KEY="$(ask_secret "   paste key")"
      [ -n "$OPENAI_KEY" ] && validate_openai "$OPENAI_KEY" && break || OPENAI_KEY=""
      [ "$_t" = 3 ] && die "key validation failed 3x. Use a standard key with full model permissions."
    done
  fi
  rm -f /tmp/ovm_c.json /tmp/ovm_e.json
  ok "OpenAI key validated (chat + embeddings)"
else
  # bedrock: bearer token + region. Validated by the round-trip below (uses the venv).
  AWS_REGION_V="${AWS_REGION:-$(ask "AWS region" "us-east-1")}"
  if [ -z "$TTY" ]; then
    AWS_TOKEN="${AWS_BEARER_TOKEN_BEDROCK:-}"; [ -n "$AWS_TOKEN" ] || die "headless: set AWS_BEARER_TOKEN_BEDROCK"
  else
    AWS_TOKEN="$(ask_secret "   Bedrock API key (bearer token)")"
    [ -n "$AWS_TOKEN" ] || die "no Bedrock API key given"
  fi
  ok "Bedrock: region=$AWS_REGION_V (token will be verified by the round-trip)"
fi

# ---- 5. ov.conf -------------------------------------------------------------
say "writing $OV_CONF"
mkdir -p "$OV_DIR" "$WORKSPACE"
[ -f "$OV_CONF" ] && { cp "$OV_CONF" "$OV_CONF.ovmem.bak"; warn "backed up ov.conf -> $OV_CONF.ovmem.bak"; }
ROOTKEY="$(openssl rand -hex 16 2>/dev/null || echo ov-local-dev-key)"
if [ "$PROVIDER" = openai ]; then
  jq -n --arg key "$OPENAI_KEY" --arg ws "$WORKSPACE" --arg rk "$ROOTKEY" \
        --arg cm "$CHAT_MODEL" --arg em "$EMBED_MODEL" --argjson dim "$EMBED_DIM" '{
    storage:{workspace:$ws}, server:{host:"127.0.0.1",port:1933,root_api_key:$rk},
    embedding:{dense:{provider:"openai",model:$em,api_key:$key,api_base:"https://api.openai.com/v1",dimension:$dim}},
    vlm:{provider:"openai",model:$cm,api_key:$key,api_base:"https://api.openai.com/v1",temperature:0.0,max_tokens:16384,max_retries:2},
    output_language_override:"en"
  }' > "$OV_CONF"
else
  # bedrock via litellm: creds come from the server env (set in the wrapper), not ov.conf.
  # api_key is a placeholder so is_available() passes; the bedrock/ prefix makes litellm skip it.
  jq -n --arg ws "$WORKSPACE" --arg rk "$ROOTKEY" \
        --arg cm "$CHAT_MODEL" --arg em "$EMBED_MODEL" --argjson dim "$EMBED_DIM" '{
    storage:{workspace:$ws}, server:{host:"127.0.0.1",port:1933,root_api_key:$rk},
    embedding:{dense:{provider:"litellm",model:$em,api_key:"bedrock",dimension:$dim}},
    vlm:{provider:"litellm",model:$cm,api_key:"bedrock",temperature:0.0,max_tokens:8192,max_retries:2},
    output_language_override:"en"
  }' > "$OV_CONF"
fi
chmod 600 "$OV_CONF"
ok "ov.conf written (chmod 600; keep it private)"

# ---- 6. server wrapper (+ bedrock env) + (re)start -------------------------
say "installing server bootstrap + starting OpenViking"
mkdir -p "$BIN"
{
  echo '#!/usr/bin/env bash'
  echo '# Start OpenViking in the background if it is not already healthy.'
  if [ "$PROVIDER" = bedrock ]; then
    printf 'export AWS_BEARER_TOKEN_BEDROCK=%q\n' "$AWS_TOKEN"
    printf 'export AWS_REGION=%q\n' "$AWS_REGION_V"
    printf 'export AWS_DEFAULT_REGION=%q\n' "$AWS_REGION_V"
  fi
  echo 'if curl -sf http://127.0.0.1:1933/health > /dev/null 2>&1; then exit 0; fi'
  printf 'nohup "%s/openviking-server" --host 127.0.0.1 --port 1933 > /tmp/openviking.log 2>&1 &\n' "$BIN"
  echo 'echo $! > /tmp/openviking.pid'
} > "$BIN/openviking-start"
chmod 700 "$BIN/openviking-start"   # 700: may contain the bedrock token
PID="$(port_pid || true)"; [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
"$BIN/openviking-start"
curl -s --retry 30 --retry-delay 1 --retry-connrefused -m 60 "$HEALTH" >/dev/null 2>&1 \
  && ok "server healthy on 127.0.0.1:1933" || die "server did not become healthy; see /tmp/openviking.log"

# ---- 7. vendor scripts ------------------------------------------------------
say "installing ovmem engine into $OVMEM_DIR"
mkdir -p "$OVMEM_DIR/state"
cp "$PAYLOAD/ovmem.py"         "$OVMEM_DIR/ovmem.py"
cp "$PAYLOAD/ovmem-cleanup.py" "$OVMEM_DIR/ovmem-cleanup.py"
cp "$PAYLOAD/RUNTIME.md"       "$OVMEM_DIR/README.md" 2>/dev/null || true
ok "ovmem.py + ovmem-cleanup.py installed"

# ---- 8. wire the 4 hooks (idempotent) --------------------------------------
say "wiring hooks into $SETTINGS"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.ovmem.bak"
SS="python3 $OVMEM_DIR/ovmem.py --event session-start"
UP="python3 $OVMEM_DIR/ovmem.py --event user-prompt"
PC="python3 $OVMEM_DIR/ovmem.py --event pre-compact"
SE="python3 $OVMEM_DIR/ovmem.py --event session-end"
tmp="$(mktemp)"
jq --arg ss "$SS" --arg up "$UP" --arg pc "$PC" --arg se "$SE" '
  .hooks //= {} | .hooks.SessionStart //= [] | .hooks.UserPromptSubmit //= []
  | .hooks.PreCompact //= [] | .hooks.SessionEnd //= []
  | (if any(.hooks.SessionStart[]?.hooks[]?;   .command==$ss) then . else .hooks.SessionStart    += [{hooks:[{type:"command",command:$ss,timeout:12}]}] end)
  | (if any(.hooks.UserPromptSubmit[]?.hooks[]?;.command==$up) then . else .hooks.UserPromptSubmit += [{hooks:[{type:"command",command:$up,timeout:12}]}] end)
  | (if any(.hooks.PreCompact[]?.hooks[]?;     .command==$pc) then . else .hooks.PreCompact      += [{hooks:[{type:"command",command:$pc,timeout:25}]}] end)
  | (if any(.hooks.SessionEnd[]?.hooks[]?;     .command==$se) then . else .hooks.SessionEnd      += [{hooks:[{type:"command",command:$se,timeout:25}]}] end)
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
ok "4 hooks wired (backup at $SETTINGS.ovmem.bak)"

# ---- 9. round-trip verify ---------------------------------------------------
say "verifying end-to-end (commit -> extract)"
H=(-H "x-api-key: $ROOTKEY" -H "X-OpenViking-Account: default" -H "X-OpenViking-User: ${USER:-default}" -H "X-OpenViking-Agent: claude-code" -H "Content-Type: application/json")
SID="ovmem-install-check"
curl -s -m 10 -X POST "${H[@]}" -d "{\"session_id\":\"$SID\"}" "$API/sessions" >/dev/null 2>&1 || true
curl -s -m 12 -X POST "${H[@]}" -d '{"messages":[{"role":"user","content":"Install check: I prefer concise answers."},{"role":"assistant","content":"Noted."}]}' "$API/sessions/$SID/messages/batch" >/dev/null 2>&1 || true
EXTRACT="$(curl -s -m 150 -X POST "${H[@]}" "$API/sessions/$SID/extract" 2>/dev/null || echo '{}')"
curl -s -m 8 -X DELETE "${H[@]}" "$API/sessions/$SID" >/dev/null 2>&1 || true
if echo "$EXTRACT" | jq -e '.status=="ok"' >/dev/null 2>&1; then
  ok "extraction works (memories: $(echo "$EXTRACT" | jq '.result|if type=="array" then length else . end' 2>/dev/null))"
else
  warn "extraction did not confirm. Last server errors:"
  grep -iE "error|denied|expired|invalid|bedrock|token|scope" /tmp/openviking.log 2>/dev/null | tail -3 | sed 's/^/     /' || true
  [ "$PROVIDER" = bedrock ] && warn "for Bedrock: check the API key, the region, and that the model is enabled in AWS Bedrock model access."
fi

# ---- done -------------------------------------------------------------------
[ -n "$TTY" ] && exec 3>&- || true
echo
ok "ovmem installed ($PROVIDER · $CHAT_ID · $EMBED_ID). It activates on your NEXT Claude Code session."
echo "   off: OVMEM_DISABLE=1   ·   debug: OVMEM_DEBUG=1 (~/.claude/ovmem/ovmem.log)   ·   prune: python3 $OVMEM_DIR/ovmem-cleanup.py"
