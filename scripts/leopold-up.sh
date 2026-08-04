#!/usr/bin/env bash
# `leopold up` — one command to make a project extract the most from your agent.
#
# The machine-setup half (the part a shell can do): install the Leopold harness
# into whichever agent you run — Claude Code, Codex CLI, or both — and seed the
# per-project permissions so routine dev work stops prompt-flooding. Each harness
# spells that differently (Claude Code: .claude/settings.json allowlist; Codex:
# a trusted project entry in ~/.codex/config.toml), and both spellings live in the
# one shared writer, extensions/lib/harness.sh.
#
# The in-session half (project memory via /init, the app run-skill, MCP checks) is
# the /leopold-up skill — printed as the next step, because those run inside an
# agent session, not a shell.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # asset home (or repo root in dev)
PROJ="${LEOPOLD_PROJECT:-$PWD}"

# The shared harness helper. It ships next to the scripts in both layouts (repo and
# install), so one relative path covers both; the harness homes are the fallback for
# a stray copy of this script.
LIB=""
for _cand in "$ROOT/extensions/lib/harness.sh" \
             "${LEOPOLD_HOME:-}/extensions/lib/harness.sh" \
             "${CLAUDE_HOME:-$HOME/.claude}/leopold/extensions/lib/harness.sh" \
             "${CODEX_HOME:-$HOME/.codex}/leopold/extensions/lib/harness.sh"; do
  [ -n "$_cand" ] && [ -f "$_cand" ] && { LIB="$_cand"; break; }
done
[ -n "$LIB" ] || { echo "leopold up: missing extensions/lib/harness.sh (looked under $ROOT)" >&2; exit 1; }
# shellcheck source=../extensions/lib/harness.sh
. "$LIB"

# `--harness X` is forwarded to install.sh; honor the same choice here so the
# permissions and the next steps describe the harness that was actually installed.
_want=0
for _a in "$@"; do
  if [ "$_want" = "1" ]; then export LEOPOLD_HARNESS="$_a"; _want=0; continue; fi
  case "$_a" in
    --harness)   _want=1 ;;
    --harness=*) export LEOPOLD_HARNESS="${_a#--harness=}" ;;
  esac
done

TARGETS="$(leo_harness_targets)" || exit 2
_labels=""
for h in $TARGETS; do _labels="${_labels:+$_labels + }$(leo_harness_label "$h")"; done

echo "leopold up — setting up $(basename "$PROJ")"
echo "  harness:  $_labels"
echo "  assets:   $(leo_asset_home)"
echo

# 1) Install the harness (skills + hooks into every harness found). Idempotent.
#    install.sh ships with the source tree (repo or the npm-vendored assets), NOT inside
#    the asset home — so a copy of this script running from ~/.codex/leopold/scripts has
#    no installer next to it. Say that out loud and carry on with the rest instead of
#    dying halfway: a setup that stops with "No such file" reads as a broken product.
INSTALLER=""
for _c in "$ROOT/install.sh" "${LEOPOLD_SRC:-$HOME/.local/share/leopold}/install.sh"; do
  [ -f "$_c" ] && { INSTALLER="$_c"; break; }
done
if [ -n "$INSTALLER" ]; then
  echo "==> installing the Leopold harness"
  bash "$INSTALLER" "$@"
else
  echo "==> skipping the harness install — no install.sh next to $ROOT"
  echo "    (this copy ships without the installer; run \`leopold up\` from the CLI, or"
  echo "     re-install with: curl -fsSL https://raw.githubusercontent.com/Jonhvmp/leopold/main/install.sh | bash)"
fi
echo

# 2) Seed the per-project permissions for each harness present. Claude Code gets a
#    merged allowlist; Codex gets the project marked trusted. Both are backed up,
#    idempotent and validated — see extensions/lib/harness.sh.
echo "==> seeding project permissions"
leo_seed_project_permissions "$PROJ" || echo "   (some permissions could not be seeded — see the warnings above)"
echo

# 3) Point at the in-session finish + the brief, naming the file THIS harness reads.
MEM="$(leo_memory_files)"
FIRST_HARNESS="${TARGETS%% *}"
echo "==> next steps (inside $(leo_harness_label "$FIRST_HARNESS"), in this project)"
echo "   1. /leopold-up      finish setup: project memory ($MEM) via /init, teach the app, check MCP"
echo "   2. /leopold-brief   debate the mission/charter/plan with Leopold"
echo "   3. /leopold-run     hand it the seat — autonomous, reviewed, git-locked"
if leo_has_harness codex && leo_has_harness claude; then
  echo
  echo "   Both harnesses are installed here, and they read different memory files:"
  echo "   Claude Code reads CLAUDE.md, Codex CLI reads AGENTS.md. Run /init in each"
  echo "   (or keep one a pointer to the other) so neither agent starts half-informed."
fi
cat <<'EOF'

Tip: `leopold-driver run --parallel 3` runs independent plan items concurrently;
     `leopold-driver insights` summarizes a run afterward.
EOF
