#!/usr/bin/env bash
# CLAUDE.md states the gate in one sentence: "`make test` is the gate. It is what CI
# runs." This suite is that sentence in code, because prose did not hold it.
#
# CI enumerates one step per suite by hand, so a suite added to the Makefile reaches the
# local gate immediately and the workflow only when someone remembers. That is a
# green-CI-over-a-real-regression bug, and it has now happened twice: once with lint
# (SC2034, PR #58 — the Makefile comment above the shellcheck block is its scar), and
# again with scripts/test-doctor-matrix.sh and scripts/test-watch-events.py, which
# `make test` ran and CI did not — the only automated proof of the doctor's capability
# rows and the watch's event registry.
#
# So the two lists are compared instead of trusted, in BOTH directions:
#   * a suite in `make test` and not in ci.yml  -> CI stays green on a regression the
#                                                  local gate catches
#   * a suite in ci.yml and not in `make test`  -> a contributor's clean local run is a
#                                                  promise the pipeline does not keep
#
# The suites are DERIVED, never re-typed: `make -n test` expands the whole gate chain
# (its recipes are printed, not run, so this costs nothing and needs no toolchain), and
# ci.yml is read for the same paths. Adding a suite to the Makefile and forgetting the
# workflow fails HERE, naming the missing step.
#
# HERMETIC: reads two files in the checkout and shells out to `make -n`. Writes nothing,
# runs no suite, touches no home.
#
# MUTATION-VERIFIED: delete the test-doctor-matrix step from .github/workflows/ci.yml and
# this fails naming it; delete the `doctor-test` dependency from the Makefile's `test`
# target and it fails from the other side, naming the CI step nothing local runs.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI="$ROOT/.github/workflows/ci.yml"
MK="$ROOT/Makefile"
fail=0

[ -f "$CI" ] || { echo "  FAIL: no $CI"; exit 1; }
[ -f "$MK" ] || { echo "  FAIL: no $MK"; exit 1; }

# Only the suites: `bash scripts/test-x.sh` / `python3 scripts/test-x.py`. A syntax check
# (`bash -n scripts/test-x.sh`) is not a run and does not match.
SUITE_RE='(bash|python3) scripts/test-[a-z0-9-]+\.(sh|py)'

# The gate's own expansion. MAKEFLAGS is unset so a parent make's flags cannot change
# what -n prints, and --no-print-directory keeps the output to recipe lines.
gate="$(env -u MAKEFLAGS make --no-print-directory -n -C "$ROOT" test 2>/dev/null \
        | grep -oE "$SUITE_RE" | sed 's#.*scripts/##' | sort -u)"
if [ -z "$gate" ]; then
  # No make on this machine (or a make that will not expand): read the Makefile itself.
  # Every test-* recipe in it is in the gate chain today, so this is the same list by a
  # blunter route — and it is still a real comparison, not a skip.
  gate="$(grep -oE "$SUITE_RE" "$MK" | sed 's#.*scripts/##' | sort -u)"
  echo "  note: 'make -n test' produced nothing — deriving from $MK instead"
fi
[ -n "$gate" ] || { echo "  FAIL: no test suites derived from the make gate — the deriver stopped working"; exit 1; }

ci="$(grep -oE "$SUITE_RE" "$CI" | sed 's#.*scripts/##' | sort -u)"
[ -n "$ci" ] || { echo "  FAIL: no test suites found in $CI — the deriver stopped working"; exit 1; }

echo "ci parity: $(printf '%s\n' "$gate" | wc -l | tr -d ' ') suites in the make gate, $(printf '%s\n' "$ci" | wc -l | tr -d ' ') in ci.yml"

for s in $gate; do
  if printf '%s\n' "$ci" | grep -qx -- "$s"; then
    echo "  ok: $s runs in CI"
  else
    echo "  FAIL: 'make test' runs scripts/$s and no CI job does — add a step to .github/workflows/ci.yml"
    fail=1
  fi
done

for s in $ci; do
  printf '%s\n' "$gate" | grep -qx -- "$s" && continue
  echo "  FAIL: CI runs scripts/$s and 'make test' does not — a clean local run would not predict the pipeline"
  fail=1
done

echo
if [ "$fail" = "0" ]; then echo "ci parity: make test and ci.yml run the same suites"; else echo "ci parity: FAILURES"; fi
exit "$fail"
