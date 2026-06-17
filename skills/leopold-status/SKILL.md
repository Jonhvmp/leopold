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
done_n=$(grep -cE '^[[:space:]]*- \[x\]' "$LEO/PLAN.md" 2>/dev/null || echo 0)
open_n=$(grep -cE '^[[:space:]]*- \[ \]' "$LEO/PLAN.md" 2>/dev/null || echo 0)
echo "plan: $done_n done, $open_n open"
echo "next open items:"; grep -E '^[[:space:]]*- \[ \]' "$LEO/PLAN.md" 2>/dev/null | head -3
dec=$(grep -cE '^## D' "$LEO/DECISIONS.md" 2>/dev/null || echo 0)
echo "decisions logged: $dec"
echo "recent events:"; tail -5 "$LEO/events.jsonl" 2>/dev/null
```

Then summarize in one or two plain sentences: is it running, how far through the
plan, and anything notable in the recent decisions or events.
