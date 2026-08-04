#!/usr/bin/env bash
# enhance extension - global prompt enhancer (one UserPromptSubmit hook + Haiku).
#
# Installed (wired, but OFF) by the main Leopold installer; this manager is the
# control plane: toggle flips enabled in state.json, remove is the full destroy
# (unwires the hook from EVERY harness and deletes the enhance dir including the
# ledger + learned profile). See README.md in this folder.
#
# HARNESS PARITY. The hook is wired once per harness on this machine —
# ~/.claude/settings.json (JSON) and ~/.codex/config.toml (TOML) — through the one
# shared writer in ../lib/harness.sh. The DATA (state.json, ledger, profile) is a
# single directory for the whole machine, so `toggle` in a Codex session and
# `toggle` in a Claude Code session are the same switch, and `status` says the same
# thing on both.
#
# Verified against codex-cli 0.146.0: its UserPromptSubmit payload carries
# session_id, turn_id, transcript_path, cwd, hook_event_name, model,
# permission_mode and prompt — every field the engine reads — and it consumes an
# injected reading through hookSpecificOutput.additionalContext.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "enhance/manage.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"

ENHANCE_DIR="$(leo_enhance_dir)"
export LEOPOLD_ENHANCE_DIR="$ENHANCE_DIR"   # the engine resolves the same dir we do
HOOK_MARK='enhance.py --event'

engine() { python3 "$ENHANCE_DIR/enhance.py" "$@"; }

# Where each harness keeps the hook we wire.
hooks_file() { # <harness>
  case "$1" in claude) leo_settings_file ;; codex) leo_config_file ;; esac
}

wired_count() { # <harness> -> how many enhance hooks are declared there
  local f n; f="$(hooks_file "$1")"
  [ -f "$f" ] || { echo 0; return; }
  n="$(grep -c "$HOOK_MARK" "$f" 2>/dev/null || true)"
  echo "${n:-0}"
}

case "${1:-}" in
  detect)
    [ -f "$ENHANCE_DIR/enhance.py" ]
    ;;

  status)
    # One line (the menu renders it inline). The on/off half is machine-wide by
    # design; the wiring half is per harness, because that part genuinely differs.
    if [ -f "$ENHANCE_DIR/enhance.py" ]; then
      printf '%s' "$(engine --event status 2>/dev/null || echo "engine error")"
      for h in $(leo_harness_targets); do
        printf ' · %s: hook %s' "$(leo_harness_label "$h")" \
          "$([ "$(wired_count "$h")" -ge 1 ] && echo wired || echo "NOT wired")"
      done
      echo
    else
      echo "not installed"
    fi
    ;;

  install|update)
    # idempotent: re-vendors the engine, preserves state.json / profile / ledger.
    bash "$HERE/install.sh"
    ;;

  toggle)
    [ -f "$ENHANCE_DIR/enhance.py" ] || { echo "not installed (run: manage.sh install)" >&2; exit 1; }
    # One state file, so this flips the enhancer for every harness at once — which
    # is the point: it is a preference about the user, not about the agent.
    engine --event toggle "${2:-}"
    ;;

  remove)
    for h in $(leo_harness_targets); do
      case "$h" in
        claude) leo_unwire_hooks_json "$(leo_settings_file)" enhance "$HOOK_MARK" >/dev/null 2>&1 \
                  && echo "$(leo_harness_label "$h"): unwired the enhance hook" ;;
        codex)  leo_unwire_hooks_toml "$(leo_config_file)" enhance >/dev/null 2>&1 \
                  && echo "$(leo_harness_label "$h"): unwired the enhance hook" ;;
      esac
    done
    rm -rf "$ENHANCE_DIR"
    echo "removed $ENHANCE_DIR (engine, state, ledger and learned profile)"
    ;;

  doctor)
    echo "engine:   $([ -f "$ENHANCE_DIR/enhance.py" ] && echo "$ENHANCE_DIR/enhance.py" || echo missing)"
    echo "state:    $(engine --event status 2>/dev/null || echo "unreadable")  (shared by every harness)"
    for h in $(leo_harness_targets); do
      echo "$(leo_harness_label "$h"):"
      echo "  hook:   $(wired_count "$h")/1 wired in $(hooks_file "$h")"
      [ "$h" = codex ] && echo "  note:   Codex keeps a config-declared hook inert until you approve it once."
    done
    # The rewriter is Haiku through the `claude` CLI — the only part of the enhancer
    # that is Claude-specific, and it stays that way on purpose: a `codex exec` turn
    # costs minutes, and this runs inside a 30s prompt hook. Say so instead of
    # leaving a Codex-only user with a switch that reads "on" and never fires.
    if command -v claude >/dev/null 2>&1 || [ -n "${LEOPOLD_ENHANCE_CLAUDE_BIN:-}" ]; then
      echo "rewriter: claude CLI on PATH (Haiku, your own account)"
    else
      echo "rewriter: UNAVAILABLE — the enhancer rewrites with \`claude -p --model haiku\`,"
      echo "          and the claude CLI is not on PATH. The hook stays a silent pass-through"
      echo "          (prompts are never altered) until you install it."
    fi
    if [ -f "$ENHANCE_DIR/enhancements.jsonl" ]; then
      echo "ledger:   $(wc -l < "$ENHANCE_DIR/enhancements.jsonl" | tr -d ' ') line(s), $(du -h "$ENHANCE_DIR/enhancements.jsonl" | cut -f1)"
    else
      echo "ledger:   empty (no enhancements yet)"
    fi
    echo "profile:  $([ -f "$ENHANCE_DIR/PROMPT-PROFILE.md" ] && echo present || echo missing)"
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor|toggle [on|off]}" >&2
    exit 2
    ;;
esac
