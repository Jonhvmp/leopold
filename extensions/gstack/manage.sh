#!/usr/bin/env bash
# gstack extension - install/manage the gstack skill suite that Leopold conducts.
# gstack is a separate MIT project by Garry Tan: https://github.com/garrytan/gstack
set -euo pipefail

CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
SKILLS="$CLAUDE/skills"
GSTACK_DIR="$SKILLS/gstack"
REPO="https://github.com/garrytan/gstack.git"

case "${1:-}" in
  detect)
    # installed if the clone exists, or if its skills are already present
    [ -d "$GSTACK_DIR" ] || [ -e "$SKILLS/spec" ]
    ;;

  status)
    if [ -d "$GSTACK_DIR/.git" ]; then
      echo "$(cd "$GSTACK_DIR" && git rev-parse --short HEAD 2>/dev/null || echo present)"
    else
      echo "present"
    fi
    ;;

  install)
    if [ -d "$GSTACK_DIR" ]; then
      echo "gstack already installed at $GSTACK_DIR"
      exit 0
    fi
    command -v bun >/dev/null 2>&1 || echo "note: gstack needs Bun v1.0+ (https://bun.sh); its setup will guide you."
    echo "-> cloning gstack into $GSTACK_DIR (shows progress; a few seconds)"
    mkdir -p "$SKILLS"
    git clone --progress --single-branch --depth 1 "$REPO" "$GSTACK_DIR"
    echo "-> running gstack setup"
    ( cd "$GSTACK_DIR" && ./setup )
    echo "gstack installed."
    ;;

  update)
    if [ ! -d "$GSTACK_DIR/.git" ]; then
      echo "gstack not installed as a git clone; nothing to update. Run install."
      exit 0
    fi
    echo "-> pulling gstack"
    ( cd "$GSTACK_DIR" && git pull --ff-only -q && ./setup )
    echo "gstack updated."
    ;;

  remove)
    if [ -d "$GSTACK_DIR" ]; then
      rm -rf "${GSTACK_DIR:?}"
      echo "removed $GSTACK_DIR"
    else
      echo "gstack not present."
    fi
    ;;

  doctor)
    echo "dir:  $([ -d "$GSTACK_DIR" ] && echo "$GSTACK_DIR" || echo "missing")"
    echo "bun:  $(command -v bun >/dev/null 2>&1 && bun --version 2>/dev/null || echo "not found (needed for setup)")"
    echo "spec skill: $([ -d "$SKILLS/spec" ] && echo present || echo missing)"
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor}" >&2
    exit 2
    ;;
esac
