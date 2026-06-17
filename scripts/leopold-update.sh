#!/usr/bin/env bash
# Update the Leopold engine: pull the latest source and re-run the installer.
set -euo pipefail
SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
if [ ! -d "$SRC/.git" ]; then
  echo "No Leopold source clone at $SRC. Reinstall:"
  echo "  curl -fsSL https://raw.githubusercontent.com/Jonhvmp/leopold/main/install.sh | bash"
  exit 1
fi
echo "-> updating Leopold ($SRC)"
git -C "$SRC" pull --ff-only
"$SRC/install.sh"
echo "Leopold updated to $(tr -d '[:space:]' < "$SRC/VERSION")."
