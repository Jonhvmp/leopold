#!/usr/bin/env bash
# Leopold installer — Codex CLI side.
#
# Codex reimplemented Claude Code's hook contract, field for field. PreToolUse
# carries the same `tool_name` / `tool_input` / `cwd` keys (its shell tool is even
# reported as "Bash") and honors the same
# {"hookSpecificOutput":{"permissionDecision":"deny",…}} reply; Stop carries `cwd`,
# `transcript_path` and `stop_hook_active` and honors {"decision":"block","reason":…}.
# So BOTH of Leopold's hooks — the git lock and the autonomous continuity engine —
# are the same scripts here. This installer only has to put the skills where Codex
# looks and declare the hooks in TOML instead of JSON.
#
# The one thing that differs: Codex holds a config-declared hook untrusted until you
# approve it once. Until then the hooks are inert in interactive sessions. Headless
# workers started by `leopold run --provider codex` arm themselves.
#
# Usage: install-codex.sh <source-tree> <leopold-asset-home>
set -euo pipefail

SRC="${1:?usage: install-codex.sh <source-tree> <leopold-asset-home>}"
LEO_HOME="${2:?usage: install-codex.sh <source-tree> <leopold-asset-home>}"
CODEX="${CODEX_HOME:-$HOME/.codex}"
SKILLS="$CODEX/skills"
CONFIG="$CODEX/config.toml"
GUARD="$LEO_HOME/hooks/guard-irreversible.sh"
STOP="$LEO_HOME/hooks/stop-continuity.sh"

# The TOML/JSON writers live in ONE place (extensions/lib/harness.sh) so this
# installer and the four extensions cannot drift apart.
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/extensions/lib/harness.sh"
[ -f "$LIB" ] || { echo "install-codex.sh: missing $LIB" >&2; exit 1; }
# shellcheck source=../extensions/lib/harness.sh
. "$LIB"

echo "-> installing Leopold into Codex ($CODEX)"
mkdir -p "$SKILLS"

for d in "$SRC"/skills/*/; do
  name="$(basename "$d")"
  rm -rf "${SKILLS:?}/$name"
  cp -R "$d" "$SKILLS/$name"
done
echo "   skills -> $SKILLS"

if [ ! -f "$GUARD" ] || [ ! -f "$STOP" ]; then
  echo "   warn: hooks not found under $LEO_HOME/hooks — skipping the hook wiring."
  exit 0
fi
chmod +x "$GUARD" "$STOP" 2>/dev/null || true

# --- wire both hooks into config.toml --------------------------------------
# One managed, marker-delimited block: idempotent, backed up, validated, and
# rolled back rather than left unparseable. See extensions/lib/harness.sh.
# shellcheck disable=SC2034  # read by leo_wire_hooks_toml (extensions/lib/harness.sh)
LEO_TOML_COMMENT="# Leopold. Both hooks are no-ops unless a Leopold run is active in the project
# (.leopold/state.json), so they are safe to leave installed. Re-run the Leopold
# installer to update; anything you edit between the markers gets replaced.
#
# 1. Git lock: denies git commit / git push during an autonomous run.
# 2. Continuity: blocks the stop and re-injects the next plan item until the
#    plan is done or a stop condition fires."

if ! leo_wire_hooks_toml "$CONFIG" leopold \
      "PreToolUse|Bash|$GUARD|5" \
      "Stop||$STOP|15"; then
  echo "   warn: could not wire the hooks — Codex skills are installed, hooks are not."
  echo "         Paste the block above into $CONFIG and re-run: leopold doctor"
  exit 0
fi
echo "   git lock + continuity -> $CONFIG"

# --- trust ------------------------------------------------------------------
# Codex will not run a config-declared hook until you have trusted it once. That
# gate is deliberate and Leopold does not try to forge it: open Codex once and
# approve the Leopold hooks. Headless runs started by `leopold run --provider codex`
# pass --dangerously-bypass-hook-trust for their own workers, so the lock holds
# there from the first turn.
cat <<EOF

   One manual step: Codex holds new hooks untrusted until you approve them.
   Open Codex once in any project and accept the two Leopold hooks — after that
   the git lock and autonomous continuity are live in interactive sessions too.
EOF
