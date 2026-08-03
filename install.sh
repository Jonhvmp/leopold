#!/usr/bin/env bash
# Leopold installer.
#
# Installs into whichever agent harness you have — Claude Code, Codex CLI, or both.
# The skills go to each harness's skills dir; the hooks/templates/docs go to one
# shared asset home; the git lock and (on Claude) the continuity hook get wired into
# that harness's settings file. Idempotent, with a backup of anything it edits.
# The hooks are no-ops unless a Leopold run is active, so they are safe to leave
# installed everywhere.
#
#   ./install.sh                     install into every harness found (default: auto)
#   ./install.sh --harness claude    Claude Code only
#   ./install.sh --harness codex     Codex CLI only
#   ./install.sh --harness all       both, whether or not they are on PATH
set -euo pipefail

# Resolve the source tree. When run from a clone, that is the script's dir.
# When piped (curl ... | bash), there is no local tree, so we fetch one first.
_self="${BASH_SOURCE[0]:-}"
if [ -n "$_self" ] && [ -d "$(dirname "$_self")/skills" ]; then
  SRC="$(cd "$(dirname "$_self")" && pwd)"
else
  SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
  BRANCH="${LEOPOLD_BRANCH:-main}"
  REPO="https://github.com/Jonhvmp/leopold.git"
  echo "-> fetching Leopold ($BRANCH) into $SRC"
  # A cached shallow clone can't always `pull --ff-only` (and the old code swallowed
  # the failure, leaving a STALE tree — the reason a re-install kept reporting an old
  # version). Force the working tree to the exact tip of the branch; re-clone if that
  # can't be done, so the source is always current.
  if [ -d "$SRC/.git" ]; then
    if ( cd "$SRC" && git fetch --depth 1 -q origin "$BRANCH" && git reset --hard -q FETCH_HEAD && git clean -qfd ); then
      :
    else
      echo "   couldn't update the cached clone — re-cloning fresh"
      rm -rf "$SRC" && git clone --progress --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
    fi
  else
    mkdir -p "$(dirname "$SRC")"
    git clone --progress --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
  fi
  [ -f "$SRC/VERSION" ] && echo "   at v$(tr -d '[:space:]' < "$SRC/VERSION")"
fi
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
CODEX="${CODEX_HOME:-$HOME/.codex}"
SKILLS="$CLAUDE/skills"
SETTINGS="$CLAUDE/settings.json"

# Optional gstack integration: pass --with-gstack to install it non-interactively.
WITH_GSTACK=0
HARNESS="auto"
_want_harness=0
for _a in "$@"; do
  if [ "$_want_harness" = "1" ]; then HARNESS="$_a"; _want_harness=0; continue; fi
  case "$_a" in
    --with-gstack) WITH_GSTACK=1 ;;
    --harness)     _want_harness=1 ;;
    --harness=*)   HARNESS="${_a#--harness=}" ;;
  esac
done

# Which harnesses to install into. "auto" takes whatever is actually here; if
# neither is, we still set Claude Code up so a fresh machine ends in a usable state.
DO_CLAUDE=0; DO_CODEX=0
case "$HARNESS" in
  claude|claude-code) DO_CLAUDE=1 ;;
  codex|openai)       DO_CODEX=1 ;;
  all|both)           DO_CLAUDE=1; DO_CODEX=1 ;;
  auto)
    { command -v claude >/dev/null 2>&1 || [ -d "$CLAUDE" ]; } && DO_CLAUDE=1
    { command -v codex  >/dev/null 2>&1 || [ -d "$CODEX"  ]; } && DO_CODEX=1
    [ "$DO_CLAUDE" = "0" ] && [ "$DO_CODEX" = "0" ] && DO_CLAUDE=1
    ;;
  *) echo "install.sh: unknown --harness \"$HARNESS\" (use: auto, claude, codex, all)" >&2; exit 2 ;;
esac

# One shared home for the harness-neutral assets (hooks, templates, docs, scripts,
# extensions). It stays under ~/.claude when Claude Code is in play so existing
# installs keep working without a migration; a Codex-only machine gets its own.
if [ -n "${LEOPOLD_HOME:-}" ]; then LEO_HOME="$LEOPOLD_HOME"
elif [ "$DO_CLAUDE" = "1" ];  then LEO_HOME="$CLAUDE/leopold"
else                               LEO_HOME="$CODEX/leopold"
fi

_targets=""
[ "$DO_CLAUDE" = "1" ] && _targets="Claude Code ($CLAUDE)"
[ "$DO_CODEX"  = "1" ] && _targets="${_targets:+$_targets + }Codex CLI ($CODEX)"

echo "Leopold installer"
echo "  source:   $SRC"
echo "  harness:  $_targets"
echo "  assets:   $LEO_HOME"
echo

mkdir -p "$LEO_HOME"

if [ "$DO_CLAUDE" = "1" ]; then
  mkdir -p "$SKILLS"
  echo "-> installing skills into Claude Code"
  for d in "$SRC"/skills/*/; do
    name="$(basename "$d")"
    rm -rf "${SKILLS:?}/$name"
    cp -R "$d" "$SKILLS/$name"
    echo "   $name"
  done
fi

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

if [ "$DO_CODEX" = "1" ]; then
  echo
  bash "$SRC/scripts/install-codex.sh" "$SRC" "$LEO_HOME" || \
    echo "   warn: the Codex install did not finish — re-run: ./install.sh --harness codex"
fi

if [ "$DO_CLAUDE" != "1" ]; then
  echo
  echo "Done. Codex is set up. In any project:"
  echo "  /leopold-brief    debate the mission, write the brief"
  echo "  /leopold-run      hand over the seat (needs the hooks trusted once)"
  echo "  /leopold-status   see where it is"
  echo "  leopold run --provider codex     or conduct it headlessly from a shell"
  echo "  leopold harness                  what each harness here can do"
  exit 0
fi

echo
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

# Prompt enhancer — wired for everyone, but OFF until toggled on. One UserPromptSubmit
# hook that is a silent no-op while disabled (state.json enabled:false), so wiring it
# here is safe; the settings merge is idempotent, so re-installs never duplicate it.
echo
echo "-> installing the prompt enhancer (wired OFF — enable via: leopold menu -> enhance)"
ENHANCE_INST="$LEO_HOME/extensions/enhance/install.sh"
if [ -f "$ENHANCE_INST" ] && command -v python3 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  bash "$ENHANCE_INST" || echo "   enhance setup did not finish; retry via: leopold menu (enhance -> Install)"
else
  echo "   skipped (needs python3 + jq) — install later via: leopold menu"
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
# no repo and no `make`. Always install/UPGRADE to the latest so re-running the
# installer keeps an existing CLI current (the old code stopped at "already installed"
# and left stale binaries in place — including the one missing `leopold --version`).
echo
if command -v npm >/dev/null 2>&1; then
  had="$(command -v leopold >/dev/null 2>&1 && leopold --version 2>/dev/null || echo '')"
  echo "-> installing/updating the leopold CLI (npm i -g leopold-driver@latest)"
  if npm i -g leopold-driver@latest >/dev/null 2>&1; then
    hash -r 2>/dev/null || true
    if command -v leopold >/dev/null 2>&1; then
      now="$(leopold --version 2>/dev/null || echo '?')"
      if [ -n "$had" ] && [ "$had" != "$now" ]; then
        echo "   ok   'leopold' updated $had -> $now"
      else
        echo "   ok   'leopold' ready ($now) — leopold menu · watch · doctor"
      fi
    else
      echo "   installed, but 'leopold' isn't on PATH yet — open a new shell (or: hash -r)"
    fi
  else
    echo "   warn: 'npm i -g leopold-driver@latest' failed (permissions?) — run it yourself, maybe with sudo"
  fi
else
  echo "-> npm not found — the 'leopold' CLI needs Node/npm. Then: npm i -g leopold-driver@latest"
fi

echo
GSTACK_DIR="$SKILLS/gstack"
gstack_present() { [ -d "$GSTACK_DIR" ] || [ -e "$SKILLS/spec" ]; }
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
sc=0; for d in "$SKILLS"/leopold-*; do [ -e "$d" ] && sc=$((sc+1)); done
hv="$( [ -f "$LEO_HOME/VERSION" ] && tr -d '[:space:]' < "$LEO_HOME/VERSION" || echo '?' )"
[ "${sc:-0}" -ge 4 ] 2>/dev/null && echo "   ok   $sc leopold skills installed (harness v$hv)" || { echo "   warn: leopold skills not found in $SKILLS"; v_warn=$((v_warn+1)); }
if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ] && jq -e '(.hooks.Stop|length>0) and (.hooks.PreToolUse|length>0)' "$SETTINGS" >/dev/null 2>&1; then
  echo "   ok   Stop + PreToolUse hooks wired in settings.json"
else echo "   warn: hooks not detected in settings.json"; v_warn=$((v_warn+1)); fi
grep -q 'enhance.py --event' "$SETTINGS" 2>/dev/null && echo "   ok   prompt enhancer wired (off — enable via: leopold menu -> enhance)" || echo "   note: prompt enhancer not wired — install via: leopold menu"
if [ "$DO_CODEX" = "1" ]; then
  cs=0; for d in "$CODEX"/skills/leopold-*; do [ -e "$d" ] && cs=$((cs+1)); done
  [ "${cs:-0}" -ge 4 ] 2>/dev/null && echo "   ok   $cs leopold skills installed for Codex" || { echo "   warn: leopold skills not found in $CODEX/skills"; v_warn=$((v_warn+1)); }
  grep -q 'leopold (managed)' "$CODEX/config.toml" 2>/dev/null && echo "   ok   git lock wired into $CODEX/config.toml (trust it once in Codex to arm it)" || { echo "   warn: git lock not wired into $CODEX/config.toml"; v_warn=$((v_warn+1)); }
fi
command -v leopold  >/dev/null 2>&1 && echo "   ok   leopold CLI on PATH" || { echo "   warn: 'leopold' not on PATH yet (open a new shell, or: npm i -g leopold-driver)"; v_warn=$((v_warn+1)); }
command -v serena   >/dev/null 2>&1 && echo "   ok   serena (LSP) present" || echo "   note: serena not on PATH — run: leopold serena install"
[ "$v_warn" -eq 0 ] && echo "   all good." || echo "   $v_warn warning(s) above — see the hints."

echo
echo "Done. In any project:"
echo "  /leopold-brief    debate the mission, write the brief"
echo "  /leopold-run      hand over the seat"
echo "  /leopold-status   see where it is"
echo "  /leopold-stop     take the seat back"
echo "  (or from a shell: leopold menu · leopold watch · leopold doctor · leopold harness)"
[ "$DO_CODEX" = "1" ] && echo "  On Codex:         leopold run --provider codex   (the driver conducts it)"
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
