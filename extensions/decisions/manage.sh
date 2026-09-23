#!/usr/bin/env bash
# decisions extension — the menu's uniform contract over the typed-judgement seam.
#
# detect / status / doctor probe a live install and never touch the network: `detect` is what the
# menu calls to decide whether to show "install" or "remove", so it has to be instant and has to
# work on a plane. install / update run the installer (which is also the provider-switch path).
# remove deletes the machine-wide payload and LEAVES the project's catalogs alone — they are the
# project's content, not this tool's, and a reinstall should find them where they were.
#
# NOTHING HERE PRINTS A KEY. `status` and `doctor` report whether the variable is SET; the value
# is never read into a variable that could be echoed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "decisions/manage.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"

DEC_DIR="$(leo_decisions_dir)"
SEAM="$DEC_DIR/decisions.sh"
PROJECT_LEO="${LEOPOLD_PROJECT_DIR:-$PWD}/.leopold"
CONFIG="$PROJECT_LEO/decisions/config.json"

installed() { [ -f "$SEAM" ] && [ -f "$DEC_DIR/catalog.schema.json" ] && [ -f "$DEC_DIR/providers.json" ]; }

active_provider() {
  [ -f "$CONFIG" ] || return 1
  jq -re '.provider // empty' "$CONFIG" 2>/dev/null
}

descriptor_field() { # <provider> <field>
  jq -r --arg p "$1" --arg f "$2" '.providers[$p][$f] // empty' "$CONFIG" 2>/dev/null
}

# The wording lives in ../lib/harness.sh (leo_calibration_label), one home for the shell side,
# pinned to the driver's `calibrationLabel()` by a derived test.
calibration_label() { # <provider>
  leo_calibration_label "$(descriptor_field "$1" calibrated)" "$(descriptor_field "$1" calibration_source)"
}

key_state() { # <provider> -> present|absent|<no auth_env>
  local var; var="$(descriptor_field "$1" auth_env)"
  [ -n "$var" ] || { printf 'no auth_env declared'; return; }
  # `-n "${!var}"` reads the value only to test it; it is never printed or stored.
  if [ -n "${!var:-}" ]; then printf '%s present' "$var"; else printf '%s absent' "$var"; fi
}

case "${1:-}" in
  detect)
    installed
    ;;

  status)
    if ! installed; then echo "not installed"; exit 0; fi
    p="$(active_provider || true)"
    if [ -z "$p" ]; then
      echo "installed · no provider configured for this project (consumers use their deterministic path)"
    else
      printf '%s · %s · %s\n' "$p" "$(calibration_label "$p")" "$(key_state "$p")"
    fi
    ;;

  install|update)
    bash "$HERE/install.sh"
    ;;

  remove)
    # The payload is ours to delete. `.leopold/decisions/` is the PROJECT's — its catalogs are
    # content someone wrote, and every consumer already falls back without us.
    rm -f "$SEAM" "$DEC_DIR/catalog.schema.json" "$DEC_DIR/providers.json" "$DEC_DIR/README.md"
    rmdir "$DEC_DIR" 2>/dev/null || true
    echo "decisions: payload removed from $DEC_DIR"
    [ -d "$PROJECT_LEO/decisions" ] && echo "decisions: left $PROJECT_LEO/decisions/ in place (your catalogs and config)"
    echo "decisions: every consumer is back on its deterministic path"
    ;;

  doctor)
    if installed; then
      echo "decisions: payload installed in $DEC_DIR"
      for f in decisions.sh catalog.schema.json providers.json; do
        [ -f "$DEC_DIR/$f" ] && echo "  ok: $f" || echo "  MISSING: $f — re-run install"
      done
    else
      echo "decisions: not installed (optional — consumers use their deterministic path)"
    fi
    for t in jq curl; do
      command -v "$t" >/dev/null 2>&1 && echo "  ok: $t on PATH" || echo "  MISSING: $t — the shell seam cannot run"
    done
    if [ -f "$CONFIG" ]; then
      p="$(active_provider || true)"
      if [ -n "$p" ]; then
        echo "  project: $CONFIG"
        echo "    provider:    $p"
        echo "    calibration: $(calibration_label "$p")"
        echo "    model:       $(descriptor_field "$p" model)"
        echo "    endpoint:    $(descriptor_field "$p" endpoint)"
        echo "    key:         $(key_state "$p")"
      else
        echo "  project: $CONFIG names no active provider"
      fi
    else
      echo "  project: no $CONFIG — this project asks nothing of a provider"
    fi
    # Catalogs are the project's content; name them and whether they parse, never their contents.
    if [ -d "$PROJECT_LEO/decisions" ]; then
      for c in "$PROJECT_LEO"/decisions/*.json; do
        [ -e "$c" ] || continue
        case "$(basename "$c")" in config.json) continue ;; esac
        if jq -e . "$c" >/dev/null 2>&1; then echo "  ok: catalog $(basename "$c")"
        else echo "  INVALID: catalog $(basename "$c") is not valid JSON"; fi
      done
    fi
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor}" >&2
    exit 64
    ;;
esac
