#!/usr/bin/env bash
# Leopold installer.
# Copies the skills into ~/.claude/skills/, the hooks/templates/docs into
# ~/.claude/leopold/, and wires the Stop + PreToolUse hooks into
# ~/.claude/settings.json (idempotent, with a backup). The hooks are no-ops
# unless a Leopold run is active, so they are safe to leave installed.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
SKILLS="$CLAUDE/skills"
LEO_HOME="$CLAUDE/leopold"
SETTINGS="$CLAUDE/settings.json"

echo "Leopold installer"
echo "  source:   $SRC"
echo "  target:   $CLAUDE"
echo

mkdir -p "$SKILLS" "$LEO_HOME"

echo "-> installing skills"
for d in "$SRC"/skills/*/; do
  name="$(basename "$d")"
  rm -rf "${SKILLS:?}/$name"
  cp -R "$d" "$SKILLS/$name"
  echo "   $name"
done

echo "-> installing hooks, templates, docs"
cp -R "$SRC/hooks"     "$LEO_HOME/"
cp -R "$SRC/templates" "$LEO_HOME/"
cp -R "$SRC/docs"      "$LEO_HOME/" 2>/dev/null || true
chmod +x "$LEO_HOME"/hooks/*.sh

STOP_HOOK="$LEO_HOME/hooks/stop-continuity.sh"
GUARD_HOOK="$LEO_HOME/hooks/guard-irreversible.sh"

echo "-> wiring hooks into $SETTINGS"
if ! command -v jq >/dev/null 2>&1; then
  echo
  echo "   jq not found. Add this to $SETTINGS manually:"
  sed "s#~/.claude/leopold#$LEO_HOME#g" "$SRC/settings.template.json"
  echo
else
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  cp "$SETTINGS" "$SETTINGS.leopold.bak"
  tmp="$(mktemp)"
  jq --arg stop "$STOP_HOOK" --arg guard "$GUARD_HOOK" '
    .hooks //= {}
    | .hooks.Stop //= []
    | .hooks.PreToolUse //= []
    | (if any(.hooks.Stop[]?.hooks[]?; .command == $stop)
        then . else .hooks.Stop += [{hooks:[{type:"command",command:$stop}]}] end)
    | (if any(.hooks.PreToolUse[]?.hooks[]?; .command == $guard)
        then . else .hooks.PreToolUse += [{matcher:"Bash|Edit|Write|MultiEdit|NotebookEdit",hooks:[{type:"command",command:$guard}]}] end)
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "   merged (backup at $SETTINGS.leopold.bak)"
fi

echo
if [ -d "$SKILLS/gstack" ] || ls "$SKILLS" 2>/dev/null | grep -q '^spec$'; then
  echo "gstack detected: Leopold will conduct the full skill toolchain."
else
  echo "gstack not detected: Leopold will orchestrate plain Claude Code (still works)."
fi

echo
echo "Done. In any project:"
echo "  /leopold-brief    debate the mission, write the brief"
echo "  /leopold-run      hand over the seat"
echo "  /leopold-status   see where it is"
echo "  /leopold-stop     take the seat back"
