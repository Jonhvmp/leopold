#!/usr/bin/env bash
# enhance installer — vendors the engine into the enhance data dir and wires ONE
# UserPromptSubmit hook into EVERY harness on this machine (idempotent: re-running
# never duplicates the entry and never clobbers state.json / profile / ledger).
#
#   Claude Code  ~/.claude/settings.json   (JSON)
#   Codex CLI    ~/.codex/config.toml      (TOML, marker-delimited managed block)
#
# The format-specific writers live in ONE place (../lib/harness.sh); this file only
# decides WHAT to wire, never HOW to spell it.
#
# ONE data dir for the machine (leo_enhance_dir), not one per harness: the enhancer
# is a single user preference, so turning it on in Codex has to read as on in Claude
# Code too — and its learned prompt profile is about the user, not the agent.
#
# The enhancer installs WIRED BUT OFF (state.json enabled:false): the hook is a
# silent no-op until the user opts in via `leopold menu` -> enhance -> Toggle,
# or /leopold-enhance on. A quick capability probe (--safe-mode availability) runs in
# the background so the install never blocks on a network call.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "enhance/install.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"

ENHANCE_DIR="$(leo_enhance_dir)"

say() { printf '\033[1;35m[enhance]\033[0m %s\n' "$*"; }

command -v python3 >/dev/null 2>&1 || { say "python3 is required - install it and re-run"; exit 1; }
# jq is only needed for the Claude Code half; a Codex-only box wires pure TOML.
if leo_has_harness claude && ! command -v jq >/dev/null 2>&1; then
  say "jq is required to wire the hook into settings.json - install it and re-run"; exit 1
fi

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
SPEC="UserPromptSubmit||python3 $ENHANCE_DIR/enhance.py --event user-prompt|30"
LEO_TOML_COMMENT="# leopold-enhance (Leopold extension). Interprets weak prompts before they
# reach the model and injects a structured reading next to the raw prompt.
# Wired but INERT until you turn it on: leopold menu -> enhance -> Toggle." \
  leo_wire_hooks enhance "$SPEC" || say "the hook could not be wired everywhere — see the warning above"

for h in $(leo_harness_targets); do
  say "hook wired for $(leo_harness_label "$h")"
done
if leo_has_harness codex; then
  say "Codex keeps a config-declared hook inert until you approve it once — open Codex and accept it."
fi

# ---- background capability probe (never blocks the install) -------------------
if [ "${CI:-}" != "1" ] && [ "${LEOPOLD_ENHANCE_NO_PROBE:-}" != "1" ]; then
  (LEOPOLD_ENHANCE_DIR="$ENHANCE_DIR" python3 "$ENHANCE_DIR/enhance.py" --event probe >/dev/null 2>&1 &)
fi

state="$(LEOPOLD_ENHANCE_DIR="$ENHANCE_DIR" python3 "$ENHANCE_DIR/enhance.py" --event status 2>/dev/null || echo off)"
say "installed at $ENHANCE_DIR - enhancer is ${state}"
if [ "$state" = "off" ]; then
  say "turn it on:  leopold menu -> enhance -> t) Toggle   (or /leopold-enhance on)"
fi
say "kill switch: LEOPOLD_ENHANCE_DISABLE=1   debug: LEOPOLD_ENHANCE_DEBUG=1"
