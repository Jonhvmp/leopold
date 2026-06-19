#!/usr/bin/env bash
# Record the Leopold demo as a SCRIPTED WALKTHROUGH (not a live model run) and render it
# to an animated SVG for the README. Honest by design: it narrates the real flow using the
# examples/add-json-output brief as the storyline; it does not fake a Claude Code session.
#
# Needs: asciinema, and a renderer (agg OR svg-term-cli). If they are missing this prints
# install hints and exits 0 (so CI/automation never breaks on it).
#
#   asciinema:  https://asciinema.org/docs/installation
#   agg:        https://github.com/asciinema/agg   (cargo install agg / brew install agg)
#   svg-term:   npm i -g svg-term-cli
#
# Usage: bash scripts/record-demo.sh   ->   assets/demo.cast + assets/demo.svg
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets"; CAST="$OUT/demo.cast"; SVG="$OUT/demo.svg"

have() { command -v "$1" >/dev/null 2>&1; }
if ! have asciinema; then echo "asciinema not found — see header for install hints. Skipping."; exit 0; fi
RENDER=""
have agg && RENDER="agg"; { [ -z "$RENDER" ] && have svg-term && RENDER="svg-term"; } || true
[ -n "$RENDER" ] || { echo "no renderer (agg or svg-term) found — see header. Skipping."; exit 0; }

mkdir -p "$OUT"

# The scripted walkthrough: what the viewer sees, with pauses. Kept short (~60s).
play() {
  c() { printf '\033[36m$ %s\033[0m\n' "$1"; sleep 1.1; }     # prompt line
  n() { printf '\033[2m%s\033[0m\n' "$1"; sleep 0.9; }        # narration
  g() { printf '\033[32m%s\033[0m\n' "$1"; sleep 0.7; }       # good/output
  clear
  n "# Leopold — brief it like a teammate, it conducts Claude Code."
  c "/leopold-brief"
  n "A debate, not a form. It writes MISSION / CHARTER / PLAN."
  g "  wrote .leopold/{MISSION,CHARTER,GUARDRAILS,PLAN}.md"
  sleep 0.6
  c "/leopold-run"
  g "  state.json active=true  — git is now LOCKED"
  n "Turn 1: pick the next PLAN item, do it, decide forks from the CHARTER."
  g "  [x] add toJSON() helper"
  n "Fork: pretty-print JSON or one line? Charter: 'smallest change', machine-facing."
  g "  DECISION -> single line (reversible). logged to DECISIONS.md"
  g "  [x] register --json flag    [x] snapshot the default output"
  sleep 0.5
  n "Stop hook: work remains -> re-inject 'continue'. No 'should I continue?'."
  g "  [x] test --json    [x] document the flag"
  n "PLAN complete. It stops and reports."
  g "  make test: green. Staged, NOT committed."
  g "  Ready for you:  git commit -m 'feat(cli): add --json output'"
  sleep 1.2
}

echo "-> recording $CAST"
asciinema rec --overwrite -c "bash -c '$(declare -f play); play'" "$CAST"

echo "-> rendering $SVG with $RENDER"
case "$RENDER" in
  agg)      agg "$CAST" "$OUT/demo.gif" && echo "   (agg makes a GIF: $OUT/demo.gif)";;
  svg-term) svg-term --in "$CAST" --out "$SVG" --window && echo "   wrote $SVG";;
esac
echo "Done. Embed it at the top of README.md."
