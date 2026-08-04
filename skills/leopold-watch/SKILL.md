---
name: leopold-watch
version: 0.1.0
description: "Launch a local live web dashboard to watch the current project's Leopold run — status, cost meters (context/subagents/forks), event feed, decisions, and a Stop button. Local-only (127.0.0.1), zero dependencies."
allowed-tools:
  - Bash
triggers:
  - leopold watch
  - watch the run
  - open the dashboard
---

# /leopold-watch

Start the local live dashboard for this project's Leopold run and give the user the URL.
It only **reads** `.leopold/` (state, plan, decisions, events) and serves on loopback;
nothing leaves the machine. The one action it offers is a Stop button, which touches
`.leopold/STOP` — the same kill switch as `/leopold-stop`.

Run this (idempotent — if it is already up, just report the URL). The first line
resolves the Leopold asset home: `LEOPOLD_HOME` wins, then the Claude Code home,
then the Codex one — same order as the installer:

```bash
LEO="$(leopold home 2>/dev/null || echo "${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}" || echo "${CODEX_HOME:-$HOME/.codex}")/leopold}")"
WATCH="$LEO/scripts/leopold-watch.py"; [ -f "$WATCH" ] || WATCH="scripts/leopold-watch.py"
PORT="${LEOPOLD_WATCH_PORT:-4179}"
if curl -sf "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
  echo "Dashboard already running -> http://127.0.0.1:$PORT"
else
  nohup python3 "$WATCH" --project "$(pwd)" --port "$PORT" >/tmp/leopold-watch.log 2>&1 &
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
    echo "Dashboard started -> http://127.0.0.1:$PORT  (pid $!)"
  else
    echo "Failed to start; last log lines:"; tail -3 /tmp/leopold-watch.log
  fi
fi
```

Then tell the user, briefly:

- Open **http://127.0.0.1:4179** (or the port shown) in a browser to watch the run live:
  run status, cost meters (context MB, subagents, forks, iterations, failures vs their
  budgets), the live event feed, the decisions log, and a **Stop** button.
- It shows real data only while a run is active (`/leopold-run`); otherwise it says
  "no active run" and updates the moment one starts.
- To stop the dashboard itself: `pkill -f leopold-watch.py`. It also runs via `make watch`
  or, from the npm package, `npx leopold-driver watch`.
- The **Canvas** tab renders the run as a live DAG (phases, agents, forks, adversarial
  verify, plan items as nodes; dependency edges). Click a node to inspect it (model,
  tokens, per-node cost, prompt/result preview, decisions). From a node you can **steer**
  the run — redirect / inject / kill / re-run — which the `/leopold-run` loop applies at
  the next turn boundary (a workflow node's steer becomes a directive for the next
  resume). Git stays **locked** throughout: steering never commits.

Do not do anything else. Start it, report the URL, stop.
