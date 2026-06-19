#!/usr/bin/env bash
# Leopold core extension - manage the harness install (skills + hooks).
# install/update delegate to the canonical scripts so there is one source of truth.
set -euo pipefail

CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
LEO_HOME="$CLAUDE/leopold"
SKILLS="$CLAUDE/skills"

# Resolve this extension's own location to reach sibling scripts / VERSION,
# whether running from a clone (repo/extensions/leopold) or an install
# (~/.claude/leopold/extensions/leopold).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"   # repo root, or ~/.claude/leopold

case "${1:-}" in
  detect)
    [ -d "$LEO_HOME/hooks" ] && [ -d "$SKILLS/leopold-run" ]
    ;;

  status)
    if [ -f "$ROOT/VERSION" ]; then echo "v$(cat "$ROOT/VERSION" 2>/dev/null | tr -d '[:space:]')"; else echo "installed"; fi
    ;;

  install|update)
    if [ -x "$ROOT/install.sh" ]; then
      bash "$ROOT/install.sh"
    elif [ -x "$LEO_HOME/scripts/leopold-update.sh" ]; then
      bash "$LEO_HOME/scripts/leopold-update.sh"
    else
      echo "no installer found (expected $ROOT/install.sh or $LEO_HOME/scripts/leopold-update.sh)"
      exit 1
    fi
    ;;

  remove)
    echo "Removing Leopold core also removes this menu. Doing it by hand keeps you in control:"
    echo "  rm -rf $LEO_HOME"
    echo "  rm -rf $SKILLS/leopold-*"
    echo "  then remove the Stop + PreToolUse hooks from $CLAUDE/settings.json"
    echo "  (a backup was written to settings.json.leopold.bak at install time)"
    ;;

  doctor)
    if [ -x "$LEO_HOME/scripts/leopold-doctor.sh" ]; then
      bash "$LEO_HOME/scripts/leopold-doctor.sh"
    elif [ -x "$ROOT/scripts/leopold-doctor.sh" ]; then
      bash "$ROOT/scripts/leopold-doctor.sh"
    else
      echo "skills:   $([ -d "$SKILLS/leopold-run" ] && echo ok || echo missing)"
      echo "hooks:    $([ -d "$LEO_HOME/hooks" ] && echo ok || echo missing)"
    fi
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor}" >&2
    exit 2
    ;;
esac
