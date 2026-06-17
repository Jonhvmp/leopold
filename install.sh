#!/usr/bin/env bash
# Leopold installer.
# Copies the skills into ~/.claude/skills/, the hooks/templates/docs into
# ~/.claude/leopold/, and wires the Stop + PreToolUse hooks into
# ~/.claude/settings.json (idempotent, with a backup). The hooks are no-ops
# unless a Leopold run is active, so they are safe to leave installed.
set -euo pipefail

# Resolve the source tree. When run from a clone, that is the script's dir.
# When piped (curl ... | bash), there is no local tree, so we fetch one first.
_self="${BASH_SOURCE[0]:-}"
if [ -n "$_self" ] && [ -d "$(dirname "$_self")/skills" ]; then
  SRC="$(cd "$(dirname "$_self")" && pwd)"
else
  SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
  echo "-> fetching Leopold into $SRC"
  if [ -d "$SRC/.git" ]; then
    ( cd "$SRC" && git pull --ff-only -q ) || true
  else
    mkdir -p "$(dirname "$SRC")"
    git clone --depth 1 https://github.com/Jonhvmp/leopold.git "$SRC"
  fi
fi
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
SKILLS="$CLAUDE/skills"
LEO_HOME="$CLAUDE/leopold"
SETTINGS="$CLAUDE/settings.json"

# Optional gstack integration: pass --with-gstack to install it non-interactively.
WITH_GSTACK=0
for _a in "$@"; do [ "$_a" = "--with-gstack" ] && WITH_GSTACK=1; done

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
GSTACK_DIR="$SKILLS/gstack"
gstack_present() { [ -d "$GSTACK_DIR" ] || ls "$SKILLS" 2>/dev/null | grep -q '^spec$'; }
install_gstack() {
  echo "-> installing gstack (MIT, by Garry Tan: https://github.com/garrytan/gstack)"
  command -v bun >/dev/null 2>&1 || echo "   note: gstack needs Bun v1.0+ (https://bun.sh); its setup will guide you."
  if git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$GSTACK_DIR" && ( cd "$GSTACK_DIR" && ./setup ); then
    echo "   gstack installed."
  else
    echo "   gstack install did not finish; retry with: make gstack-install"
  fi
}

if gstack_present; then
  echo "gstack detected: Leopold will conduct its planning toolchain (/spec, /autoplan, /plan-*-review, ...)."
elif [ "$WITH_GSTACK" = "1" ]; then
  install_gstack
else
  echo "gstack not detected. Leopold works on plain Claude Code, but it shines when it can conduct"
  echo "gstack's planning toolchain (/autoplan, /plan-eng-review, /spec). gstack is a separate MIT"
  echo "project by Garry Tan: https://github.com/garrytan/gstack"
  if [ -t 0 ]; then
    printf "Install gstack now? (clones to %s, runs its setup, needs Bun) [y/N] " "$GSTACK_DIR"
    read -r _ans || _ans=""
    case "$_ans" in [yY]*) install_gstack ;; *) echo "Skipped. Install later: make gstack-install" ;; esac
  else
    echo "Enable it later with: make gstack-install   (or re-run ./install.sh --with-gstack)"
  fi
fi

echo
echo "Done. In any project:"
echo "  /leopold-brief    debate the mission, write the brief"
echo "  /leopold-run      hand over the seat"
echo "  /leopold-status   see where it is"
echo "  /leopold-stop     take the seat back"
