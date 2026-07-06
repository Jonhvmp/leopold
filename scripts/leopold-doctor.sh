#!/usr/bin/env bash
# leopold doctor — verify the Leopold install: skills, hooks + wiring, gstack,
# the driver toolchain, and whether an update is available.
set -u
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
ok=0; warn=0; bad=0
pass(){ echo "  [ok]   $1"; ok=$((ok+1)); }
miss(){ echo "  [FAIL] $1"; bad=$((bad+1)); }
note(){ echo "  [warn] $1"; warn=$((warn+1)); }

echo "leopold doctor"
echo

command -v jq >/dev/null 2>&1 && pass "jq present" || miss "jq missing (the hooks need it)"

n=$(ls -d "$CLAUDE"/skills/leopold-* 2>/dev/null | wc -l | tr -d ' ')
[ "${n:-0}" -ge 4 ] && pass "skills installed ($n)" || miss "skills not installed ($n found) — run ./install.sh"

if [ -x "$CLAUDE/leopold/hooks/stop-continuity.sh" ] && [ -x "$CLAUDE/leopold/hooks/guard-irreversible.sh" ]; then
  pass "hooks installed + executable"
else
  miss "hooks not installed — run ./install.sh"
fi

if [ -f "$CLAUDE/settings.json" ] && grep -q 'leopold/hooks' "$CLAUDE/settings.json" 2>/dev/null; then
  pass "hooks wired in settings.json"
elif ls -d "$CLAUDE"/plugins/cache/*/leopold* >/dev/null 2>&1; then
  pass "hooks wired via plugin"
else
  note "hooks not wired (no leopold hook in settings, no plugin) — run ./install.sh or install the plugin"
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
