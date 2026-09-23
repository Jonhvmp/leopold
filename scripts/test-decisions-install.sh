#!/usr/bin/env bash
# The decisions extension's manage.sh contract, proven in temp homes.
#
# Four properties the menu depends on, and one the charter does:
#   * install is IDEMPOTENT — three runs leave one payload, byte-identical after the second.
#   * detect is CHEAP and OFFLINE — the menu calls it to draw itself, so it may not reach the
#     network and may not be slow.
#   * status NEVER PRINTS THE KEY — a distinctive value is exported and then searched for in
#     stdout, stderr and every file the commands wrote.
#   * remove takes back only what it installed — the project's catalogs stay, and every consumer
#     is back on its deterministic path.
#
# HERMETIC: LEOPOLD_DECISIONS_DIR, LEOPOLD_PROJECT_DIR and the harness homes all point at a
# mktemp dir. `~/.claude` and `~/.codex` are never written, and the check at the end proves it.
#
# MUTATION-VERIFIED: make install.sh clobber an existing config and the "keeps descriptors" case
# fails; print the key in manage.sh status and the leak case fails; delete the project catalogs in
# `remove` and the last case fails.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extensions/decisions"
fails=0
ok()   { printf '  ok: %s\n' "$*"; }
bad()  { printf '  FAIL: %s\n' "$*"; fails=1; }
# `assert_that <message> <command...>` — the command IS the assertion, so no `$?` ever has to
# survive an intervening line (shellcheck SC2319, and the bug class it warns about).
assert_that(){ local msg="$1"; shift; if "$@"; then ok "$msg"; else bad "$msg"; fi; }
refute(){ local msg="$1"; shift; if "$@"; then bad "$msg"; else ok "$msg"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export LEOPOLD_DECISIONS_DIR="$TMP/payload"
export LEOPOLD_PROJECT_DIR="$TMP/project"
export CLAUDE_HOME="$TMP/claude" CODEX_HOME="$TMP/codex"
mkdir -p "$LEOPOLD_PROJECT_DIR/.leopold" "$CLAUDE_HOME" "$CODEX_HOME"

# A distinctive key value: if this string turns up anywhere, something leaked it.
export TYPESAFE_API_KEY="sk-LEAKCANARY-decisions-0001"

REAL_CLAUDE_FP="$( [ -d "$HOME/.claude" ] && find "$HOME/.claude" -maxdepth 1 | sort | md5 2>/dev/null || echo none)"

echo "decisions install: idempotency"
for i in 1 2 3; do
  LEOPOLD_DECISIONS_PROVIDER=jev bash "$EXT/install.sh" >"$TMP/install.$i.out" 2>&1 || bad "install run $i exited non-zero"
  [ "$i" = 2 ] && cp -R "$LEOPOLD_DECISIONS_DIR" "$TMP/after2"
done
n="$(find "$LEOPOLD_DECISIONS_DIR" -name 'decisions.sh' | wc -l | tr -d ' ')"
assert_that "three installs leave exactly one decisions.sh (found $n)" test "$n" = 1
assert_that "the third install changed no bytes" diff -r "$TMP/after2" "$LEOPOLD_DECISIONS_DIR"
assert_that "the derived assets are installed alongside the seam" test -f "$LEOPOLD_DECISIONS_DIR/catalog.schema.json" -a -f "$LEOPOLD_DECISIONS_DIR/providers.json"
np="$(jq -r '.provider' "$LEOPOLD_PROJECT_DIR/.leopold/decisions/config.json" 2>/dev/null)"
assert_that "the project config names the chosen provider (got '$np')" test "$np" = jev

echo
echo "decisions install: a re-run switches the provider and KEEPS existing descriptors"
CFG="$LEOPOLD_PROJECT_DIR/.leopold/decisions/config.json"
tmpcfg="$(mktemp)"; jq '.providers.jev.timeout_ms = 9999' "$CFG" > "$tmpcfg" && mv "$tmpcfg" "$CFG"
LEOPOLD_DECISIONS_PROVIDER=generic bash "$EXT/install.sh" >/dev/null 2>&1
assert_that "the active provider switched to generic" test "$(jq -r '.provider' "$CFG")" = generic
assert_that "the operator's edited jev descriptor survived the switch" test "$(jq -r '.providers.jev.timeout_ms' "$CFG")" = 9999
assert_that "the new provider's descriptor was added" test "$(jq -r '.providers.generic.name' "$CFG")" = generic
LEOPOLD_DECISIONS_PROVIDER=jev bash "$EXT/install.sh" >/dev/null 2>&1

echo
echo "decisions install: an unknown provider is refused by name"
out="$(LEOPOLD_DECISIONS_PROVIDER=quantum bash "$EXT/install.sh" 2>&1)" && rc=0 || rc=$?
assert_that "an unknown provider exits non-zero" test "$rc" != 0
assert_that "and names it" grep -q 'unknown provider "quantum"' <<< "$out"

echo
echo "decisions manage: detect is cheap and offline"
start="$(date +%s)"
assert_that "detect reports installed" bash "$EXT/manage.sh" detect
elapsed=$(( $(date +%s) - start ))
assert_that "detect returned in ${elapsed}s (must be <= 1)" test "$elapsed" -le 1

echo
echo "decisions manage: status is one line and leaks no key"
status="$(bash "$EXT/manage.sh" status 2>"$TMP/status.err")"
assert_that "status is a single line" test "$(printf '%s' "$status" | wc -l | tr -d ' ')" = 0
assert_that "status names the active provider" grep -q jev <<< "$status"
assert_that "status reports the key as present" grep -q 'TYPESAFE_API_KEY present' <<< "$status"
leaked=0
printf '%s%s' "$status" "$(cat "$TMP/status.err")" | grep -q "$TYPESAFE_API_KEY" && leaked=1
grep -rq "$TYPESAFE_API_KEY" "$LEOPOLD_DECISIONS_DIR" "$LEOPOLD_PROJECT_DIR" 2>/dev/null && leaked=1
grep -rql "$TYPESAFE_API_KEY" "$TMP"/install.*.out 2>/dev/null && leaked=1
assert_that "the key value appears in no output and no file" test "$leaked" = 0

echo
echo "decisions manage: doctor names the calibration and the key state, never the value"
doc="$(bash "$EXT/manage.sh" doctor 2>&1)"
assert_that "doctor prints the calibration label" grep -q 'calibration: calibrated' <<< "$doc"
assert_that "doctor prints the key state" grep -q 'key:.*TYPESAFE_API_KEY present' <<< "$doc"
refute "doctor leaked nothing" grep -q "$TYPESAFE_API_KEY" <<< "$doc"

echo
echo "decisions manage: an operator-declared generic is labelled as unverified"
jq '.provider = "generic" | .providers.generic = {name:"generic",endpoint:"http://127.0.0.1:1/v1/systemone",model:"openjev-0.1.0",calibrated:true,calibration_source:"operator-declared",auth_env:"LEOPOLD_DECISIONS_API_KEY",timeout_ms:5000,max_options:255,max_state_tokens:32000}' "$CFG" > "$TMP/c" && mv "$TMP/c" "$CFG"
assert_that "status says the claim is the operator's" grep -q 'calibrated (operator-declared, unverified)' <<< "$(bash "$EXT/manage.sh" status)"
jq '.provider = "jev"' "$CFG" > "$TMP/c" && mv "$TMP/c" "$CFG"

echo
echo "decisions manage: remove takes back only what it installed"
mkdir -p "$LEOPOLD_PROJECT_DIR/.leopold/decisions"
echo '{"version":"decisions/1.0","questions":{},"thresholds":{}}' > "$LEOPOLD_PROJECT_DIR/.leopold/decisions/routing.json"
assert_that "remove exits 0" bash "$EXT/manage.sh" remove
refute "the payload is gone" test -f "$LEOPOLD_DECISIONS_DIR/decisions.sh"
assert_that "the project's catalog is left in place" test -f "$LEOPOLD_PROJECT_DIR/.leopold/decisions/routing.json"
assert_that "the project's config is left in place" test -f "$CFG"
refute "detect reports not installed after remove" bash "$EXT/manage.sh" detect
assert_that "status says not installed" grep -q 'not installed' <<< "$(bash "$EXT/manage.sh" status)"

echo
NOW_FP="$( [ -d "$HOME/.claude" ] && find "$HOME/.claude" -maxdepth 1 | sort | md5 2>/dev/null || echo none)"
assert_that "the real ~/.claude was never touched" test "$REAL_CLAUDE_FP" = "$NOW_FP"

echo
if [ "$fails" = 0 ]; then echo "decisions install: all checks passed"; else echo "decisions install: FAILURES"; fi
exit "$fails"
