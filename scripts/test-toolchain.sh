#!/usr/bin/env bash
# Behavior tests for the two-surface toolchain: the assets (VERSION) and the npm driver
# (`leopold-driver` on PATH). Covers the version pair, the shadowed-install detection,
# what `leopold-update-check.sh` reports, what doctor says, and what `leopold-update.sh`
# does when npm succeeds into a prefix PATH does not resolve.
#
# Hermetic: temp HOME / CLAUDE_HOME / CODEX_HOME / LEOPOLD_HOME / LEOPOLD_SRC, a stubbed
# PATH carrying fake driver binaries, and a stubbed git and npm. No network, never ~/.
# Exits non-zero on any failure.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/scripts/lib/toolchain.sh"
CHECK="$ROOT/scripts/leopold-update-check.sh"
UPDATE="$ROOT/scripts/leopold-update.sh"
DOCTOR="$ROOT/scripts/leopold-doctor.sh"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
fail=0

eq() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 (expected '$2', got '$3')"; fail=1; fi
}
has() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "  ok: $1"
  else echo "  FAIL: $1 (missing '$3')"; fail=1; fi
}
hasnt() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "  FAIL: $1 (unexpectedly found '$3')"; fail=1
  else echo "  ok: $1"; fi
}

# A fake driver binary that reports the version it was built with.
mkdriver() { # <dir> <version>
  mkdir -p "$1"
  printf '#!/usr/bin/env bash\n[ "${1:-}" = "--version" ] && { echo "%s"; exit 0; }\nexit 1\n' "$2" > "$1/leopold-driver"
  chmod +x "$1/leopold-driver"
}

export HOME="$T/home"
export CLAUDE_HOME="$T/home/.claude" CODEX_HOME="$T/home/.codex"
export LEOPOLD_HOME="$T/leo" LEOPOLD_SRC="$T/src"
mkdir -p "$HOME" "$CLAUDE_HOME" "$CODEX_HOME" "$LEOPOLD_HOME"
mkdir -p "$LEOPOLD_SRC/scripts" && echo "0.21.1" > "$LEOPOLD_SRC/VERSION"

# The suite must see ONLY the drivers it plants. A machine running these tests very
# likely has a real leopold-driver (and npm) on PATH, and either one leaking in would
# make the assertions describe the developer's laptop instead of the fixture.
path_without() { # $1 = space-separated binary names -> PATH with every dir holding one removed
  local names="$1" out="" dir name skip oldifs="$IFS"
  IFS=:
  # shellcheck disable=SC2086  # deliberate word-split of PATH on the IFS set above
  set -- $PATH
  IFS="$oldifs"
  for dir in "$@"; do
    [ -n "$dir" ] || continue
    skip=0
    for name in $names; do [ -x "$dir/$name" ] && skip=1; done
    [ "$skip" = "0" ] && out="${out:+$out:}$dir"
  done
  printf '%s' "$out"
}
BASE_PATH="$(path_without "leopold-driver")"
NONPM_PATH="$(path_without "leopold-driver npm")"
NEW="$T/bin-new"; OLD="$T/bin-old"

# =============================================================================
echo "toolchain lib — the two surfaces, read from one place"
# =============================================================================
# shellcheck source=lib/toolchain.sh
. "$LIB"

eq "the asset version is read from VERSION" "0.21.1" "$(leo_asset_version "$LEOPOLD_SRC")"
eq "a home with no VERSION reports nothing, it does not guess" "" "$(leo_asset_version "$T/nowhere")"

mkdriver "$NEW" "0.21.1"
mkdriver "$OLD" "0.14.0"

# The reported shape: a stale install from an early-August npm prefix sits EARLIER in
# PATH than the one npm just wrote, so PATH keeps resolving the old binary.
export PATH="$OLD:$NEW:$BASE_PATH"
eq "the driver version is the one PATH actually resolves, not the newest installed" \
  "0.14.0" "$(leo_driver_version)"
eq "every install on PATH is found, in PATH order" "$OLD/leopold-driver $NEW/leopold-driver" \
  "$(leo_bin_installs leopold-driver | tr '\n' ' ' | sed 's/ $//')"
eq "a specific binary can be asked its own version" "0.21.1" "$(leo_driver_version_at "$NEW/leopold-driver")"

conf="$(leo_driver_conflicts || true)"
has "conflicting installs are reported" "$conf" "$OLD/leopold-driver 0.14.0"
has "...both of them" "$conf" "$NEW/leopold-driver 0.21.1"
eq "...the winner is first, so a caller can name it" "$OLD/leopold-driver 0.14.0" \
  "$(printf '%s' "$conf" | head -1)"

# Two installs of the SAME version are not a conflict to shout about, and one install is
# never a conflict at all.
mkdriver "$OLD" "0.21.1"
eq "same version twice is not reported as a conflict" "" "$(leo_driver_conflicts || true)"
export PATH="$NEW:$BASE_PATH"
eq "a single install is not a conflict" "" "$(leo_driver_conflicts || true)"
# A duplicated PATH entry is one install, not two.
export PATH="$NEW:$NEW:$BASE_PATH"
eq "a repeated PATH entry is collapsed" "1" "$(leo_bin_installs leopold-driver | wc -l | tr -d ' ')"

# =============================================================================
echo
echo "update-check — the local half runs even when the network half is throttled"
# =============================================================================
# Throttle the network check the way a second run in the same day would.
mkdir -p "$HOME/.leopold" && date +%s > "$HOME/.leopold/.last-update-check"

mkdriver "$OLD" "0.14.0"
export PATH="$OLD:$BASE_PATH"
out="$(bash "$CHECK" 2>/dev/null || true)"
has "a driver behind the assets is reported as drift" "$out" "DRIVER_DRIFT 0.14.0 0.21.1"
hasnt "...and the throttled network check stays quiet" "$out" "UPDATE_AVAILABLE"

export PATH="$OLD:$NEW:$BASE_PATH"
out="$(bash "$CHECK" 2>/dev/null || true)"
has "a shadowed install is reported, naming the one PATH runs" "$out" "DRIVER_SHADOWED $OLD/leopold-driver 0.14.0"

export PATH="$NEW:$BASE_PATH"
out="$(bash "$CHECK" 2>/dev/null || true)"
eq "a toolchain that agrees says nothing at all" "" "$out"

# No driver installed is a fact, not a drift: the in-session engine needs no Node.
export PATH="$BASE_PATH"
out="$(bash "$CHECK" 2>/dev/null || true)"
hasnt "no driver installed is not reported as drift" "$out" "DRIVER_DRIFT"

# =============================================================================
echo
echo "doctor — the pair is visible at a glance, a split is a FAILURE"
# =============================================================================
export PATH="$NEW:$BASE_PATH"
out="$(bash "$DOCTOR" 2>&1 || true)"
has "agreement is stated with both numbers" "$out" "toolchain: driver 0.21.1 · assets 0.21.1"

export PATH="$OLD:$BASE_PATH"
out="$(bash "$DOCTOR" 2>&1 || true)"
has "a split toolchain is a FAIL, not a warning" "$out" "[FAIL] toolchain SPLIT: driver 0.14.0 · assets 0.21.1"
has "...and it names the command that fixes it" "$out" "npm i -g leopold-driver@0.21.1"

export PATH="$OLD:$NEW:$BASE_PATH"
out="$(bash "$DOCTOR" 2>&1 || true)"
has "shadowed installs are a FAIL naming the winner" "$out" "PATH runs $OLD/leopold-driver (0.14.0)"
has "...and both installs are listed" "$out" "$NEW/leopold-driver  (0.21.1)"

export PATH="$BASE_PATH"
out="$(bash "$DOCTOR" 2>&1 || true)"
has "no driver is reported as optional, never as broken" "$out" "driver not installed (optional"

# =============================================================================
echo
echo "update — one update moves BOTH surfaces, or says which half it could not move"
# =============================================================================
# A source clone the updater will accept, with git stubbed so nothing hits the network.
mkdir -p "$LEOPOLD_SRC/.git" "$T/stub"
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/stub/git"; chmod +x "$T/stub/git"
printf '#!/usr/bin/env bash\nexit 0\n' > "$LEOPOLD_SRC/install.sh"; chmod +x "$LEOPOLD_SRC/install.sh"

# @scenario the self-reinforcing failure: npm reports success, but PATH still resolves an
# older install in another prefix. Before this, the operator read success and kept running
# the stale binary.
printf '#!/usr/bin/env bash\necho "installed (into a prefix PATH does not resolve)"\nexit 0\n' > "$T/stub/npm"
chmod +x "$T/stub/npm"
mkdriver "$OLD" "0.14.0"
export PATH="$T/stub:$OLD:$NEW:$BASE_PATH"
out="$(bash "$UPDATE" 2>&1 || true)"
has "a shadowed driver is not passed off as updated" "$out" "PATH still resolves 0.14.0"
has "...the shadowing install is named" "$out" "$OLD/leopold-driver  (0.14.0)"
has "...and the assets are still reported as moved" "$out" "assets updated to 0.21.1"
hasnt "...it never claims both surfaces are current" "$out" "current on both surfaces"

# @scenario npm missing entirely: the assets move, the driver cannot, and the split is
# stated instead of being left for the next release to discover.
mkdir -p "$T/stub-nonpm"; cp "$T/stub/git" "$T/stub-nonpm/git"
export PATH="$T/stub-nonpm:$OLD:$NONPM_PATH"
out="$(bash "$UPDATE" 2>&1 || true)"
has "no npm is stated as a split toolchain" "$out" "npm is not on PATH"
has "...naming both versions" "$out" "stayed at 0.14.0 while the assets moved to 0.21.1"

# @scenario the happy path: npm installs into the prefix PATH resolves.
printf '#!/usr/bin/env bash\ncp "%s/leopold-driver" "%s/leopold-driver"\nexit 0\n' "$NEW" "$OLD" > "$T/stub/npm"
chmod +x "$T/stub/npm"
mkdriver "$OLD" "0.14.0"
export PATH="$T/stub:$OLD:$BASE_PATH"
out="$(bash "$UPDATE" 2>&1 || true)"
has "an update that lands says both surfaces are current" "$out" "Driver: now at 0.21.1"
has "...explicitly naming both" "$out" "current on both surfaces"

# @scenario already current: no npm call is made at all.
printf '#!/usr/bin/env bash\necho "NPM-WAS-CALLED"\nexit 0\n' > "$T/stub/npm"; chmod +x "$T/stub/npm"
export PATH="$T/stub:$NEW:$BASE_PATH"
out="$(bash "$UPDATE" 2>&1 || true)"
has "an already-current driver is left alone" "$out" "already at 0.21.1"
hasnt "...npm is not run for nothing" "$out" "NPM-WAS-CALLED"

export PATH="$BASE_PATH"
echo
if [ "$fail" = "0" ]; then echo "all toolchain tests passed"; else echo "TOOLCHAIN TESTS FAILED"; fi
exit "$fail"
