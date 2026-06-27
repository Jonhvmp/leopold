#!/usr/bin/env bash
# `leopold up` — one command to make a project extract the most from Claude Code.
#
# The machine-setup half (the part a shell can do): install the Leopold harness,
# and seed a sane per-project permissions allowlist so routine dev work stops
# prompt-flooding. The in-session half (CLAUDE.md via /init, the app run-skill via
# /run-skill-generator, MCP checks) is the /leopold-up skill — printed as the next
# step, because those run inside a Claude Code session, not a shell.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # assets/ (or repo root in dev)
PROJ="${LEOPOLD_PROJECT:-$PWD}"
SETTINGS="$PROJ/.claude/settings.json"

echo "leopold up — setting up $(basename "$PROJ")"
echo

# 1) Install the harness (skills + hooks into ~/.claude). Idempotent.
echo "==> installing the Leopold harness"
bash "$ROOT/install.sh" "$@"
echo

# 2) Seed a per-project permissions allowlist (kills the prompt-flood for routine
#    dev work). Merge — never clobber an existing allow list. Needs jq.
echo "==> seeding a permissions allowlist into .claude/settings.json"
if command -v jq >/dev/null 2>&1; then
  mkdir -p "$PROJ/.claude"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  ALLOW='[
    "Read(*)","Grep(*)","Glob(*)",
    "Bash(git status:*)","Bash(git diff:*)","Bash(git log:*)","Bash(git add:*)","Bash(git show:*)","Bash(git branch:*)","Bash(git fetch:*)",
    "Bash(ls:*)","Bash(cat:*)","Bash(rg:*)","Bash(find:*)","Bash(tree:*)","Bash(pwd)","Bash(echo:*)",
    "Bash(npm run:*)","Bash(npm test:*)","Bash(npm ci:*)","Bash(npm install:*)","Bash(pnpm:*)","Bash(yarn:*)","Bash(npx:*)",
    "Bash(node:*)","Bash(tsc:*)","Bash(make:*)","Bash(python3:*)","Bash(pytest:*)","Bash(cargo:*)","Bash(go:*)"
  ]'
  tmp="$(mktemp)"
  jq --argjson add "$ALLOW" '
    .permissions = (.permissions // {}) |
    .permissions.allow = ((.permissions.allow // []) + $add | unique)
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "   merged $(jq '.permissions.allow | length' "$SETTINGS") allow rules into $SETTINGS"
else
  echo "   (skipped — jq not found; install jq to auto-seed the allowlist)"
fi
echo

# 3) Point at the in-session finish + the brief.
cat <<'EOF'
==> next steps (inside Claude Code, in this project)
   1. /leopold-up      finish setup: CLAUDE.md (/init), teach the app (/run-skill-generator), check MCP
   2. /leopold-brief   debate the mission/charter/plan with Leopold
   3. /leopold-run     hand it the seat — autonomous, reviewed, git-locked

Tip: `leopold-driver run --parallel 3` runs independent plan items concurrently;
     `leopold-driver insights` summarizes a run afterward.
EOF
