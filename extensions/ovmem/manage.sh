#!/usr/bin/env bash
# ovmem extension - autonomous RAG long-term memory (OpenViking + 4 Claude Code hooks).
#
# All subcommands are real: detect / status / doctor probe a live install;
# install / update run the full installer (also the reconfigure / provider-switch path,
# with credential reuse + a safe index rebuild); remove unwires the hooks and deletes the
# engine, leaving your OpenViking server + memory data intact. See README.md in this folder.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
OVMEM_DIR="$CLAUDE/ovmem"
SETTINGS="$CLAUDE/settings.json"
OV_HEALTH="http://127.0.0.1:1933/health"

server_up() { curl -s -m 2 "$OV_HEALTH" 2>/dev/null | grep -q '"healthy":true'; }

case "${1:-}" in
  detect)
    [ -f "$OVMEM_DIR/ovmem.py" ]
    ;;

  status)
    if [ -f "$OVMEM_DIR/ovmem.py" ]; then
      if server_up; then echo "server up"; else echo "server down"; fi
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
    if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
      cp "$SETTINGS" "$SETTINGS.ovmem.bak"
      tmp="$(mktemp)"
      jq '
        if .hooks then
          .hooks |= ( to_entries
            | map(.value |= ( map( .hooks |= map(select((.command // "") | test("ovmem.py --event") | not)) )
                              | map(select((.hooks | length) > 0)) ))
            | from_entries )
        else . end
      ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
      echo "unwired ovmem hooks (backup at $SETTINGS.ovmem.bak)"
    fi
    rm -rf "$OVMEM_DIR"
    echo "removed $OVMEM_DIR"
    echo "left untouched: the OpenViking server + ~/.openviking (your memory data)."
    echo "to purge those too: uv tool uninstall openviking ; rm -rf ~/.openviking"
    ;;

  doctor)
    echo "engine:   $([ -f "$OVMEM_DIR/ovmem.py" ] && echo "$OVMEM_DIR/ovmem.py" || echo missing)"
    echo "cleanup:  $([ -f "$OVMEM_DIR/ovmem-cleanup.py" ] && echo present || echo missing)"
    echo "server:   $(server_up && echo "up (127.0.0.1:1933)" || echo "down")"
    if [ -f "$SETTINGS" ]; then
      local_hooks="$(grep -c 'ovmem.py --event' "$SETTINGS" 2>/dev/null || echo 0)"
      echo "hooks:    $local_hooks/4 wired in settings.json"
    else
      echo "hooks:    settings.json not found"
    fi
    if [ -f "$HOME/.openviking/ov.conf" ] && command -v jq >/dev/null 2>&1; then
      prov="$(jq -r '.vlm.provider // "?"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      chat="$(jq -r '.vlm.model // "?"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      emb="$(jq -r '.embedding.dense.model // "?"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      lang="$(jq -r '.output_language_override // "auto"' "$HOME/.openviking/ov.conf" 2>/dev/null)"
      echo "provider: $prov"
      echo "chat:     $chat"
      echo "embed:    $emb"
      echo "ov.conf:  present (lang=$lang)"
    elif [ -f "$HOME/.openviking/ov.conf" ]; then
      echo "ov.conf:  present"
    else
      echo "ov.conf:  missing"
    fi
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor}" >&2
    exit 2
    ;;
esac
