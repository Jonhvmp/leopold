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

A run is conducted by ONE session (its `owner` in `state.json`). Stopping it from
the session that owns it, or a run whose owner shows no sign of life, is a plain stop.
Stopping a run that another **live** session (or a live `leopold run`) is conducting
is refused unless the user asked for it: if the invocation carried `--force`, export
`LEOPOLD_FORCE=1` for this block.

Run:

```bash
LEO=.leopold
if [ ! -f "$LEO/state.json" ]; then echo "No Leopold run to stop."; exit 0; fi
LEO_HOME="$(leopold home 2>/dev/null || echo "${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}" || echo "${CODEX_HOME:-$HOME/.codex}")/leopold}")"
verdict="$([ -f "$LEO_HOME/scripts/leopold-owner.sh" ] && bash "$LEO_HOME/scripts/leopold-owner.sh" check "$PWD" || echo "FREE: owner check unavailable")"
case "$verdict" in
  BLOCKED*)
    if [ -z "${LEOPOLD_FORCE:-}" ]; then
      echo "REFUSED: $verdict"
      echo "This session does not conduct that run. Re-run /leopold-stop --force to stop it anyway."
      exit 0
    fi ;;
esac
ME="${CLAUDE_CODE_SESSION_ID:-${CODEX_THREAD_ID:-}}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp)"; jq --arg t "$NOW" '.active=false | .stopped_reason="user_stop"
  | (if (.owner | type) == "object" then .owner.released_at=$t else . end)' "$LEO/state.json" > "$tmp" && mv "$tmp" "$LEO/state.json"
printf '{"ts":"%s","event":"stop","reason":"user_stop","session":"%s","forced":%s}\n' \
  "$NOW" "${ME:0:8}" "$([ -n "${LEOPOLD_FORCE:-}" ] && echo true || echo false)" >> "$LEO/events.jsonl"
rm -f "$LEO/STOP" "$LEO/ALLOW_GIT" "$LEO/ALLOW_PUSH"
echo "Leopold run stopped (git re-locked; STOP and opt-in tokens cleared)."
```

If it printed `REFUSED`, repeat the verdict line to the user and stop there: the
line names the owning session, the engine and when it was last seen.

This sets the run inactive, so the Stop hook will allow the session to halt at
the next turn boundary. The blunt alternative is `touch .leopold/STOP`.

After stopping, give the user a short handoff: what was completed (done items in
`PLAN.md`), what decisions were made (`DECISIONS.md`), and what is staged and
ready for them to review and commit. Remember: Leopold never committed; that is
their call.
