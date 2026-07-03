#!/usr/bin/env bash
# Build the Leopold demo as a SCRIPTED WALKTHROUGH (not a live model run) and render it
# to an animated SVG for the README. Honest by design: it narrates the real flow — the
# brief, the brief→workflow compiler, the adversarial verify panel, learn-on-finish —
# and never fakes a Claude Code session.
#
# The cast is SYNTHESIZED deterministically (asciinema v2 is just JSONL), so no recorder
# is needed and reruns are byte-stable. Rendering needs one of:
#   agg:       https://github.com/asciinema/agg   (cargo install agg / brew install agg)
#   svg-term:  npm i -g svg-term-cli   (or it falls back to npx svg-term-cli)
#
# Usage: bash scripts/record-demo.sh   ->   assets/demo.cast + assets/demo.svg
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets"; CAST="$OUT/demo.cast"; SVG="$OUT/demo.svg"
mkdir -p "$OUT"

echo "-> synthesizing $CAST (deterministic; no recorder needed)"
python3 - "$CAST" <<'PY'
import json, sys

W, H = 96, 30
out = [json.dumps({"version": 2, "width": W, "height": H,
                   "title": "Leopold — brief it like a teammate. It conducts Claude Code."})]
t = 0.0

CY, DIM, GRN, YLW, RST = "\x1b[36m", "\x1b[2m", "\x1b[32m", "\x1b[33m", "\x1b[0m"

def line(text, delay):
    global t
    t += delay
    out.append(json.dumps([round(t, 2), "o", text + "\r\n"]))

def c(s, d=1.1): line(f"{CY}$ {s}{RST}", d)          # a command the user types
def n(s, d=0.9): line(f"{DIM}{s}{RST}", d)           # narration
def g(s, d=0.55): line(f"{GRN}{s}{RST}", d)          # good output
def y(s, d=0.7): line(f"{YLW}{s}{RST}", d)           # panel/warning output
def blank(d=0.4): line("", d)

n("# Leopold — brief it like a teammate. It conducts Claude Code.", 0.6)
n("# Scripted walkthrough of the real flow (not a recorded model session).", 1.0)
blank()

c("/leopold-brief")
n("A debate, not a form. Big mission? The plan is drafted by TOURNAMENT —")
n("three stances (MVP-first / risk-first / user-first), judged, synthesized.")
g("  wrote .leopold/{MISSION,CHARTER,GUARDRAILS,PLAN}.md")
blank()

c("leopold workflow")
n("The brief compiles into a dynamic workflow — deterministically, in tested code.")
g("  Compiled the brief into a dynamic workflow: 5 item(s), 2 wave(s).")
g("    wave 1: i1, i2, i3        wave 2: i4, i5")
g("  script  .claude/workflows/leopold-run.js")
g("  args    .leopold/workflow-args.json")
blank()

c("/leopold-workflow")
n("The plan now lives in CODE, not one growing context window. Git is LOCKED.")
g("  — phase: Execute")
g("  impl:i1  done · verify panel: correctness ✓")
n("i3 touches billing -> CRITICAL: three independent skeptics, none wrote the code.")
y("  verify:i3  correctness ✓ · security ✗ 1 blocking · does-it-actually-work ✓")
y("  panel -> blocking finding returned to the worker (round 1/2)")
g("  impl:i3  fixed · verify panel: clean ✓")
g("  — phase: Report   5/5 items done")
blank()

n("A stuck item? A root-cause panel forms hypotheses over DISJOINT evidence")
n("and hands the retry a concrete lead — no doubling down on a wrong theory.")
blank()

c("leopold run --learn-on-finish")
n("The charter learns you: the finished run is mined for recurring judgment calls.")
g("  learn -> 2 charter amendment(s) proposed in .leopold/CHARTER-amendments.md")
n("It NEVER edits the charter — you review, you fold in what sounds like you.")
blank()

g("  make test: green.  Everything staged — NOTHING committed.", 0.8)
g("  Ready for you:  git commit", 0.6)
n("github.com/Jonhvmp/leopold", 2.2)

open(sys.argv[1], "w").write("\n".join(out) + "\n")
print(f"   wrote {sys.argv[1]} ({len(out)-1} events, {t:.0f}s)")
PY

have() { command -v "$1" >/dev/null 2>&1; }
echo "-> rendering $SVG"
if have agg; then
  agg "$CAST" "$OUT/demo.gif" && echo "   (agg makes a GIF: $OUT/demo.gif)"
elif have svg-term; then
  svg-term --in "$CAST" --out "$SVG" --window && echo "   wrote $SVG"
elif have npx; then
  npx -y svg-term-cli --in "$CAST" --out "$SVG" --window && echo "   wrote $SVG (via npx)"
else
  echo "no renderer (agg / svg-term / npx) found — cast written; render it wherever you like."
fi
echo "Done. The README embeds assets/demo.svg at the top."
