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
#
# LEOPOLD_NONINTERACTIVE=1 never prompts (CI, tests, scripted installs).
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

# Ask ONLY when the choice is real. Two harnesses on the machine (which one is yours?)
# or none at all (which one are you setting up?) are genuine forks; a machine with
# exactly one is not, and prompting there is pure friction. An explicit --harness always
# wins, and a piped/headless install never blocks — it takes the sane default and says
# what it picked. Read from /dev/tty, not stdin, so `curl ... | bash` can still ask.
_ask_harness() {
  local both="$1" prompt default
  if [ "$both" = "1" ]; then
    prompt="Both Claude Code and Codex CLI are here. Install Leopold into which?"
    default="1"
  else
    prompt="No agent harness detected. Set Leopold up for which?"
    default="1"
  fi
  {
    echo
    echo "$prompt"
    echo "  1) both        — same brief, same hooks, either seat (recommended)"
    echo "  2) Claude Code — ~/.claude"
    echo "  3) Codex CLI   — ~/.codex"
    printf "Choice [%s]: " "$default"
  } >&3
  local ans; read -r ans <&3 || ans=""
  case "${ans:-$default}" in
    2) DO_CLAUDE=1; DO_CODEX=0 ;;
    3) DO_CLAUDE=0; DO_CODEX=1 ;;
    *) DO_CLAUDE=1; DO_CODEX=1 ;;
  esac
}

if [ "$HARNESS" = "auto" ] && [ "${LEOPOLD_NONINTERACTIVE:-0}" != "1" ]; then
  _both=0
  { command -v claude >/dev/null 2>&1 || [ -d "$CLAUDE" ]; } \
    && { command -v codex >/dev/null 2>&1 || [ -d "$CODEX" ]; } && _both=1
  _none=0
  ! command -v claude >/dev/null 2>&1 && ! [ -d "$CLAUDE" ] \
    && ! command -v codex >/dev/null 2>&1 && ! [ -d "$CODEX" ] && _none=1
  if [ "$_both" = "1" ] || [ "$_none" = "1" ]; then
    if exec 3<>/dev/tty 2>/dev/null; then
      _ask_harness "$_both"
      exec 3>&-
    elif [ "$_both" = "1" ]; then
      echo "Both harnesses detected and no terminal to ask — installing into both."
      echo "  (pick one explicitly with: --harness claude | --harness codex)"
    fi
  fi
fi

# Hand the RESOLVED choice down to every extension installer we call. Without this an
# extension re-resolves "auto" on its own and a `--harness codex` install on a machine
# that merely HAS a ~/.claude would still wire itself into Claude Code. On a Claude-only
# box this resolves to exactly what auto already answered, so nothing changes there.
if   [ "$DO_CLAUDE" = "1" ] && [ "$DO_CODEX" = "1" ]; then LEOPOLD_HARNESS=all
elif [ "$DO_CODEX"  = "1" ];                          then LEOPOLD_HARNESS=codex
else                                                       LEOPOLD_HARNESS=claude
fi
export LEOPOLD_HARNESS

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

# Everything from here on is harness-aware: the settings.json wiring below is the
# Claude Code half, and the extensions after it install into whichever harnesses
# LEOPOLD_HARNESS resolved to. A Codex-only install used to `exit 0` right here,
# which shipped the skills and the two hooks but silently skipped the enhancer,
# Serena, the leopold CLI and the verification pass — half a product.
if [ "$DO_CLAUDE" = "1" ]; then
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
fi

# Prompt enhancer — wired for everyone, but OFF until toggled on. One UserPromptSubmit
# hook per harness that is a silent no-op while disabled (state.json enabled:false),
# so wiring it here is safe; both merges are idempotent, so re-installs never
# duplicate it. jq is only needed for the Claude Code half (settings.json); a
# Codex-only box wires pure TOML and must not be blocked on it.
echo
echo "-> installing the prompt enhancer (wired OFF — enable via: leopold menu -> enhance)"
ENHANCE_INST="$LEO_HOME/extensions/enhance/install.sh"
ENHANCE_NEEDS_JQ=0
[ "$DO_CLAUDE" = "1" ] && ENHANCE_NEEDS_JQ=1
if [ -f "$ENHANCE_INST" ] && command -v python3 >/dev/null 2>&1 \
   && { [ "$ENHANCE_NEEDS_JQ" = "0" ] || command -v jq >/dev/null 2>&1; }; then
  bash "$ENHANCE_INST" || echo "   enhance setup did not finish; retry via: leopold menu (enhance -> Install)"
else
  echo "   skipped (needs python3$( [ "$ENHANCE_NEEDS_JQ" = "1" ] && printf ' + jq')) — install later via: leopold menu"
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
# gstack goes through its extension, which installs into EVERY harness resolved
# above (LEOPOLD_HARNESS is already exported) and reports each one. Cloning it
# from here would hardcode a Claude skills path into a Codex-only install.
GSTACK_EXT="$SRC/extensions/gstack/manage.sh"
gstack_present() { bash "$GSTACK_EXT" detect >/dev/null 2>&1; }
install_gstack() {
  echo "-> installing gstack (MIT, by Garry Tan: https://github.com/garrytan/gstack)"
  bash "$GSTACK_EXT" install || echo "   gstack install did not finish; retry with: make gstack-install"
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
    printf "Install gstack now? (clones it, runs its setup on %s, needs Bun) [y/N] " "$_targets"
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
hv="$( [ -f "$LEO_HOME/VERSION" ] && tr -d '[:space:]' < "$LEO_HOME/VERSION" || echo '?' )"
if [ "$DO_CLAUDE" = "1" ]; then
  sc=0; for d in "$SKILLS"/leopold-*; do [ -e "$d" ] && sc=$((sc+1)); done
  [ "${sc:-0}" -ge 4 ] 2>/dev/null && echo "   ok   $sc leopold skills installed (harness v$hv)" || { echo "   warn: leopold skills not found in $SKILLS"; v_warn=$((v_warn+1)); }
  if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ] && jq -e '(.hooks.Stop|length>0) and (.hooks.PreToolUse|length>0)' "$SETTINGS" >/dev/null 2>&1; then
    echo "   ok   Stop + PreToolUse hooks wired in settings.json"
  else echo "   warn: hooks not detected in settings.json"; v_warn=$((v_warn+1)); fi
else
  echo "   ok   harness assets installed (v$hv) at $LEO_HOME"
fi
# The enhancer wires one hook per harness, so the check has to look where THIS
# machine's harnesses actually keep them — grepping settings.json on a Codex-only
# box would report "not wired" for a hook that is wired fine.
enh_wired=0; enh_want=0
if [ "$DO_CLAUDE" = "1" ]; then enh_want=$((enh_want+1)); grep -q 'enhance.py --event' "$SETTINGS" 2>/dev/null && enh_wired=$((enh_wired+1)); fi
if [ "$DO_CODEX"  = "1" ]; then enh_want=$((enh_want+1)); grep -q 'enhance.py --event' "$CODEX/config.toml" 2>/dev/null && enh_wired=$((enh_wired+1)); fi
if [ "$enh_wired" -eq "$enh_want" ]; then
  echo "   ok   prompt enhancer wired on $enh_wired harness(es) (off — enable via: leopold menu -> enhance)"
else
  echo "   note: prompt enhancer wired on $enh_wired/$enh_want harness(es) — install via: leopold menu"
fi
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
if [ "$DO_CODEX" = "1" ]; then
  echo "  On Codex:         leopold run --provider codex   (the driver conducts it)"
  echo "                    the hooks stay inert in interactive Codex until you trust them once"
fi
echo
# Offer the toolchain manager. We read from /dev/tty (the controlling terminal),
# not stdin, so this works even when the installer is piped: `curl ... | bash`
# leaves stdin as the script, but the terminal is still reachable via /dev/tty.
# LEOPOLD_NONINTERACTIVE=1 skips the prompt entirely — for CI, for tests, and for
# anything scripting the installer, which must never block on a terminal that
# happens to exist.
MENU="$LEO_HOME/scripts/leopold-menu.sh"
if [ "${LEOPOLD_NONINTERACTIVE:-0}" != "1" ] && exec 3<>/dev/tty 2>/dev/null; then
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
