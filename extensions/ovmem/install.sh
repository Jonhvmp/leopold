#!/usr/bin/env bash
# ovmem installer / reconfigure — pick a provider + models, set everything up, and
# switch safely between providers (incl. re-embedding the memory store when the
# embedding model changes).
#
# HARNESS PARITY. The same four hooks are declared once per harness on this machine —
# ~/.claude/settings.json (JSON) and ~/.codex/config.toml (TOML) — through the one
# shared writer in ../lib/harness.sh. This file decides WHAT to wire, never HOW to
# spell it. The engine and its state live in ONE dir for the machine (leo_ovmem_dir),
# because the memory is about the user, not about the agent they happened to open.
#
# Providers:
#   openai   - one API key (needs embedding + model.request scopes).
#   bedrock  - AWS Bedrock via LiteLLM; auth = a Bedrock API key (bearer) + region.
#
# Re-running detects the current install: it offers to reuse the existing credential,
# defaults each prompt to the current choice, and — if you change the embedding model —
# rebuilds the vector index for the new dimension (your memory CONTENT is preserved;
# only the index is re-embedded). The old index is backed up and restored if the rebuild
# fails. Server restarts are lock-aware (one OpenViking process per data dir).
#
# Interactive prompts read /dev/tty (works under `curl … | bash`). Headless: set
# OVMEM_PROVIDER, OVMEM_CHAT_MODEL, OVMEM_EMBED_MODEL + OPENAI_API_KEY (openai) or
# AWS_BEARER_TOKEN_BEDROCK + AWS_REGION (bedrock).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/payload"; MODELS="$HERE/models.json"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "ovmem/install.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"
OVMEM_DIR="$(leo_ovmem_dir)"
OV_DIR="$HOME/.openviking"; OV_CONF="$OV_DIR/ov.conf"; WORKSPACE="$OV_DIR/data"; VDB="$WORKSPACE/vectordb"
BIN="$HOME/.local/bin"; HEALTH="http://127.0.0.1:1933/health"; API="http://127.0.0.1:1933/api/v1"
OPENVIKING_PIN="openviking==0.3.21"

say()  { printf "\033[36m->\033[0m %s\n" "$*"; }
ok()   { printf "   \033[32mok\033[0m   %s\n" "$*"; }
warn() { printf "   \033[33mwarn\033[0m %s\n" "$*"; }
die()  { printf "\033[31mx\033[0m %s\n" "$*" >&2; exit 1; }

TTY=""; if exec 3<>/dev/tty 2>/dev/null; then TTY=3; fi
ask() { local p="$1" d="${2:-}" a=""
  if [ -n "$TTY" ]; then
    if [ -n "$d" ]; then printf "%s [%s]: " "$p" "$d" >&"$TTY"; else printf "%s: " "$p" >&"$TTY"; fi
    IFS= read -r a <&"$TTY" || a=""; [ -z "$a" ] && a="$d"
  else a="$d"; fi
  printf "%s" "$a"; }
ask_secret() { local p="$1" a=""
  if [ -n "$TTY" ]; then printf "%s: " "$p" >&"$TTY"; IFS= read -rs a <&"$TTY" || a=""; printf "\n" >&"$TTY"; fi
  printf "%s" "$a"; }
confirm() { case "$(ask "$1 [Y/n]" "Y")" in [nN]*) return 1;; *) return 0;; esac; }
j() { jq -r "$1" "$MODELS"; }

# Run a command with a live "<label>… Ns" spinner so a long, silent step never looks
# frozen — even when it's really a background download/reindex. stdout+stderr are captured
# to SPIN_OUT so callers can use the output (or print it on failure). Headless: one line.
SPIN_OUT=""
run_spin() {
  local label="$1"; shift
  local tmp; tmp="$(mktemp 2>/dev/null || echo "/tmp/ovm_spin.$$")"
  ( "$@" >"$tmp" 2>&1 ) & local pid=$!
  if [ -n "$TTY" ]; then
    local i=0 t0=$SECONDS f='|/-\'
    while kill -0 "$pid" 2>/dev/null; do
      printf "\r   \033[2m%s %s… %ds\033[0m" "${f:i%4:1}" "$label" "$((SECONDS-t0))" >&"$TTY"
      i=$((i+1)); sleep 0.2
    done
    printf "\r\033[K" >&"$TTY"
  else
    printf "   ... %s (running)\n" "$label"
  fi
  local rc=0; wait "$pid" || rc=$?
  SPIN_OUT="$(cat "$tmp" 2>/dev/null || true)"; rm -f "$tmp"
  return "$rc"
}

# ---- platform + server lifecycle (lock-aware) ------------------------------
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux|Darwin) : ;;
  MINGW*|MSYS*|CYGWIN*|Windows*) die "Native Windows is not supported. Run inside WSL." ;;
  *) warn "unrecognized OS '$(uname -s 2>/dev/null)'; only Linux/macOS are tested." ;;
esac
port_pid() { if command -v lsof >/dev/null 2>&1; then lsof -ti tcp:1933 2>/dev/null | head -1
  elif command -v ss >/dev/null 2>&1; then ss -tlnp 2>/dev/null | grep ':1933' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1; fi; }
server_pids() { pgrep -f "bin/openviking-server" 2>/dev/null || true; }
# Stop EVERY OpenViking process and wait until the data-dir lock is free. Running two
# instances on one data dir is forbidden (DataDirectoryLocked); a kill + instant restart
# races the lock, so we wait for the process to actually die.
stop_server() {
  local p _; p="$(server_pids)"; [ -n "$p" ] && kill $p 2>/dev/null || true
  for _ in $(seq 1 40); do [ -z "$(server_pids)" ] && [ -z "$(port_pid || true)" ] && break; sleep 0.4; done
  p="$(server_pids)"; [ -n "$p" ] && kill -9 $p 2>/dev/null || true
  for _ in $(seq 1 10); do [ -z "$(server_pids)" ] && break; sleep 0.3; done
  rm -f /tmp/openviking.pid "$WORKSPACE/.openviking.pid" 2>/dev/null || true
}
start_server() {
  "$BIN/openviking-start"
  run_spin "waiting for OpenViking to be healthy" \
    curl -s --retry 40 --retry-delay 1 --retry-connrefused -m 80 "$HEALTH" \
    || die "OpenViking did not become healthy; see /tmp/openviking.log"
}

# ---- detect the current install --------------------------------------------
CUR_PROVIDER=""; CUR_CHAT_MODEL=""; CUR_EMBED_MODEL=""; CUR_DIM=""; CUR_ROOTKEY=""
CUR_OPENAI_KEY=""; CUR_AWS_TOKEN=""; CUR_AWS_REGION=""; CUR_CHAT_ID=""; CUR_EMBED_ID=""
read_current() {
  [ -f "$OV_CONF" ] && command -v jq >/dev/null 2>&1 || return 0
  CUR_CHAT_MODEL="$(jq -r '.vlm.model // empty' "$OV_CONF" 2>/dev/null)"
  CUR_EMBED_MODEL="$(jq -r '.embedding.dense.model // empty' "$OV_CONF" 2>/dev/null)"
  CUR_DIM="$(jq -r '.embedding.dense.dimension // empty' "$OV_CONF" 2>/dev/null)"
  CUR_ROOTKEY="$(jq -r '.server.root_api_key // empty' "$OV_CONF" 2>/dev/null)"
  case "$CUR_CHAT_MODEL" in bedrock/*) CUR_PROVIDER=bedrock ;; ?*) CUR_PROVIDER=openai ;; esac
  [ "$CUR_PROVIDER" = openai ] && CUR_OPENAI_KEY="$(jq -r '.vlm.api_key // empty' "$OV_CONF" 2>/dev/null)"
  CUR_CHAT_ID="$(j ".chat[]|select(.model==\"$CUR_CHAT_MODEL\").id" 2>/dev/null | head -1)"
  CUR_EMBED_ID="$(j ".embed[]|select(.model==\"$CUR_EMBED_MODEL\").id" 2>/dev/null | head -1)"
  if [ -f "$BIN/openviking-start" ]; then
    CUR_AWS_TOKEN="$( (eval "$(grep '^export AWS_BEARER_TOKEN_BEDROCK=' "$BIN/openviking-start" 2>/dev/null)"; printf '%s' "${AWS_BEARER_TOKEN_BEDROCK:-}") )"
    CUR_AWS_REGION="$( (eval "$(grep '^export AWS_REGION=' "$BIN/openviking-start" 2>/dev/null)"; printf '%s' "${AWS_REGION:-}") )"
  fi
}
read_current

# ---- prereqs ---------------------------------------------------------------
say "checking prerequisites"
command -v curl    >/dev/null 2>&1 || die "curl is required"
command -v jq      >/dev/null 2>&1 || die "jq is required (https://jqlang.github.io/jq/)"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
[ -f "$MODELS" ]   || die "models.json not found next to the installer"
if ! command -v uv >/dev/null 2>&1; then
  warn "uv not found - installing it"; curl -LsSf https://astral.sh/uv/install.sh | sh || die "uv install failed"; export PATH="$HOME/.local/bin:$PATH"
fi
ok "curl, jq, python3, uv present"
[ -n "$CUR_PROVIDER" ] && say "current ovmem: provider=$CUR_PROVIDER  chat=${CUR_CHAT_ID:-$CUR_CHAT_MODEL}  embed=${CUR_EMBED_ID:-$CUR_EMBED_MODEL} (${CUR_DIM}d)"

# ---- pick provider + models (default to current) ---------------------------
PROVIDER="${OVMEM_PROVIDER:-}"
if [ -z "$PROVIDER" ]; then
  if [ -n "$TTY" ]; then
    pdef=1; [ "$CUR_PROVIDER" = bedrock ] && pdef=2
    om=""; [ "$CUR_PROVIDER" = openai ] && om=" (current)"; bm=""; [ "$CUR_PROVIDER" = bedrock ] && bm=" (current)"
    printf "\nProvider:\n  1) openai%s\n  2) bedrock%s\n" "$om" "$bm" >&"$TTY"
    case "$(ask "select" "$pdef")" in 2|bedrock) PROVIDER=bedrock ;; *) PROVIDER=openai ;; esac
  else die "headless: set OVMEM_PROVIDER=openai|bedrock"; fi
fi
[ "$PROVIDER" = openai ] || [ "$PROVIDER" = bedrock ] || die "unknown provider: $PROVIDER"

pick_model() {  # $1 kind  $2 default_id -> echoes chosen id
  local kind="$1" defid="${2:-}" preset="" i n choice line defnum=1 id mark
  local ids=()
  case "$kind" in chat) preset="${OVMEM_CHAT_MODEL:-}";; embed) preset="${OVMEM_EMBED_MODEL:-}";; esac
  while IFS= read -r line; do [ -n "$line" ] && ids+=("$line"); done < <(j ".${kind}[] | select(.provider==\"$PROVIDER\") | .id")
  [ "${#ids[@]}" -gt 0 ] || die "no $kind models for provider $PROVIDER in models.json"
  if [ -n "$preset" ]; then printf "%s" "$preset"; return; fi
  if [ -z "$TTY" ]; then die "headless: set OVMEM_$(printf '%s' "$kind" | tr '[:lower:]' '[:upper:]')_MODEL (one of: ${ids[*]})"; fi
  i=1; for id in "${ids[@]}"; do [ "$id" = "$defid" ] && defnum=$i; i=$((i+1)); done
  printf "\n%s model:\n" "$kind" >&"$TTY"; i=1
  for id in "${ids[@]}"; do
    mark=""; [ "$id" = "$defid" ] && mark=" (current)"
    if [ "$kind" = chat ]; then
      printf "  %d) %-22s \$%s in / \$%s out per 1M%s\n" "$i" "$id" "$(j ".chat[]|select(.id==\"$id\").in")" "$(j ".chat[]|select(.id==\"$id\").out")" "$mark" >&"$TTY"
    else
      printf "  %d) %-26s \$%s per 1M · %sd%s\n" "$i" "$id" "$(j ".embed[]|select(.id==\"$id\").price")" "$(j ".embed[]|select(.id==\"$id\").dim")" "$mark" >&"$TTY"
    fi
    i=$((i+1))
  done
  n="${#ids[@]}"; choice="$(ask "select" "$defnum")"
  case "$choice" in (*[!0-9]*|"") choice=$defnum ;; esac
  [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ] || choice=$defnum
  printf "%s" "${ids[$((choice-1))]}"
}

[ "$PROVIDER" = "$CUR_PROVIDER" ] && DEF_CHAT="$CUR_CHAT_ID" && DEF_EMBED="$CUR_EMBED_ID" || { DEF_CHAT=""; DEF_EMBED=""; }
CHAT_ID="$(pick_model chat "$DEF_CHAT")"
EMBED_ID="$(pick_model embed "$DEF_EMBED")"
CHAT_MODEL="$(j ".chat[]|select(.id==\"$CHAT_ID\").model")"
EMBED_MODEL="$(j ".embed[]|select(.id==\"$EMBED_ID\").model")"
EMBED_DIM="$(j ".embed[]|select(.id==\"$EMBED_ID\").dim")"
ok "provider=$PROVIDER  chat=$CHAT_ID  embed=$EMBED_ID (${EMBED_DIM}d)"

# ---- decide if the memory index must be rebuilt ----------------------------
REINDEX=0
if [ -d "$VDB" ] && [ -n "$CUR_EMBED_MODEL" ] && { [ "$EMBED_MODEL" != "$CUR_EMBED_MODEL" ] || [ "$EMBED_DIM" != "$CUR_DIM" ]; }; then
  REINDEX=1
  warn "embedding is changing: $CUR_EMBED_MODEL (${CUR_DIM}d) -> $EMBED_MODEL (${EMBED_DIM}d)."
  warn "your memories stay; the vector index is rebuilt (re-embedded in the new model's space)."
  [ -n "$TTY" ] && { confirm "proceed with the switch + rebuild?" || die "aborted; nothing changed."; }
fi

# ---- OpenViking (+ boto3 for bedrock) --------------------------------------
# First install downloads ~140 packages (OpenViking + LiteLLM + deps); warn so the long,
# quiet uv resolve/download step doesn't look frozen. Re-runs are near-instant.
ov_hint() { printf "   \033[2m(downloading OpenViking + ~140 packages — up to a few minutes on first install)\033[0m\n"; }
uv_fail() { [ -n "$SPIN_OUT" ] && printf '%s\n' "$SPIN_OUT" | tail -5 | sed 's/^/     /'; die "$1"; }
if [ "$PROVIDER" = bedrock ]; then
  say "ensuring OpenViking + boto3 (Bedrock)"
  command -v openviking-server >/dev/null 2>&1 || ov_hint
  run_spin "downloading OpenViking + boto3" uv tool install --with boto3 "$OPENVIKING_PIN" \
    || uv_fail "uv tool install (with boto3) failed"
elif ! command -v openviking-server >/dev/null 2>&1; then
  say "installing OpenViking"; ov_hint
  run_spin "downloading OpenViking + deps" uv tool install "$OPENVIKING_PIN" \
    || uv_fail "uv tool install failed"
fi
export PATH="$BIN:$PATH"
command -v openviking-server >/dev/null 2>&1 || die "openviking-server not on PATH (add $BIN)"
ok "OpenViking ready"

# ---- auth (reuse existing credential when possible) ------------------------
OPENAI_KEY=""; AWS_TOKEN=""; AWS_REGION_V=""
validate_openai() { local cc ec
  cc="$(curl -s -o /tmp/ovm_c.json -w '%{http_code}' -m 30 https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
    -d "{\"model\":\"$CHAT_MODEL\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}]}" 2>/dev/null || echo 000)"
  if [ "$cc" != 200 ]; then grep -q "model.request" /tmp/ovm_c.json 2>/dev/null && warn "key missing the model.request (chat) scope" || warn "chat check failed (HTTP $cc)"; return 1; fi
  ec="$(curl -s -o /tmp/ovm_e.json -w '%{http_code}' -m 30 https://api.openai.com/v1/embeddings \
    -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"ok\"}" 2>/dev/null || echo 000)"
  [ "$ec" = 200 ] || { warn "embeddings check failed (HTTP $ec)"; return 1; }; return 0; }

if [ "$PROVIDER" = openai ]; then
  if [ -n "$CUR_OPENAI_KEY" ] && [ "$CUR_OPENAI_KEY" != bedrock ] && validate_openai "$CUR_OPENAI_KEY" && { [ -z "$TTY" ] || confirm "reuse the existing OpenAI key?"; }; then
    OPENAI_KEY="$CUR_OPENAI_KEY"; ok "reusing the existing OpenAI key (validated)"
  elif [ -z "$TTY" ]; then
    OPENAI_KEY="${OPENAI_API_KEY:-}"; [ -n "$OPENAI_KEY" ] || die "headless: set OPENAI_API_KEY"
    validate_openai "$OPENAI_KEY" || die "OPENAI_API_KEY failed validation"; ok "key validated"
  else
    say "OpenAI key (needs embedding + model.request scopes; hidden)"
    for _t in 1 2 3; do OPENAI_KEY="$(ask_secret "   paste key")"
      [ -n "$OPENAI_KEY" ] && validate_openai "$OPENAI_KEY" && { ok "key validated"; break; } || OPENAI_KEY=""
      [ "$_t" = 3 ] && die "key validation failed 3x."; done
  fi
  rm -f /tmp/ovm_c.json /tmp/ovm_e.json
else
  AWS_REGION_V="${AWS_REGION:-${CUR_AWS_REGION:-}}"; [ -n "$AWS_REGION_V" ] || AWS_REGION_V="$(ask "AWS region" "us-east-1")"
  if [ -n "$CUR_AWS_TOKEN" ] && { [ -z "$TTY" ] || confirm "reuse the existing Bedrock API key?"; }; then
    AWS_TOKEN="$CUR_AWS_TOKEN"; ok "reusing the existing Bedrock API key"
  elif [ -z "$TTY" ]; then
    AWS_TOKEN="${AWS_BEARER_TOKEN_BEDROCK:-}"; [ -n "$AWS_TOKEN" ] || die "headless: set AWS_BEARER_TOKEN_BEDROCK"
  else
    AWS_TOKEN="$(ask_secret "   Bedrock API key (bearer token)")"; [ -n "$AWS_TOKEN" ] || die "no Bedrock API key given"
  fi
  ok "Bedrock region=$AWS_REGION_V (verified by the round-trip below)"
fi

# ---- ov.conf (preserve the root key on reconfigure) ------------------------
say "writing $OV_CONF"
mkdir -p "$OV_DIR" "$WORKSPACE"
[ -f "$OV_CONF" ] && cp "$OV_CONF" "$OV_CONF.ovmem.bak"
ROOTKEY="${CUR_ROOTKEY:-$(openssl rand -hex 16 2>/dev/null || echo ov-local-dev-key)}"
if [ "$PROVIDER" = openai ]; then
  jq -n --arg key "$OPENAI_KEY" --arg ws "$WORKSPACE" --arg rk "$ROOTKEY" --arg cm "$CHAT_MODEL" --arg em "$EMBED_MODEL" --argjson dim "$EMBED_DIM" '{
    storage:{workspace:$ws}, server:{host:"127.0.0.1",port:1933,root_api_key:$rk},
    embedding:{dense:{provider:"openai",model:$em,api_key:$key,api_base:"https://api.openai.com/v1",dimension:$dim}},
    vlm:{provider:"openai",model:$cm,api_key:$key,api_base:"https://api.openai.com/v1",temperature:0.0,max_tokens:16384,max_retries:2},
    output_language_override:"en"}' > "$OV_CONF"
else
  jq -n --arg ws "$WORKSPACE" --arg rk "$ROOTKEY" --arg cm "$CHAT_MODEL" --arg em "$EMBED_MODEL" --argjson dim "$EMBED_DIM" '{
    storage:{workspace:$ws}, server:{host:"127.0.0.1",port:1933,root_api_key:$rk},
    embedding:{dense:{provider:"litellm",model:$em,api_key:"bedrock",dimension:$dim}},
    vlm:{provider:"litellm",model:$cm,api_key:"bedrock",temperature:0.0,max_tokens:8192,max_retries:2},
    output_language_override:"en"}' > "$OV_CONF"
fi
chmod 600 "$OV_CONF"; ok "ov.conf written (chmod 600)"

# ---- server bootstrap wrapper (+ bedrock env) ------------------------------
mkdir -p "$BIN"
{ echo '#!/usr/bin/env bash'; echo '# Start OpenViking in the background if not already healthy.'
  if [ "$PROVIDER" = bedrock ]; then printf 'export AWS_BEARER_TOKEN_BEDROCK=%q\n' "$AWS_TOKEN"; printf 'export AWS_REGION=%q\n' "$AWS_REGION_V"; printf 'export AWS_DEFAULT_REGION=%q\n' "$AWS_REGION_V"; fi
  echo 'if curl -sf http://127.0.0.1:1933/health > /dev/null 2>&1; then exit 0; fi'
  printf 'nohup "%s/openviking-server" --host 127.0.0.1 --port 1933 > /tmp/openviking.log 2>&1 &\n' "$BIN"
  echo 'echo $! > /tmp/openviking.pid'; } > "$BIN/openviking-start"
chmod 700 "$BIN/openviking-start"

# ---- apply: stop (lock-safe) -> (rebuild index if needed) -> start ----------
H=(-H "x-api-key: $ROOTKEY" -H "X-OpenViking-Account: default" -H "X-OpenViking-User: ${USER:-default}" -H "X-OpenViking-Agent: claude-code" -H "Content-Type: application/json")
say "restarting OpenViking with the new config"
stop_server
if [ "$REINDEX" = 1 ] && [ -d "$VDB" ]; then
  rm -rf "$VDB.ovmem.bak"; cp -r "$VDB" "$VDB.ovmem.bak"; rm -rf "$VDB"
  warn "index backed up to $VDB.ovmem.bak and dropped (memory content untouched)"
fi
start_server
ok "server healthy on 127.0.0.1:1933"

if [ "$REINDEX" = 1 ]; then
  say "re-embedding your memories with $EMBED_ID (content preserved)"
  run_spin "re-embedding memories" \
    curl -s -m 600 -X POST "${H[@]}" -d '{"uri":"viking://","wait":true}' "$API/content/reindex" || true
  R="$SPIN_OUT"; [ -n "$R" ] || R='{}'
  if echo "$R" | jq -e '(.result.status=="completed") and ((.result.failed_records // 0)==0)' >/dev/null 2>&1; then
    ok "reindex complete ($(echo "$R" | jq -r '.result.rebuilt_records // 0') records re-embedded)"
    rm -rf "$VDB.ovmem.bak"
  else
    warn "reindex did not complete cleanly — restoring the previous index"
    stop_server; rm -rf "$VDB"; [ -d "$VDB.ovmem.bak" ] && mv "$VDB.ovmem.bak" "$VDB"
    cp "$OV_CONF.ovmem.bak" "$OV_CONF" 2>/dev/null || true; start_server
    die "the embedding switch failed; your previous setup ($CUR_PROVIDER/$CUR_EMBED_ID) was restored. See /tmp/openviking.log"
  fi
fi

# ---- vendor scripts + wire hooks (idempotent) ------------------------------
say "installing ovmem engine + hooks"
mkdir -p "$OVMEM_DIR/state"
cp "$PAYLOAD/ovmem.py" "$OVMEM_DIR/ovmem.py"; cp "$PAYLOAD/ovmem-cleanup.py" "$OVMEM_DIR/ovmem-cleanup.py"
cp "$PAYLOAD/dashboard.py" "$OVMEM_DIR/dashboard.py" 2>/dev/null || true
cp "$PAYLOAD/RUNTIME.md" "$OVMEM_DIR/README.md" 2>/dev/null || true

# The same four events exist on both harnesses; only the SessionEnd timeout differs.
# codex-cli 0.146.0 hard-caps a SessionEnd hook at 3s and prints
# `clamping SessionEnd hook timeout to 3s` for anything higher — verified by writing
# 4 and 6 into a temp config.toml and reading the warning back. So we declare the 3
# it will actually honor instead of a 25 it silently rewrites, and ovmem.py hands the
# session-end flush to a detached child on Codex so the work survives the kill.
ovmem_specs() { # <harness>
  printf '%s\n' "SessionStart||python3 $OVMEM_DIR/ovmem.py --event session-start|12"
  printf '%s\n' "UserPromptSubmit||python3 $OVMEM_DIR/ovmem.py --event user-prompt|12"
  printf '%s\n' "PreCompact||python3 $OVMEM_DIR/ovmem.py --event pre-compact|25"
  case "$1" in
    codex) printf '%s\n' "SessionEnd||python3 $OVMEM_DIR/ovmem.py --event session-end|3" ;;
    *)     printf '%s\n' "SessionEnd||python3 $OVMEM_DIR/ovmem.py --event session-end|25" ;;
  esac
}

for h in $(leo_harness_targets); do
  specs=(); while IFS= read -r line; do specs+=("$line"); done < <(ovmem_specs "$h")
  # `|| wired=0` and not a bare `&&`: under `set -e` a failed wiring would otherwise
  # abort the installer mid-way, right after it has already vendored the engine.
  wired=1
  case "$h" in
    claude) leo_wire_hooks_json "$(leo_settings_file)" ovmem "${specs[@]}" >/dev/null || wired=0 ;;
    codex)  LEO_TOML_COMMENT="# ovmem (Leopold extension). Autonomous long-term memory: recalls what you have
# already decided before each turn and distils each session into OpenViking
# (127.0.0.1:1933) afterwards. Every hook is a silent no-op when the local
# OpenViking server is down, and OVMEM_DISABLE=1 turns the whole thing off." \
            leo_wire_hooks_toml "$(leo_config_file)" ovmem "${specs[@]}" >/dev/null || wired=0 ;;
  esac
  if [ "$wired" = 1 ]; then
    ok "$(leo_harness_label "$h"): 4 hooks wired (SessionStart, UserPromptSubmit, PreCompact, SessionEnd)"
  else
    warn "$(leo_harness_label "$h"): could not wire the ovmem hooks — see the warning above"
  fi
done
ok "engine installed at $OVMEM_DIR"
if leo_has_harness codex; then
  say "Codex keeps a config-declared hook inert until you approve it once — open Codex and accept them."
fi

# ---- round-trip verify ------------------------------------------------------
say "verifying end-to-end (commit -> extract)"
SID="ovmem-install-check"
curl -s -m 10 -X POST "${H[@]}" -d "{\"session_id\":\"$SID\"}" "$API/sessions" >/dev/null 2>&1 || true
curl -s -m 12 -X POST "${H[@]}" -d '{"messages":[{"role":"user","content":"Install check: I prefer concise answers."},{"role":"assistant","content":"Noted."}]}' "$API/sessions/$SID/messages/batch" >/dev/null 2>&1 || true
run_spin "extracting memories (this can take up to ~2 min)" \
  curl -s -m 150 -X POST "${H[@]}" "$API/sessions/$SID/extract" || true
EXTRACT="$SPIN_OUT"; [ -n "$EXTRACT" ] || EXTRACT='{}'
curl -s -m 8 -X DELETE "${H[@]}" "$API/sessions/$SID" >/dev/null 2>&1 || true
if echo "$EXTRACT" | jq -e '.status=="ok"' >/dev/null 2>&1; then
  ok "extraction works (memories: $(echo "$EXTRACT" | jq '.result|if type=="array" then length else . end' 2>/dev/null))"
else
  warn "extraction did not confirm. Last server errors:"
  grep -iE "error|denied|expired|invalid|bedrock|token|scope|mismatch" /tmp/openviking.log 2>/dev/null | tail -3 | sed 's/^/     /' || true
  [ "$PROVIDER" = bedrock ] && warn "Bedrock: check the API key, the region, and that the model is enabled in AWS Bedrock model access."
fi

[ -n "$TTY" ] && exec 3>&- || true
echo
_labels=""; for h in $(leo_harness_targets); do _labels="${_labels:+$_labels + }$(leo_harness_label "$h")"; done
ok "ovmem ready ($PROVIDER · $CHAT_ID · $EMBED_ID). Active on your NEXT ${_labels:-agent} session."
echo "   off: OVMEM_DISABLE=1   ·   debug: OVMEM_DEBUG=1 ($OVMEM_DIR/ovmem.log)   ·   prune: python3 $OVMEM_DIR/ovmem-cleanup.py"
