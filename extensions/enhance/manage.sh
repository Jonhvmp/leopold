#!/usr/bin/env bash
# enhance extension - global prompt enhancer (one UserPromptSubmit hook + Haiku).
#
# Installed (wired, but OFF) by the main Leopold installer; this manager is the
# control plane: toggle flips enabled in state.json, remove is the full destroy
# (unwires the hook and deletes ~/.claude/enhance including the ledger + learned
# profile). See README.md in this folder.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
ENHANCE_DIR="$CLAUDE/enhance"
SETTINGS="$CLAUDE/settings.json"

case "${1:-}" in
  detect)
    [ -f "$ENHANCE_DIR/enhance.py" ]
    ;;

  status)
    if [ -f "$ENHANCE_DIR/enhance.py" ]; then
      python3 "$ENHANCE_DIR/enhance.py" --event status 2>/dev/null || echo "engine error"
    else
      echo "not installed"
    fi
    ;;

  install|update)
    # idempotent: re-vendors the engine, preserves state.json / profile / ledger.
    bash "$HERE/install.sh"
    ;;

  toggle)
    [ -f "$ENHANCE_DIR/enhance.py" ] || { echo "not installed (run: manage.sh install)" >&2; exit 1; }
    python3 "$ENHANCE_DIR/enhance.py" --event toggle "${2:-}"
    ;;

  remove)
    if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
      cp "$SETTINGS" "$SETTINGS.enhance.bak"
      tmp="$(mktemp)"
      jq '
        if .hooks then
          .hooks |= ( to_entries
            | map(.value |= ( map( .hooks |= map(select((.command // "") | test("enhance.py --event") | not)) )
                              | map(select((.hooks | length) > 0)) ))
            | from_entries )
        else . end
      ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
      echo "unwired the enhance hook (backup at $SETTINGS.enhance.bak)"
    fi
    rm -rf "$ENHANCE_DIR"
    echo "removed $ENHANCE_DIR (engine, state, ledger and learned profile)"
    ;;

  doctor)
    echo "engine:   $([ -f "$ENHANCE_DIR/enhance.py" ] && echo "$ENHANCE_DIR/enhance.py" || echo missing)"
    echo "state:    $(python3 "$ENHANCE_DIR/enhance.py" --event status 2>/dev/null || echo "unreadable")"
    if [ -f "$SETTINGS" ]; then
      wired="$(grep -c 'enhance.py --event' "$SETTINGS" 2>/dev/null)" || true
      echo "hook:     ${wired:-0}/1 wired in settings.json"
    else
      echo "hook:     settings.json not found"
    fi
    echo "claude:   $(command -v claude >/dev/null 2>&1 && echo "on PATH" || echo "NOT on PATH (enhancer fails open)")"
    if [ -f "$ENHANCE_DIR/enhancements.jsonl" ]; then
      echo "ledger:   $(wc -l < "$ENHANCE_DIR/enhancements.jsonl" | tr -d ' ') line(s), $(du -h "$ENHANCE_DIR/enhancements.jsonl" | cut -f1)"
    else
      echo "ledger:   empty (no enhancements yet)"
    fi
    echo "profile:  $([ -f "$ENHANCE_DIR/PROMPT-PROFILE.md" ] && echo present || echo missing)"
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor|toggle [on|off]}" >&2
    exit 2
    ;;
esac
