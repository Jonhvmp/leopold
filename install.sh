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
    git clone --progress --depth 1 https://github.com/Jonhvmp/leopold.git "$SRC"
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

echo "-> installing hooks, templates, docs, extensions"
cp -R "$SRC/hooks"      "$LEO_HOME/"
cp -R "$SRC/templates"  "$LEO_HOME/"
cp -R "$SRC/docs"       "$LEO_HOME/" 2>/dev/null || true
cp -R "$SRC/scripts"    "$LEO_HOME/" 2>/dev/null || true
cp -R "$SRC/extensions" "$LEO_HOME/" 2>/dev/null || true
cp    "$SRC/VERSION"    "$LEO_HOME/" 2>/dev/null || true
chmod +x "$LEO_HOME"/hooks/*.sh
chmod +x "$LEO_HOME"/scripts/*.sh 2>/dev/null || true
chmod +x "$LEO_HOME"/extensions/*/manage.sh 2>/dev/null || true

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

# Serena — MANDATORY. LSP-backed code intelligence (MCP): symbol-level retrieval/editing
# instead of grep + whole-file reads. It is the biggest lever for code quality AND for
# keeping context lean (fewer tokens per operation), so Leopold sets it up for everyone.
echo
echo "-> setting up Serena (LSP code intelligence — mandatory for quality + lean context)"
SERENA_MGR="$LEO_HOME/extensions/serena/manage.sh"
if [ -f "$SERENA_MGR" ]; then
  bash "$SERENA_MGR" install || echo "   Serena setup did not finish; complete it with: make serena-install  (or: make menu)"
else
  echo "   (serena extension missing from this build; skipping)"
fi

# The `leopold` CLI — so `leopold menu / watch / doctor / serena` work from anywhere,
# no repo and no `make`. Skip if it's already here (e.g. you ran `leopold install`).
echo
if command -v leopold >/dev/null 2>&1; then
  echo "-> leopold CLI already installed"
elif command -v npm >/dev/null 2>&1; then
  echo "-> installing the leopold CLI (npm i -g leopold-driver)"
  if npm i -g leopold-driver >/dev/null 2>&1; then
    if command -v leopold >/dev/null 2>&1; then
      echo "   ok   'leopold' command ready (leopold menu · watch · doctor)"
    else
      echo "   installed, but 'leopold' isn't on PATH yet — open a new shell (or: hash -r)"
    fi
  else
    echo "   warn: 'npm i -g leopold-driver' failed (permissions?) — run it yourself, maybe with sudo"
  fi
else
  echo "-> npm not found — the 'leopold' CLI needs Node/npm. Then: npm i -g leopold-driver"
fi

echo
GSTACK_DIR="$SKILLS/gstack"
gstack_present() { [ -d "$GSTACK_DIR" ] || ls "$SKILLS" 2>/dev/null | grep -q '^spec$'; }
install_gstack() {
  echo "-> installing gstack (MIT, by Garry Tan: https://github.com/garrytan/gstack)"
  command -v bun >/dev/null 2>&1 || echo "   note: gstack needs Bun v1.0+ (https://bun.sh); its setup will guide you."
  echo "   cloning gstack (shows progress) + running its setup…"
  if git clone --progress --single-branch --depth 1 https://github.com/garrytan/gstack.git "$GSTACK_DIR" && ( cd "$GSTACK_DIR" && ./setup ); then
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

# Verify the install: skills, hooks, and the leopold CLI should all be in place.
echo
echo "-> verifying"
v_warn=0
sc="$(ls "$SKILLS" 2>/dev/null | grep -c '^leopold-' || true)"
[ "${sc:-0}" -ge 4 ] 2>/dev/null && echo "   ok   $sc leopold skills installed" || { echo "   warn: leopold skills not found in $SKILLS"; v_warn=$((v_warn+1)); }
if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ] && jq -e '(.hooks.Stop|length>0) and (.hooks.PreToolUse|length>0)' "$SETTINGS" >/dev/null 2>&1; then
  echo "   ok   Stop + PreToolUse hooks wired in settings.json"
else echo "   warn: hooks not detected in settings.json"; v_warn=$((v_warn+1)); fi
command -v leopold  >/dev/null 2>&1 && echo "   ok   leopold CLI on PATH" || { echo "   warn: 'leopold' not on PATH yet (open a new shell, or: npm i -g leopold-driver)"; v_warn=$((v_warn+1)); }
command -v serena   >/dev/null 2>&1 && echo "   ok   serena (LSP) present" || echo "   note: serena not on PATH — run: leopold serena install"
[ "$v_warn" -eq 0 ] && echo "   all good." || echo "   $v_warn warning(s) above — see the hints."

echo
echo "Done. In any project:"
echo "  /leopold-brief    debate the mission, write the brief"
echo "  /leopold-run      hand over the seat"
echo "  /leopold-status   see where it is"
echo "  /leopold-stop     take the seat back"
echo "  (or from a shell: leopold menu · leopold watch · leopold doctor)"
echo
# Offer the toolchain manager. We read from /dev/tty (the controlling terminal),
# not stdin, so this works even when the installer is piped: `curl ... | bash`
# leaves stdin as the script, but the terminal is still reachable via /dev/tty.
MENU="$LEO_HOME/scripts/leopold-menu.sh"
if exec 3<>/dev/tty 2>/dev/null; then
  printf "Open the toolchain manager (install/manage gstack, ovmem, ...)? [Y/n] " >&3
  read -r _ans <&3 || _ans="y"
  case "$_ans" in
    [nN]*) echo "Skipped. Open it anytime:  bash $MENU   (or: make menu)" ;;
    *)     bash "$MENU" <&3 || true ;;
  esac
  exec 3>&-
else
  # no terminal (headless / CI): just point at it
  echo "Manage the toolchain (gstack, ovmem, ...):"
  echo "  bash $MENU    (or: make menu)"
fi
