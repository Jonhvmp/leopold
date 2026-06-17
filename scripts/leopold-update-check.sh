#!/usr/bin/env bash
# Leopold update check. Throttled (once/24h), network-failure-safe, silent unless
# an update is available. Prints "UPDATE_AVAILABLE <local> <remote>" when the
# VERSION on main is newer than the installed source clone. No-op for non-clone
# installs (e.g. the Claude Code plugin, which updates via `claude plugin update`).
set -u
SRC="${LEOPOLD_SRC:-$HOME/.local/share/leopold}"
[ -f "$SRC/VERSION" ] || exit 0
MARK="$HOME/.leopold/.last-update-check"
mkdir -p "$HOME/.leopold" 2>/dev/null || true
now=$(date +%s 2>/dev/null || echo 0)
if [ -f "$MARK" ]; then
  last=$(cat "$MARK" 2>/dev/null || echo 0)
  [ $((now - last)) -lt 86400 ] 2>/dev/null && exit 0
fi
echo "$now" > "$MARK" 2>/dev/null || true
local_v=$(tr -d '[:space:]' < "$SRC/VERSION" 2>/dev/null)
remote_v=$(curl -fsSL --max-time 5 https://raw.githubusercontent.com/Jonhvmp/leopold/main/VERSION 2>/dev/null | tr -d '[:space:]')
[ -z "$remote_v" ] && exit 0
[ "$remote_v" = "$local_v" ] && exit 0
newest=$(printf '%s\n%s\n' "$local_v" "$remote_v" | sort -V 2>/dev/null | tail -1)
[ "$newest" = "$remote_v" ] && echo "UPDATE_AVAILABLE $local_v $remote_v"
exit 0
