---
name: leopold-status
version: 0.1.0
description: "Show the state of the current Leopold run: active or not, progress through the plan, decisions logged, and the most recent events."
allowed-tools:
  - Read
  - Bash
triggers:
  - leopold status
  - where is leopold
---

# /leopold-status

Report the current run state. Read-only; never mutate anything.

Run:

```bash
LEO=.leopold
if [ ! -f "$LEO/state.json" ]; then echo "No Leopold run in this project."; exit 0; fi
echo "=== Leopold status ==="
jq -r '"active: \(.active)  turn: \(.iteration)/\(.max_iterations)  fails: \(.consecutive_failures)/\(.max_failures)  started: \(.started_at // "?")  stopped_reason: \(.stopped_reason // "-")"' "$LEO/state.json"
LEO_HOME="$(leopold home 2>/dev/null || echo "${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}" || echo "${CODEX_HOME:-$HOME/.codex}")/leopold}")"
if [ -f "$LEO_HOME/scripts/leopold-owner.sh" ]; then
  bash "$LEO_HOME/scripts/leopold-owner.sh" status "$PWD" | jq -r '"owner: " + (if .engine == "driver" then "leopold run (driver, pid \(.pid))" elif .owner_session == "" then "NONE — every session that stops here is continued and counted" else "session \(.owner_short) (\(.engine)\(if .harness != "" then ", " + .harness else "" end))" end) + (if .owner_session != "" or .engine == "driver" then (if .alive then "  alive" else "  NO SIGN OF LIFE" end) + ", last seen \(.age_s // "?")s ago" else "" end) + (if .mine then "  (this session)" else "" end) + "  foreign stops turned away: \(.foreign_stops)"'
else
  echo "owner: unknown (scripts/leopold-owner.sh not installed — run ./install.sh)"
fi
done_n=$(grep -cE '^[[:space:]]*- \[x\]' "$LEO/PLAN.md" 2>/dev/null || echo 0)
open_n=$(grep -cE '^[[:space:]]*- \[ \]' "$LEO/PLAN.md" 2>/dev/null || echo 0)
echo "plan: $done_n done, $open_n open"
echo "next open items:"; grep -E '^[[:space:]]*- \[ \]' "$LEO/PLAN.md" 2>/dev/null | head -3
dec=$(grep -cE '^## D' "$LEO/DECISIONS.md" 2>/dev/null || echo 0)
echo "decisions logged: $dec"
echo "recent events:"; tail -5 "$LEO/events.jsonl" 2>/dev/null
```

Then summarize in one or two plain sentences: is it running, who conducts it (and
whether that session is alive), how far through the plan, and anything notable in the
recent decisions or events. A non-zero count of foreign stops means another window is
open in this checkout: it is not counted, but it shares the working tree — say so.
