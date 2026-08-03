#!/usr/bin/env bash
# leopold doctor — verify the Leopold install: skills, hooks + wiring, gstack,
# the driver toolchain, and whether an update is available.
set -u
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
CODEX="${CODEX_HOME:-$HOME/.codex}"
SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
# The harness-neutral asset home: wherever the installer put the hooks.
if   [ -n "${LEOPOLD_HOME:-}" ];        then LEO_HOME="$LEOPOLD_HOME"
elif [ -d "$CLAUDE/leopold/hooks" ];    then LEO_HOME="$CLAUDE/leopold"
else                                         LEO_HOME="$CODEX/leopold"
fi
ok=0; warn=0; bad=0
pass(){ echo "  [ok]   $1"; ok=$((ok+1)); }
miss(){ echo "  [FAIL] $1"; bad=$((bad+1)); }
note(){ echo "  [warn] $1"; warn=$((warn+1)); }

# Which harnesses are actually here. Leopold runs on either; it only needs one.
HAVE_CLAUDE=0; HAVE_CODEX=0
{ command -v claude >/dev/null 2>&1 || [ -d "$CLAUDE" ]; } && HAVE_CLAUDE=1
{ command -v codex  >/dev/null 2>&1 || [ -d "$CODEX"  ]; } && HAVE_CODEX=1

echo "leopold doctor"
echo

command -v jq >/dev/null 2>&1 && pass "jq present" || miss "jq missing (the hooks need it)"

if [ "$HAVE_CLAUDE" = "0" ] && [ "$HAVE_CODEX" = "0" ]; then
  miss "no agent harness found — install Claude Code or Codex CLI first"
fi

if [ -x "$LEO_HOME/hooks/stop-continuity.sh" ] && [ -x "$LEO_HOME/hooks/guard-irreversible.sh" ]; then
  pass "hooks installed + executable ($LEO_HOME/hooks)"
else
  miss "hooks not installed — run ./install.sh"
fi

# --- Claude Code -------------------------------------------------------------
if [ "$HAVE_CLAUDE" = "1" ]; then
  n=$(ls -d "$CLAUDE"/skills/leopold-* 2>/dev/null | wc -l | tr -d ' ')
  [ "${n:-0}" -ge 4 ] && pass "Claude Code: skills installed ($n)" || miss "Claude Code: skills not installed ($n found) — run ./install.sh"

  if [ -f "$CLAUDE/settings.json" ] && grep -q 'leopold/hooks' "$CLAUDE/settings.json" 2>/dev/null; then
    pass "Claude Code: hooks wired in settings.json"
  elif ls -d "$CLAUDE"/plugins/cache/*/leopold* >/dev/null 2>&1; then
    pass "Claude Code: hooks wired via plugin"
  else
    note "Claude Code: hooks not wired — run ./install.sh or install the plugin"
  fi
fi

# --- Codex CLI ---------------------------------------------------------------
# Codex reimplemented Claude Code's hook contract, so the same two hooks run there.
# The extra check is trust: a config-declared hook stays inert until approved once.
if [ "$HAVE_CODEX" = "1" ]; then
  cn=$(ls -d "$CODEX"/skills/leopold-* 2>/dev/null | wc -l | tr -d ' ')
  [ "${cn:-0}" -ge 4 ] && pass "Codex: skills installed ($cn)" || note "Codex: skills not installed ($cn found) — run ./install.sh --harness codex"

  if grep -q 'leopold (managed)' "$CODEX/config.toml" 2>/dev/null; then
    pass "Codex: hooks wired in config.toml"
    if grep -q 'trusted_hash' "$CODEX/config.toml" 2>/dev/null; then
      pass "Codex: hook trust entries present (open Codex once if the hooks still look inert)"
    else
      note "Codex: hooks never trusted — open Codex once and approve them, or they stay inert in interactive sessions"
    fi
  elif ls -d "$CODEX"/plugins/cache/*/leopold* >/dev/null 2>&1; then
    pass "Codex: hooks wired via plugin"
  else
    note "Codex: hooks not wired — run ./install.sh --harness codex"
  fi
fi

if [ -f "$CLAUDE/enhance/enhance.py" ]; then
  if grep -q 'enhance.py --event' "$CLAUDE/settings.json" 2>/dev/null; then
    st="$(python3 "$CLAUDE/enhance/enhance.py" --event status 2>/dev/null || echo '?')"
    pass "prompt enhancer installed + wired ($st)"
  else
    note "prompt enhancer installed but not wired — leopold menu (enhance -> Install)"
  fi
else
  note "prompt enhancer not installed (optional) — leopold menu (enhance -> Install)"
fi

if [ -d "$CLAUDE/skills/gstack" ] || [ -d "$CLAUDE/skills/spec" ]; then
  pass "gstack detected — planning toolchain available"
else
  note "gstack not installed (optional) — 'make gstack-install' to enable planning"
fi

if command -v node >/dev/null 2>&1; then pass "node present ($(node -v 2>/dev/null)) — SDK driver usable"; else note "node missing — the SDK driver (optional) needs Node 18+"; fi

if [ -f "$SRC/VERSION" ]; then
  pass "engine source at $SRC (v$(tr -d '[:space:]' < "$SRC/VERSION"))"
  up="$(bash "$SRC/scripts/leopold-update-check.sh" 2>/dev/null || true)"
  [ -n "$up" ] && note "$up — run: make update"
else
  note "no source clone at $SRC (plugin install? update via 'claude plugin update')"
fi

echo
echo "summary: $ok ok, $warn warnings, $bad problems"
[ "${bad:-0}" -eq 0 ] && echo "Leopold looks healthy." || echo "Fix the [FAIL] items above."
exit 0
