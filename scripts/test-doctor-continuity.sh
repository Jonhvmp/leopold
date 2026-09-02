#!/usr/bin/env bash
# Behavior tests for the doctor's project-continuity report: checkpoint present /
# absent / malformed (with the parse error naming the offender), the continuity
# setting, windows vs max_windows, the last window's progress, and the kill
# switch. Hermetic: temp CLAUDE_HOME/CODEX_HOME/LEOPOLD_HOME and a temp project
# via LEOPOLD_PROJECT_DIR — never ~/. Exits non-zero on any failure.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCTOR="$ROOT/scripts/leopold-doctor.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0

has() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then
    echo "  ok: $1"
  else
    echo "  FAIL: $1 (missing '$3')"; fail=1
  fi
}
hasnt() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then
    echo "  FAIL: $1 (unexpectedly found '$3')"; fail=1
  else
    echo "  ok: $1"
  fi
}

# Hermetic install homes: doctor's install checks read these, never ~/.
export CLAUDE_HOME="$T/claude" CODEX_HOME="$T/codex" LEOPOLD_HOME="$T/leo" LEOPOLD_SRC="$T/src"
mkdir -p "$CLAUDE_HOME" "$CODEX_HOME" "$LEOPOLD_HOME"

PROJ="$T/project"
LEO="$PROJ/.leopold"
mkdir -p "$LEO"
export LEOPOLD_PROJECT_DIR="$PROJ"

run_doctor() { bash "$DOCTOR" 2>&1; }

# A valid checkpoint per the one contract (packages/driver/src/checkpoint.ts):
# the title, then exactly the seven sections in order.
valid_checkpoint() {
  cat <<'EOF'
# Leopold Checkpoint

## In-Flight Item
Item 4: wire the watcher relaunch

## Files and Code
- scripts/leopold-watch.py — relaunch loop

## Errors and Fixes
- jq 1.6 lacks a chain → used sub()

## Decisions This Run
- checkpoint lives at .leopold/CHECKPOINT.md

## Learned Constraints
- codex exec needs --skip-git-repo-check in temp dirs

## Current Work
Stub binaries built.

## Next Step
Run the live window roll on Codex.
EOF
}

echo "doctor continuity — no brief, no continuity block"
rm -rf "$LEO"; mkdir -p "$PROJ"
out="$(run_doctor)"
hasnt "silent without a brief" "$out" "project continuity"

echo "doctor continuity — a healthy rolled run"
mkdir -p "$LEO"
printf '# Mission\n' > "$LEO/MISSION.md"
printf '# Guardrails\n- continuity: auto\n- max_windows: 10\n' > "$LEO/GUARDRAILS.md"
printf '{"active":true,"windows":3,"window_progress":[2,1],"window_zero_streak":0}\n' > "$LEO/state.json"
valid_checkpoint > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "the block announces itself"       "$out" "project continuity"
has "checkpoint reads OK"              "$out" "checkpoint OK"
has "continuity auto is named"         "$out" "continuity auto"
has "auto says who relaunches"         "$out" "leopold watch relaunches"
has "windows N/max"                    "$out" "windows 3/10"
has "last window's progress"           "$out" "last window closed 1 plan item"
hasnt "no FAIL on a healthy run"       "$out" "[FAIL] checkpoint"

echo "doctor continuity — checkpoint absent is normal, never silent"
rm -f "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "absence is stated, not skipped"   "$out" "no checkpoint (normal"

echo "doctor continuity — malformed checkpoints name the offender"
# A missing section names the section.
printf '# Leopold Checkpoint\n\n## Next Step\nonly one section\n' > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "malformed is a FAIL"              "$out" "checkpoint MALFORMED"
has "missing section is named"         "$out" 'missing section(s): "In-Flight Item"'
# A duplicated section (a nested prior) names the section.
{ valid_checkpoint; printf '\n## Next Step\nagain\n'; } > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "duplicate section is named"       "$out" '"## Next Step" twice'
has "duplicate reads as a failed merge" "$out" "merge, never nest"
# Brief state as a heading gets the pointed message.
valid_checkpoint | sed 's/^## Current Work$/## Mission Summary/' > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "brief-state heading is named"     "$out" '"## Mission Summary"'
has "brief state is called out"        "$out" "brief state"
# An unknown heading names itself and the contract.
valid_checkpoint | sed 's/^## Current Work$/## Scratch Notes/' > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "unknown section is named"         "$out" 'unknown section "## Scratch Notes"'
has "the contract is restated"         "$out" "In-Flight Item, Files and Code"
# A second title is a nested prior.
{ valid_checkpoint; printf '\n# Leopold Checkpoint\n'; } > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "second title is a nested prior"   "$out" "nested prior checkpoint"
# Out-of-order sections name the misplaced one.
valid_checkpoint | awk '/^## In-Flight Item$/{print "## Next Step"; next} /^## Next Step$/{print "## In-Flight Item"; next} {print}' > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "out of order is named"            "$out" "out of order"
# Oversize fails with the size, never a truncated read.
{ printf '# Leopold Checkpoint\n\n## In-Flight Item\n'; head -c 40000 /dev/zero | tr '\0' 'x'; echo; } > "$LEO/CHECKPOINT.md"
out="$(run_doctor)"
has "oversize names the cap"           "$out" "over the 32768-byte cap"

echo "doctor continuity — continuity manual turns relaunch off, by name"
valid_checkpoint > "$LEO/CHECKPOINT.md"
printf '# Guardrails\n- continuity: manual\n- max_windows: 10\n' > "$LEO/GUARDRAILS.md"
out="$(run_doctor)"
has "manual is named"                  "$out" "continuity manual"
has "relaunch is declared off"         "$out" "relaunch is OFF"
has "the resume command is named"      "$out" "/leopold-run"

echo "doctor continuity — an unrecognized continuity value is loud"
printf '# Guardrails\n- continuity: sometimes\n' > "$LEO/GUARDRAILS.md"
out="$(run_doctor)"
has "bad value is quoted"              "$out" "continuity 'sometimes' is not a setting"

echo "doctor continuity — defaults without a GUARDRAILS line"
printf '# Guardrails\n' > "$LEO/GUARDRAILS.md"
out="$(run_doctor)"
has "continuity defaults to auto"      "$out" "continuity auto"
has "max_windows defaults to 10"       "$out" "windows 3/10"

echo "doctor continuity — the window ceiling is a warning, with the fix"
printf '{"active":true,"windows":10,"max_windows":10,"window_progress":[1]}\n' > "$LEO/state.json"
out="$(run_doctor)"
has "ceiling reached is warned"        "$out" "windows 10/10"
has "ceiling names the consequence"    "$out" "the next roll stops the run"

echo "doctor continuity — a zero-item window warns about the livelock gate"
printf '{"active":true,"windows":2,"window_progress":[0]}\n' > "$LEO/state.json"
out="$(run_doctor)"
has "zero progress is warned"          "$out" "closed ZERO plan items"
has "the gate is named"                "$out" "no_progress_across_windows"

echo "doctor continuity — no rolled windows yet says nothing about progress"
printf '{"active":true}\n' > "$LEO/state.json"
out="$(run_doctor)"
hasnt "no progress line before a roll" "$out" "last window closed"
has "windows still shown"              "$out" "windows 1/10"

echo "doctor continuity — the kill switch beats continuity: auto"
printf '# Guardrails\n- continuity: auto\n' > "$LEO/GUARDRAILS.md"
touch "$LEO/STOP"
out="$(run_doctor)"
has "kill switch is named first"       "$out" "kill switch present"
has "kill switch blocks relaunch"      "$out" "nothing relaunches"
rm -f "$LEO/STOP"

echo "doctor continuity — who conducts the run, and is that session alive"
rm -f "$LEO/events.jsonl"
fresh="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"active":true,"last_turn":"%s","owner":{"session_id":"AAAA-1111-owner","engine":"skill","harness":"claude"}}\n' "$fresh" > "$LEO/state.json"
out="$(run_doctor)"
has "a live owner is named"            "$out" "run owner: session AAAA-111 (skill, claude) — alive"
printf '{"active":true,"last_turn":"2020-01-01T00:00:00Z","owner":{"session_id":"AAAA-1111-owner","engine":"skill","harness":"claude"}}\n' > "$LEO/state.json"
out="$(run_doctor)"
has "a dead owner is a warning"        "$out" "no sign of life"
has "...that names the takeover path"  "$out" "/leopold-run in a new session takes it over"
printf '{"active":true,"last_turn":"%s","session_id":""}\n' "$fresh" > "$LEO/state.json"
out="$(run_doctor)"
has "a run with no owner is loud"      "$out" "NO session owner"
printf '{"active":true,"orchestrator_pid":%s}\n' "$$" > "$LEO/state.json"
out="$(run_doctor)"
has "a live driver run is named"       "$out" "run owner: leopold run (driver, pid $$) — alive"
printf '{"active":true,"last_turn":"%s","owner":{"session_id":"AAAA-1111-owner","engine":"skill"}}\n' "$fresh" > "$LEO/state.json"
printf '{"event":"foreign_stop"}\n{"event":"foreign_stop"}\n{"event":"turn_start"}\n' > "$LEO/events.jsonl"
out="$(run_doctor)"
has "foreign stops are counted"        "$out" "2 stop(s) from other sessions were turned away"
printf '{"active":false}\n' > "$LEO/state.json"
out="$(run_doctor)"
hasnt "an inactive run says nothing about owners" "$out" "run owner"
rm -f "$LEO/events.jsonl"

echo "doctor continuity — a Stop hook wired twice runs twice per stop"
mkdir -p "$CLAUDE_HOME"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s/leopold/hooks/stop-continuity.sh"}]},{"hooks":[{"type":"command","command":"%s/leopold/hooks/stop-continuity.sh"}]}]}}\n' "$CLAUDE_HOME" "$CLAUDE_HOME" > "$CLAUDE_HOME/settings.json"
out="$(PATH="$T/bin:$PATH" run_doctor)"
if printf '%s' "$out" | grep -q 'Claude Code: hooks wired in settings.json'; then
  has "double wiring is a warning"     "$out" "the Stop hook is wired 2 times in settings.json"
else
  echo "  skip: doctor did not evaluate Claude Code wiring in this hermetic home (no claude binary on PATH)"
fi
rm -f "$CLAUDE_HOME/settings.json"

echo
if [ "$fail" = "0" ]; then echo "doctor continuity tests: all passed"; else echo "doctor continuity tests: FAILURES"; exit 1; fi
