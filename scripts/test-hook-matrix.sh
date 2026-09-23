#!/usr/bin/env bash
# Pins hooks/hook-matrix.tsv to the probe's captures in docs/reference/hook-events.md.
#
# The matrix is DERIVED, not authored: every row claims something the probe recorded,
# and the header quotes the versions the probe ran against. This test is what keeps that
# true — it re-reads the reference page and fails when the two drift:
#
#   - the `# probed:` header names the exact versions the page's Versions table records
#   - every row is capability / event / harness / status / evidence / note, all non-empty
#   - every status is one of available | substitute | unavailable, every harness claude | codex
#   - every evidence anchor resolves to a heading of that page (rename one and this fails)
#   - `available` only where that harness's captured matrix says the event fired, and
#     `unavailable` only where that harness's captured matrix has no such event
#   - a `substitute` row cites `#<event>-<harness>` if and only if the capture shows that
#     event firing there — the ONE place an anchor is load-bearing, because it is the only
#     signal that splits "fires here, weaker guarantee" (wired) from "not on this harness,
#     the bound is carried elsewhere" (not wired)
#   - and the gate that reads all of this, extensions/lib/harness.sh's
#     `_leo_event_wired_here`, wires an (event, harness) exactly when the capture shows it
#     firing there — asserted against the real function, not restated
#   - no capability lacks a row for either harness, and no (capability, event, harness)
#     is stated twice
#
# HERMETIC: reads two files in the checkout, writes only inside a temp dir.
# Overrides for mutation checks: LEO_MATRIX_TSV, LEO_HOOK_EVENTS_DOC.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSV="${LEO_MATRIX_TSV:-$ROOT/hooks/hook-matrix.tsv}"
DOC="${LEO_HOOK_EVENTS_DOC:-$ROOT/docs/reference/hook-events.md}"

# The gate under test is the real one. Sourced rather than re-spelled: the harness slug
# and the wire/refuse rule are contracts, and a test that keeps its own copy of a contract
# passes while the shipped one drifts. LEO_MATRIX_TSV points it at the file being pinned.
# shellcheck source=../extensions/lib/harness.sh
. "$ROOT/extensions/lib/harness.sh"
export LEO_MATRIX_TSV="$TSV"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

echo "hook-matrix.tsv — the file"
check "hooks/hook-matrix.tsv exists" "$( [ -f "$TSV" ] && echo yes || echo no )" "yes"
check "docs/reference/hook-events.md exists" "$( [ -f "$DOC" ] && echo yes || echo no )" "yes"
if [ ! -f "$TSV" ] || [ ! -f "$DOC" ]; then
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; exit 1
fi

# --- the probed-versions header, read back out of the reference page ------------------
# `# probed: claude "<version>" codex "<version>"` — the versions are the page's own,
# so a re-probe that moves a version and leaves the matrix behind fails here.
doc_version() { # $1 = the Versions-table row label
  awk -v pat="$1" -F'|' '$0 ~ ("^\\| " pat) { gsub(/^[ \t]*`?|`?[ \t]*$/,"",$3); print $3; exit }' "$DOC"
}
DOC_CLAUDE="$(doc_version 'Claude Code CLI')"
DOC_CODEX="$(doc_version 'Codex CLI')"
HDR="$(grep -m1 '^# probed:' "$TSV")"

check "the page records a Claude Code version" "$( [ -n "$DOC_CLAUDE" ] && echo yes || echo no )" "yes"
check "the page records a Codex CLI version"   "$( [ -n "$DOC_CODEX" ]  && echo yes || echo no )" "yes"
check "a '# probed:' header line is present"   "$( [ -n "$HDR" ] && echo yes || echo no )" "yes"
check "the header is the first line"           "$(head -1 "$TSV")" "$HDR"
check "the header quotes the probed versions verbatim" "$HDR" \
      "$(printf '# probed: claude "%s" codex "%s"' "$DOC_CLAUDE" "$DOC_CODEX")"

# --- every heading of the page, as its anchor -----------------------------------------
# Python-Markdown's toc slugify: drop the code ticks the heading renders as <code>, drop
# non-ASCII (the em dash), drop everything but word chars / spaces / hyphens, lowercase,
# then collapse runs of space-or-hyphen into one hyphen.
slugify() {
  printf '%s' "$1" \
    | tr -d '`' \
    | LC_ALL=C tr -d '\200-\377' \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9 _-]//g' -e 's/^ *//' -e 's/ *$//' -e 's/[ -][ -]*/-/g'
}
: > "$TD/anchors"
while IFS= read -r line; do
  slugify "$line" >> "$TD/anchors"; printf '\n' >> "$TD/anchors"
done < <(grep -E '^#{2,4} ' "$DOC" | sed -E 's/^#+ //')
check "the page's headings produced anchors" "$( [ -s "$TD/anchors" ] && echo yes || echo no )" "yes"
check "a known section anchor resolves" "$(grep -cx 'stop-claude-code' "$TD/anchors")" "1"

# --- the two captured matrices: which events fired on which harness --------------------
# `| \`Event\` | yes x12 | …` under `## Matrix — Claude Code (…)` / `## Matrix — Codex CLI (…)`.
awk -F'|' '
  /^## Matrix .* Claude Code/ { h="claude"; next }
  /^## Matrix .* Codex CLI/   { h="codex";  next }
  /^## / && $0 !~ /^## Matrix/ { h=""; next }
  h != "" && /^\| `/ {
    ev=$2; fired=$3
    gsub(/[` \t]/,"",ev)
    if (ev == "Event") next
    print h, ev, (fired ~ /yes/ ? "yes" : "no")
  }
' "$DOC" > "$TD/fired"
check "the Claude Code matrix was parsed" "$(awk '$1=="claude"' "$TD/fired" | wc -l | tr -d ' ')" "33"
check "the Codex CLI matrix was parsed"   "$(awk '$1=="codex"'  "$TD/fired" | wc -l | tr -d ' ')" "12"
check "a not-fired row is read as not fired" "$(awk '$1=="claude" && $2=="PermissionDenied" {print $3}' "$TD/fired")" "no"

echo
echo "hook-matrix.tsv — the rows"

ROWS=0; BADFIELDS=0; BADSTATUS=0; BADHARNESS=0; BADANCHOR=0; BADAVAIL=0; BADUNAVAIL=0; BADEMPTY=0
BADSUB=0
: > "$TD/caps"; : > "$TD/triples"; : > "$TD/pairs"
while IFS=$'\t' read -r cap ev ha st anchor note extra; do
  case "$cap" in '#'*|'') continue ;; esac
  ROWS=$((ROWS+1))
  if [ -n "${extra:-}" ] || [ -z "${note:-}" ]; then
    BADFIELDS=$((BADFIELDS+1)); bad "row '$cap $ev $ha' is not exactly 6 tab-separated fields"
    continue
  fi
  [ -n "$ev" ] && [ -n "$ha" ] && [ -n "$st" ] && [ -n "$anchor" ] || {
    BADEMPTY=$((BADEMPTY+1)); bad "row '$cap' has an empty field"; }
  case "$st" in available|substitute|unavailable) ;; *)
    BADSTATUS=$((BADSTATUS+1)); bad "row '$cap $ev $ha' has status '$st' (not available/substitute/unavailable)" ;; esac
  case "$ha" in claude|codex) ;; *)
    BADHARNESS=$((BADHARNESS+1)); bad "row '$cap $ev' names harness '$ha'" ;; esac
  case "$anchor" in
    '#'*) grep -qxF -- "${anchor#\#}" "$TD/anchors" || {
            BADANCHOR=$((BADANCHOR+1)); bad "row '$cap $ev $ha': evidence '$anchor' is not a heading of hook-events.md"; } ;;
    *)    BADANCHOR=$((BADANCHOR+1)); bad "row '$cap $ev $ha': evidence '$anchor' is not an anchor" ;;
  esac
  fired="$(awk -v h="$ha" -v e="$ev" '$1==h && $2==e {print $3}' "$TD/fired")"
  case "$st" in
    available)
      [ "$fired" = "yes" ] || { BADAVAIL=$((BADAVAIL+1))
        bad "row '$cap $ev $ha' claims available, but the captured $ha matrix does not show $ev firing"; } ;;
    unavailable)
      [ -z "$fired" ] || [ "$fired" = "no" ] || { BADUNAVAIL=$((BADUNAVAIL+1))
        bad "row '$cap $ev $ha' claims unavailable, but the captured $ha matrix shows $ev firing"; } ;;
    substitute)
      # The one place an evidence anchor is load-bearing. `substitute` covers two
      # different things and the writers tell them apart by the anchor alone: a row
      # citing its own harness's captured section means the event FIRES here with a
      # weaker guarantee, and the hook is wired; a row citing anything else means the
      # event is not on this harness at all and the bound is carried elsewhere, so
      # nothing is wired. Get that backwards and extensions/lib/harness.sh either writes
      # a hook that can never fire or drops one that would have.
      want="#$(printf '%s' "$ev" | tr '[:upper:]' '[:lower:]')-$(_leo_harness_slug "$ha")"
      if [ "$anchor" = "$want" ]; then
        [ "$fired" = "yes" ] || { BADSUB=$((BADSUB+1))
          bad "row '$cap $ev $ha' is a substitute citing its own captured section (so the writers WIRE it), but the captured $ha matrix does not show $ev firing"; }
      else
        [ "$fired" = "yes" ] && { BADSUB=$((BADSUB+1))
          bad "row '$cap $ev $ha' is a substitute citing '$anchor' (so the writers DROP it), but the captured $ha matrix shows $ev firing — cite '$want' instead"; }
      fi ;;
  esac
  echo "$cap" >> "$TD/caps"
  echo "$cap $ev $ha" >> "$TD/triples"
  echo "$ev $ha" >> "$TD/pairs"
done < "$TSV"

check "the matrix has rows"                       "$( [ "$ROWS" -gt 0 ] && echo yes || echo no )" "yes"
check "every row has 6 fields"                    "$BADFIELDS"  "0"
check "no field is empty"                         "$BADEMPTY"   "0"
check "every status is one of the three words"    "$BADSTATUS"  "0"
check "every harness is claude or codex"          "$BADHARNESS" "0"
check "every evidence anchor resolves to a heading" "$BADANCHOR" "0"
check "every 'available' row was captured firing" "$BADAVAIL"   "0"
check "every 'unavailable' row is absent from that harness's matrix" "$BADUNAVAIL" "0"
check "every 'substitute' row's anchor agrees with the capture" "$BADSUB" "0"
check "no (capability, event, harness) is stated twice" \
      "$(sort "$TD/triples" | uniq -d | wc -l | tr -d ' ')" "0"

# --- and the GATE that reads all of it -------------------------------------------------
# The three rules above pin the FILE. This pins the code: for every (event, harness) the
# matrix speaks about, extensions/lib/harness.sh must wire it exactly when the probe saw
# it fire there. Asserted against the shipped `_leo_event_wired_here`, so no reading of
# the status word, the anchor, or anything a later column adds can drift from the capture
# without this failing — including the fail-CLOSED shape this replaced, where an
# `available` row whose evidence cited a different (still valid) heading was silently
# refused and the git lock went unwired with every suite green.
BADGATE=0
while read -r ev ha; do
  [ -n "$ev" ] || continue
  fired="$(awk -v h="$ha" -v e="$ev" '$1==h && $2==e {print $3}' "$TD/fired")"
  if _leo_event_wired_here "$ha" "$ev" 2>/dev/null; then gate=wire; else gate=drop; fi
  case "$fired:$gate" in
    yes:wire|no:drop|:drop) ;;
    yes:drop) BADGATE=$((BADGATE+1))
      bad "the gate REFUSES $ev on $ha, but the capture shows it firing there" ;;
    *) BADGATE=$((BADGATE+1))
      bad "the gate wires $ev on $ha, but the capture does not show it firing there (fired='${fired:-absent}')" ;;
  esac
done < <(sort -u "$TD/pairs")
check "the writers' gate wires exactly the events the probe captured firing" "$BADGATE" "0"

# --- no capability may go silent on a harness -----------------------------------------
MISSING=0
for cap in $(sort -u "$TD/caps"); do
  for ha in claude codex; do
    awk -F'\t' -v c="$cap" -v h="$ha" '$1==c && $3==h {n++} END {exit n?0:1}' "$TSV" || {
      MISSING=$((MISSING+1)); bad "capability '$cap' has no row for $ha"; }
  done
done
check "every capability has a row for both harnesses" "$MISSING" "0"

# The bounds this run is building must each be in the matrix: a capability that never
# reaches the tsv never reaches doctor either, and that is the silence the charter bans.
for cap in permission-policy review-lens-roles compact-checkpoint api-error-stop \
           subagent-accounting subagent-cap verify-receipt done-gate file-watch config-guard; do
  check "capability '$cap' has rows in the matrix" \
        "$( [ "$(awk -F'\t' -v c="$cap" '$1==c {n++} END {print n+0}' "$TSV")" -gt 0 ] && echo yes || echo no )" \
        "yes"
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
