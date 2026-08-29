#!/usr/bin/env bash
# Update the Leopold engine: pull the latest source, re-run the installer, and bring the
# npm driver to the same version. One update moves the WHOLE toolchain, or it says
# loudly which half it could not move.
set -euo pipefail
SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
if [ ! -d "$SRC/.git" ]; then
  echo "No Leopold source clone at $SRC. Reinstall:"
  echo "  curl -fsSL https://raw.githubusercontent.com/Jonhvmp/leopold/main/install.sh | bash"
  exit 1
fi
# shellcheck source=lib/toolchain.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/toolchain.sh"

echo "-> updating Leopold ($SRC)"
git -C "$SRC" pull --ff-only
"$SRC/install.sh"

target="$(leo_asset_version "$SRC")"
echo "Leopold assets updated to ${target:-unknown}."

# --- the other half of the toolchain ----------------------------------------
# The assets are only one of the two version surfaces. Before this, `leopold-update`
# moved them and stopped, so a machine could sit seven minors apart from itself with
# every message reading "up to date" — the driver's half of a release (a new
# subcommand, say) simply did not exist locally while everything LOOKED updated.
if ! command -v leopold-driver >/dev/null 2>&1; then
  echo "Driver: not installed (optional — the in-session engine needs no Node)."
  echo "        Install it with: npm i -g leopold-driver@${target:-latest}"
  exit 0
fi

current="$(leo_driver_version)"
if [ -n "$target" ] && [ "$current" = "$target" ]; then
  echo "Driver: already at $current — the toolchain is current on both surfaces."
  exit 0
fi

echo "-> updating the driver (${current:-unknown} -> ${target:-latest})"
if ! command -v npm >/dev/null 2>&1; then
  echo "WARNING: npm is not on PATH, so the driver stayed at ${current:-unknown} while the assets moved to ${target:-unknown}."
  echo "         The toolchain is now split. Install npm, then: npm i -g leopold-driver@${target:-latest}"
  exit 0
fi
if ! npm i -g "leopold-driver@${target:-latest}"; then
  echo "WARNING: npm could not install the driver, so it stayed at ${current:-unknown} while the assets moved to ${target:-unknown}."
  echo "         Run it yourself to see why: npm i -g leopold-driver@${target:-latest}"
  exit 0
fi

# npm reporting success is NOT the same as PATH resolving the new binary: npm installs
# into ITS prefix, and an older install earlier in PATH keeps winning. That failure is
# silent and self-reinforcing, so the update re-reads the version it actually gets.
after="$(leo_driver_version)"
if [ -n "$target" ] && [ "$after" != "$target" ]; then
  echo
  echo "WARNING: npm installed leopold-driver@${target}, but PATH still resolves ${after:-unknown}."
  echo "         An older install earlier in PATH is shadowing the new one:"
  conflicts="$(leo_driver_conflicts || true)"
  if [ -n "$conflicts" ]; then
    printf '%s\n' "$conflicts" | while IFS=' ' read -r p v; do
      [ -n "$p" ] || continue
      echo "           $p  ($v)"
    done
    echo "         The FIRST line is the one that runs. Remove it (and the tree it points"
    echo "         into) if it is a stale install, then re-check: leopold-driver --version"
  else
    echo "         Check: command -v leopold-driver && leopold-driver --version"
  fi
  exit 0
fi
echo "Driver: now at ${after:-unknown}. The toolchain is current on both surfaces."
