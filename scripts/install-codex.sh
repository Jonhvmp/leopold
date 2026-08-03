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

BEGIN="# >>> leopold (managed) >>>"
END="# <<< leopold (managed) <<<"

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
# Written as a marker-delimited block so a re-install replaces it exactly and a
# hand-written config is never reformatted. TOML has no merge tool we can rely on
# being present, so we edit text and then VALIDATE the result; a config that no
# longer parses is rolled back rather than left behind.
[ -f "$CONFIG" ] || { mkdir -p "$CODEX"; : > "$CONFIG"; }
cp "$CONFIG" "$CONFIG.leopold.bak"

tmp="$(mktemp)"
# Drop any previous Leopold block (idempotent re-install).
awk -v b="$BEGIN" -v e="$END" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  !skip   { print }
' "$CONFIG" > "$tmp"

# Trim trailing blank lines, then append the fresh block.
awk 'BEGIN{n=0} {lines[NR]=$0} END{last=NR; while (last>0 && lines[last] ~ /^[[:space:]]*$/) last--; for(i=1;i<=last;i++) print lines[i]}' "$tmp" > "$tmp.trim" && mv "$tmp.trim" "$tmp"

{
  [ -s "$tmp" ] && echo ""
  echo "$BEGIN"
  echo "# Leopold. Both hooks are no-ops unless a Leopold run is active in the project"
  echo "# (.leopold/state.json), so they are safe to leave installed. Re-run the Leopold"
  echo "# installer to update; anything you edit between the markers gets replaced."
  echo "#"
  echo "# 1. Git lock: denies git commit / git push during an autonomous run."
  echo "[[hooks.PreToolUse]]"
  echo "matcher = \"Bash\""
  echo ""
  echo "[[hooks.PreToolUse.hooks]]"
  echo "type = \"command\""
  echo "command = \"$GUARD\""
  echo "timeout = 5"
  echo ""
  echo "# 2. Continuity: blocks the stop and re-injects the next plan item until the"
  echo "#    plan is done or a stop condition fires."
  echo "[[hooks.Stop]]"
  echo ""
  echo "[[hooks.Stop.hooks]]"
  echo "type = \"command\""
  echo "command = \"$STOP\""
  echo "timeout = 15"
  echo "$END"
} >> "$tmp"

if command -v python3 >/dev/null 2>&1; then
  if ! python3 - "$tmp" <<'PY'
import sys
try:
    import tomllib
except ModuleNotFoundError:      # Python < 3.11: skip validation rather than fail the install
    sys.exit(0)
with open(sys.argv[1], "rb") as fh:
    tomllib.load(fh)
PY
  then
    echo "   warn: the merged config.toml would not parse — leaving your config untouched."
    echo "         Add this to $CONFIG by hand:"
    echo ""
    sed -n "/^${BEGIN}$/,/^${END}$/p" "$tmp" | sed 's/^/           /'
    rm -f "$tmp"
    exit 0
  fi
fi

mv "$tmp" "$CONFIG"
echo "   git lock + continuity -> $CONFIG (backup at $CONFIG.leopold.bak)"

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
