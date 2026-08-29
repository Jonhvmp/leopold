#!/usr/bin/env bash
# The Leopold toolchain has TWO version surfaces, and they are updated by different
# mechanisms:
#
#   * the ASSETS  — hooks, skills, scripts under the asset home, carrying VERSION;
#                   moved by `leopold-update.sh` (git pull + install.sh).
#   * the DRIVER  — the `leopold-driver` binary on PATH, installed by npm;
#                   moved by `npm i -g leopold-driver`.
#
# Updating one and calling the toolchain current is how a machine ends up seven minors
# apart from itself while every message says "up to date". This file is the ONE place
# that answers "what version is installed where" — sourced by leopold-update.sh,
# leopold-update-check.sh and leopold-doctor.sh, so the updater, the checker and doctor
# cannot drift into three different answers.
#
# Every function is silent-and-empty when the thing it asks about is absent: the driver
# is optional (the in-session engine needs neither Node nor npm), so "no driver" is a
# fact to report, never an error.

# The VERSION the installed assets carry. $1 = source/asset home.
leo_asset_version() {
  [ -n "${1:-}" ] && [ -f "$1/VERSION" ] || return 0
  tr -d '[:space:]' < "$1/VERSION" 2>/dev/null || true
}

# Every executable named $1 on PATH, in PATH order, one absolute path per line.
#
# `which -a` is not portable and is a shell builtin in some shells; walking PATH is both
# portable and testable, which matters because the whole point of this function is to be
# exercised against a stubbed PATH. Duplicate PATH entries are collapsed so a repeated
# directory cannot look like two installs.
leo_bin_installs() {
  [ -n "${1:-}" ] || return 0
  local name="$1" dir p seen="" oldifs="${IFS:-}"
  IFS=:
  # shellcheck disable=SC2086  # deliberate word-split of PATH on the IFS set above
  set -- $PATH
  IFS="$oldifs"
  for dir in "$@"; do
    [ -n "$dir" ] || dir="."
    p="$dir/$name"
    [ -f "$p" ] && [ -x "$p" ] || continue
    case ":$seen:" in *":$p:"*) continue ;; esac
    seen="$seen:$p"
    printf '%s\n' "$p"
  done
}

# The version reported by one specific driver binary. $1 = path.
leo_driver_version_at() {
  [ -n "${1:-}" ] && [ -x "$1" ] || return 0
  "$1" --version 2>/dev/null | head -1 | tr -d '[:space:]' || true
}

# The version of the driver PATH actually resolves — the one that runs when you type
# `leopold-driver`, which is not necessarily the one npm just installed.
leo_driver_version() {
  local p
  p="$(command -v leopold-driver 2>/dev/null || true)"
  [ -n "$p" ] || return 0
  leo_driver_version_at "$p"
}

# Shadowed installs: more than one `leopold-driver` on PATH reporting DIFFERENT versions.
# Prints "<path> <version>" per line, PATH order (so the first line is the winner), and
# returns 1 when there is nothing to report.
#
# This is the failure that hides itself: `npm i -g leopold-driver@latest` succeeds into
# one prefix while PATH resolves an older install in another, so the operator updates,
# reads success, and keeps running the old binary. `leopold-driver update` cannot escape
# it either — that command is executed BY the stale binary. Only something that looks at
# the whole PATH can see it, so doctor and the updater both do.
leo_driver_conflicts() {
  local p v first="" out="" n=0 differs=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    v="$(leo_driver_version_at "$p")"
    [ -n "$v" ] || v="unknown"
    n=$((n + 1))
    if [ -z "$first" ]; then first="$v"; elif [ "$v" != "$first" ]; then differs=1; fi
    out="$out$p $v
"
  done <<EOF
$(leo_bin_installs leopold-driver)
EOF
  [ "$n" -gt 1 ] && [ "$differs" -eq 1 ] || return 1
  printf '%s' "$out"
}
