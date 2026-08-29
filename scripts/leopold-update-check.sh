#!/usr/bin/env bash
# Leopold update check. Silent unless something needs doing. Prints, one per line:
#
#   UPDATE_AVAILABLE <local> <remote>   the VERSION on main is newer than this install
#   DRIVER_DRIFT <driver> <assets>      the driver on PATH is not the assets' version
#   DRIVER_SHADOWED <path> <version>    an older driver earlier in PATH wins over a newer one
#
# The first is a NETWORK check and stays throttled to once every 24h, exactly as before.
# The other two are LOCAL and run every time: they cost no network, and they answer the
# question the throttle must never suppress — "is the thing I am about to run the thing I
# think I installed". Checking only the assets is what let a machine sit seven minors
# apart from itself while this script reported nothing at all.
set -u
SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
# shellcheck source=lib/toolchain.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/toolchain.sh" 2>/dev/null || exit 0

# --- the local half: the two surfaces must agree ----------------------------
# The target is the VERSION of whatever assets are installed. A plugin install has no
# source clone, so fall back to the asset home — the driver can drift there too.
target="$(leo_asset_version "$SRC")"
if [ -z "$target" ]; then
  for h in "${LEOPOLD_HOME:-}" "${CLAUDE_HOME:-$HOME/.claude}/leopold" "${CODEX_HOME:-$HOME/.codex}/leopold"; do
    [ -n "$h" ] || continue
    target="$(leo_asset_version "$h")"
    [ -n "$target" ] && break
  done
fi

if command -v leopold-driver >/dev/null 2>&1; then
  drv="$(leo_driver_version)"
  if [ -n "$target" ] && [ -n "$drv" ] && [ "$drv" != "$target" ]; then
    echo "DRIVER_DRIFT $drv $target"
  fi
  # Reported even when the versions happen to line up: two installs of the same version
  # is a trap waiting for the next update, and it is invisible from `leopold-driver
  # --version` alone.
  conflicts="$(leo_driver_conflicts || true)"
  if [ -n "$conflicts" ]; then
    printf '%s\n' "$conflicts" | head -1 | while IFS=' ' read -r p v; do
      [ -n "$p" ] && echo "DRIVER_SHADOWED $p $v"
    done
  fi
fi

# --- the network half: throttled, failure-safe, unchanged -------------------
# No-op for non-clone installs (e.g. the Claude Code plugin, which updates via
# `claude plugin update`).
[ -f "$SRC/VERSION" ] || exit 0
MARK="$HOME/.leopold/.last-update-check"
mkdir -p "$HOME/.leopold" 2>/dev/null || true
now=$(date +%s 2>/dev/null || echo 0)
if [ -f "$MARK" ]; then
  last=$(cat "$MARK" 2>/dev/null || echo 0)
  [ $((now - last)) -lt 86400 ] 2>/dev/null && exit 0
fi
echo "$now" > "$MARK" 2>/dev/null || true
local_v="$target"
remote_v=$(curl -fsSL --max-time 5 https://raw.githubusercontent.com/Jonhvmp/leopold/main/VERSION 2>/dev/null | tr -d '[:space:]')
[ -z "$remote_v" ] && exit 0
[ "$remote_v" = "$local_v" ] && exit 0
newest=$(printf '%s\n%s\n' "$local_v" "$remote_v" | sort -V 2>/dev/null | tail -1)
[ "$newest" = "$remote_v" ] && echo "UPDATE_AVAILABLE $local_v $remote_v"
exit 0
