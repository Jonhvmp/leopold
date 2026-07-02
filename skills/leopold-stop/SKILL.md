---
name: leopold-stop
version: 0.1.0
description: "Take the seat back. Cleanly ends the autonomous run at the next turn boundary and writes a final summary. Nothing is interrupted mid-turn."
allowed-tools:
  - Read
  - Write
  - Bash
triggers:
  - leopold stop
  - stop leopold
  - take back the seat
---

# /leopold-stop

End the autonomous run cleanly.

Run:

```bash
LEO=.leopold
if [ ! -f "$LEO/state.json" ]; then echo "No Leopold run to stop."; exit 0; fi
tmp="$(mktemp)"; jq '.active=false | .stopped_reason="user_stop"' "$LEO/state.json" > "$tmp" && mv "$tmp" "$LEO/state.json"
printf '{"ts":"%s","event":"stop","reason":"user_stop"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LEO/events.jsonl"
rm -f "$LEO/STOP" "$LEO/ALLOW_GIT" "$LEO/ALLOW_PUSH"
echo "Leopold run stopped (git re-locked; STOP and opt-in tokens cleared)."
```

This sets the run inactive, so the Stop hook will allow the session to halt at
the next turn boundary. The blunt alternative is `touch .leopold/STOP`.

After stopping, give the user a short handoff: what was completed (done items in
`PLAN.md`), what decisions were made (`DECISIONS.md`), and what is staged and
ready for them to review and commit. Remember: Leopold never committed; that is
their call.
