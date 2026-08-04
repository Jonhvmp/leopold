#!/usr/bin/env bash
# ovmem extension - autonomous RAG long-term memory (OpenViking + 4 hooks), on every
# harness Leopold runs on.
#
# All subcommands are real: detect / status / doctor probe a live install;
# install / update run the full installer (also the reconfigure / provider-switch path,
# with credential reuse + a safe index rebuild); remove unwires the hooks from EVERY
# harness and deletes the engine, leaving your OpenViking server + memory data intact.
# See README.md in this folder.
#
# HARNESS PARITY. The four hooks are declared once per harness —
# ~/.claude/settings.json (JSON) and ~/.codex/config.toml (TOML) — through the one
# shared writer in ../lib/harness.sh. The DATA (engine, per-session commit offsets,
# access log) is a single directory for the whole machine, so a decision recorded in a
# Codex session comes back in a Claude Code one.
#
# Verified against codex-cli 0.146.0 with real sessions:
#   - SessionStart / UserPromptSubmit / SessionEnd payloads carry session_id,
#     transcript_path, cwd, hook_event_name (+ source, prompt) — every field the
#     engine reads.
#   - Codex validates hook stdout as strict JSON: plain text logs "Failed" and never
#     reaches the model, {"hookSpecificOutput":{...,"additionalContext":...}} logs
#     "Completed" and the model reads it back. ovmem.py emits per harness.
#   - Codex hard-caps SessionEnd hooks at 3s, so that one is declared as 3 and the
#     flush is handed to a detached child there.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "ovmem/manage.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"

OVMEM_DIR="$(leo_ovmem_dir)"
export LEOPOLD_OVMEM_DIR="$OVMEM_DIR"   # the engine and dashboard resolve the dir we did
OV_HEALTH="http://127.0.0.1:1933/health"
HOOK_MARK='ovmem.py --event'
HOOK_COUNT=4

server_up() { curl -s -m 2 "$OV_HEALTH" 2>/dev/null | grep -q '"healthy":true'; }

# Where each harness keeps the hooks we wire.
hooks_file() { # <harness>
  case "$1" in claude) leo_settings_file ;; codex) leo_config_file ;; esac
}

wired_count() { # <harness> -> how many ovmem hooks are declared there
  local f n; f="$(hooks_file "$1")"
  [ -f "$f" ] || { echo 0; return; }
  n="$(grep -c "$HOOK_MARK" "$f" 2>/dev/null || true)"
  echo "${n:-0}"
}

case "${1:-}" in
  detect)
    [ -f "$OVMEM_DIR/ovmem.py" ]
    ;;

  status)
    # One line (the menu renders it inline). The server half is machine-wide; the
    # wiring half is per harness, because that part genuinely differs.
    if [ -f "$OVMEM_DIR/ovmem.py" ]; then
      if server_up; then printf 'server up'; else printf 'server down'; fi
      for h in $(leo_harness_targets); do
        printf ' · %s: hooks %s/%s' "$(leo_harness_label "$h")" "$(wired_count "$h")" "$HOOK_COUNT"
      done
      echo
    else
      echo "not installed"
    fi
    ;;

  install|update)
    # install.sh is also the reconfigure/switch path: it detects the current setup,
    # offers to reuse the credential, and rebuilds the index when the embedding changes.
    bash "$HERE/install.sh"
    ;;

  remove)
    # Report per harness, and never let a failed unwire abort the removal (`set -e`
    # would otherwise leave the engine installed AND half its hooks declared).
    for h in $(leo_harness_targets); do
      unwired=1
      case "$h" in
        claude) leo_unwire_hooks_json "$(leo_settings_file)" ovmem "$HOOK_MARK" >/dev/null 2>&1 || unwired=0 ;;
        codex)  leo_unwire_hooks_toml "$(leo_config_file)" ovmem >/dev/null 2>&1 || unwired=0 ;;
      esac
      if [ "$unwired" = 1 ]; then
        echo "$(leo_harness_label "$h"): unwired the ovmem hooks"
      else
        echo "$(leo_harness_label "$h"): could NOT unwire the ovmem hooks — remove them by hand from $(hooks_file "$h")" >&2
      fi
    done
    rm -rf "$OVMEM_DIR"
    echo "removed $OVMEM_DIR"
    echo "left untouched: the OpenViking server + ~/.openviking (your memory data)."
    echo "to purge those too: uv tool uninstall openviking ; rm -rf ~/.openviking"
    ;;

  watch)
    # open the standalone ovmem dashboard (http://127.0.0.1:1934)
    [ -f "$OVMEM_DIR/dashboard.py" ] || { echo "dashboard not installed (run: manage.sh install)" >&2; exit 1; }
    shift 2>/dev/null || true
    exec python3 "$OVMEM_DIR/dashboard.py" "$@"
    ;;

  doctor)
    echo "engine:    $([ -f "$OVMEM_DIR/ovmem.py" ] && echo "$OVMEM_DIR/ovmem.py" || echo missing)"
    echo "cleanup:   $([ -f "$OVMEM_DIR/ovmem-cleanup.py" ] && echo present || echo missing)"
    echo "dashboard: $([ -f "$OVMEM_DIR/dashboard.py" ] && echo "present (127.0.0.1:1934)" || echo missing)"
    echo "server:    $(server_up && echo "up (127.0.0.1:1933)" || echo "down")"
    for h in $(leo_harness_targets); do
      echo "$(leo_harness_label "$h"):"
      echo "  hooks:   $(wired_count "$h")/$HOOK_COUNT in $(hooks_file "$h")"
      if [ "$h" = codex ]; then
        echo "  note:    Codex keeps a config-declared hook inert until you approve it once."
        echo "  note:    Codex caps SessionEnd at 3s, so the end-of-session flush runs detached."
      fi
    done
    if [ -f "$HOME/.openviking/ov.conf" ] && command -v jq >/dev/null 2>&1; then
      prov="$(jq -r '.vlm.provider // "?"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      chat="$(jq -r '.vlm.model // "?"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      emb="$(jq -r '.embedding.dense.model // "?"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      lang="$(jq -r '.output_language_override // "auto"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      echo "provider:  $prov"
      echo "chat:      $chat"
      echo "embed:     $emb"
      echo "ov.conf:   present (lang=$lang)"
    elif [ -f "$HOME/.openviking/ov.conf" ]; then
      echo "ov.conf:   present"
    else
      echo "ov.conf:   missing"
    fi
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor|watch}" >&2
    exit 2
    ;;
esac
