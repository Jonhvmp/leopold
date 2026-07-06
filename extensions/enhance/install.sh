#!/usr/bin/env bash
# enhance installer - vendors the engine to ~/.claude/enhance and wires ONE
# UserPromptSubmit hook into ~/.claude/settings.json (idempotent: re-running
# never duplicates the entry and never clobbers state.json / profile / ledger).
#
# The enhancer installs WIRED BUT OFF (state.json enabled:false): the hook is a
# silent no-op until the user opts in via `leopold menu` -> enhance -> Toggle,
# or /leopold-enhance on. A quick capability probe (--safe-mode availability) runs in
# the background so the install never blocks on a network call.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
ENHANCE_DIR="$CLAUDE/enhance"
SETTINGS="$CLAUDE/settings.json"

say() { printf '\033[1;35m[enhance]\033[0m %s\n' "$*"; }

command -v python3 >/dev/null 2>&1 || { say "python3 is required - install it and re-run"; exit 1; }
command -v jq >/dev/null 2>&1 || { say "jq is required to wire the hook - install it and re-run"; exit 1; }

# ---- vendor the engine -------------------------------------------------------
mkdir -p "$ENHANCE_DIR/sessions"
cp "$HERE/payload/enhance.py" "$ENHANCE_DIR/enhance.py"
chmod +x "$ENHANCE_DIR/enhance.py"
if [ -f "$HERE/payload/RUNTIME.md" ]; then cp "$HERE/payload/RUNTIME.md" "$ENHANCE_DIR/README.md"; fi

# ---- seed state + profile (never clobber on update) --------------------------
if [ ! -f "$ENHANCE_DIR/state.json" ]; then
  printf '{\n  "enabled": false,\n  "model": "haiku"\n}\n' > "$ENHANCE_DIR/state.json"
fi
if [ ! -f "$ENHANCE_DIR/PROMPT-PROFILE.md" ]; then
  cat > "$ENHANCE_DIR/PROMPT-PROFILE.md" <<'EOF'
# Prompt profile

Learned rules about how YOU write prompts, fed to the enhancer's rewriter so its
interpretations read your shorthand the way you mean it. One `- rule` per line.

Edit by hand, or run `/leopold-enhance learn`: it mines your enhancement ledger for
prompts you had to correct and PROPOSES rules here - you review, it never self-edits.
EOF
fi

# ---- wire the hook (idempotent, matched on the exact command string) ----------
UP="python3 $ENHANCE_DIR/enhance.py --event user-prompt"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.enhance.bak"
tmp="$(mktemp)"
jq --arg up "$UP" '
  .hooks //= {} | .hooks.UserPromptSubmit //= []
  | (if any(.hooks.UserPromptSubmit[]?.hooks[]?; .command == $up) then .
     else .hooks.UserPromptSubmit += [{hooks:[{type:"command",command:$up,timeout:30}]}] end)
  | .hooks.UserPromptSubmit |= map(.hooks |= map(if .command == $up then .timeout = 30 else . end))
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
say "hook wired in settings.json (backup at $SETTINGS.enhance.bak)"

# ---- background capability probe (never blocks the install) -------------------
if [ "${CI:-}" != "1" ] && [ "${LEOPOLD_ENHANCE_NO_PROBE:-}" != "1" ]; then
  (python3 "$ENHANCE_DIR/enhance.py" --event probe >/dev/null 2>&1 &)
fi

state="$(python3 "$ENHANCE_DIR/enhance.py" --event status 2>/dev/null || echo off)"
say "installed - enhancer is ${state}"
if [ "$state" = "off" ]; then
  say "turn it on:  leopold menu -> enhance -> t) Toggle   (or /leopold-enhance on)"
fi
say "kill switch: LEOPOLD_ENHANCE_DISABLE=1   debug: LEOPOLD_ENHANCE_DEBUG=1"
