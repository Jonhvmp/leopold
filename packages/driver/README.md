# @leopold/driver

The external conductor. Where the in-session engine (skills + hooks) keeps one
Claude Code session going, the driver is a persistent process that **conducts
fresh Claude Code workers**, one per plan item, and holds your mission and
charter across the whole run. It is the tier that turns Leopold from "a better
loop" into a real harness you brief and walk away from.

## What it does differently

- **Persistent conductor, fresh workers.** The driver (the "you") remembers the
  mission, charter, and every decision for the entire run. Each plan item gets a
  brand-new worker with clean context, so quality does not rot as the run grows.
  This is the best of both worlds: Ralph's fresh-context-per-task plus a
  conductor that Ralph does not have.
- **Real message exchange.** The worker closes each turn with a structured
  status block. The conductor reads it, decides from your charter, and either
  pushes a concrete instruction back into the same worker session or ends the
  item. That is a genuine back-and-forth between two agents, not a blind
  "continue".
- **It decides, then notifies.** Reversible or charter-clear forks are decided
  and logged. Only a genuinely irreversible-and-ambiguous fork stops the run and
  pings you. You get a notification on completion or escalation, not a screen to
  babysit.
- **Git stays locked.** The worker runs under a `canUseTool` guard with the same
  policy as the in-session hook: `git commit` and `git push` (force-push always)
  are blocked unless you drop an explicit opt-in token (`ALLOW_GIT` / `ALLOW_PUSH`).
  That is the whole lock — everything else is the worker's own call.

## Auth: it uses YOUR Claude Code, not a separate API key

Both the worker and the conductor run through the Claude Agent SDK, which uses
your existing Claude Code login (your subscription). There is **no separate API
key and no split billing**. `ANTHROPIC_API_KEY` is only needed in a headless
environment with no Claude Code auth configured.

## The conductor <-> worker protocol

```
worker  -> works on the item, closes the turn with:
           ```leopold-status
           STATUS: done | needs-decision | blocked
           ITEM / SUMMARY / DECISION-NEEDED / NEXT / EVIDENCE
           ```
driver  -> parses the status, the conductor (your charter as system prompt)
           returns a verdict: answer | finish | escalate
           - answer   -> push a concrete instruction into the worker session
           - finish   -> mark the plan item done, start the next item (fresh worker)
           - escalate -> notify you, pause the run
```

## Install and build

```bash
cd packages/driver
npm install
npm run build
```

## Usage

This package is the whole of Leopold from npm — it bundles the harness (skills, hooks,
installer, extensions) so the CLI runs everything **without cloning the repo or `make`**.
The binary is exposed as both `leopold-driver` and `leopold`.

```bash
npm i -g leopold-driver

leopold install              # copy skills + hooks into ~/.claude (also: --with-gstack)
leopold menu                 # toolchain manager (serena / gstack / ovmem)
leopold watch [--port N]     # live dashboard at http://127.0.0.1:4179  (needs Python 3)
leopold serena install       # manage an extension directly (also: gstack, ovmem)
leopold doctor               # run every extension's doctor
leopold update               # reinstall from this package
leopold run [--dry-run]      # conduct the .leopold run (the SDK driver below)
leopold persona list         # personas (contract status) + flows in .leopold/persona/
leopold persona run <flow> [--persona <id>|all] [--parallel N] [--provider claude|codex]
                             # conduct a synthetic-customer persona run end to end
leopold persona report <dir> # re-synthesize REPORT.md from a run's journals alone
```

`watch` reads the current project's `.leopold/` and shows run status, cost meters, the
event feed, decisions, and a Stop button. `run` needs a `.leopold/` brief (from
`/leopold-brief`) and your Claude Code login.

### Environment

| Var | Default | Purpose |
|---|---|---|
| `LEOPOLD_CONDUCTOR_MODEL` | your Claude Code default | the conductor's model |
| `LEOPOLD_WORKER_MODEL` | your Claude Code default | the worker's model |
| `LEOPOLD_MAX_TURNS_PER_ITEM` | `40` | worker turn budget per item |
| `LEOPOLD_WEBHOOK` | none | URL for JSON POST notifications (Slack/Discord/etc.) |
| `LEOPOLD_APP_VERSION` | the flow's "App version pin" | build identity pinned into persona run journals |
| `ANTHROPIC_API_KEY` | none | only for headless environments without Claude Code auth |

Stop conditions (plan complete, kill switch via `.leopold/STOP`, repeated
failures, iteration budget) come from `.leopold/GUARDRAILS.md`, same as the
in-session engine.

## Status and known limits

Alpha. Verified: compiles against `@anthropic-ai/claude-agent-sdk`, the CLI and
dry-run work, and the status parser + `canUseTool` guard have unit tests
(`make driver-test` / `npm test`) covering the same bypass attempts as the bash
guard's red-team suite. Not yet built: a
watchdog for a worker that ends a turn without emitting a status block (today the
worker is strongly instructed to always emit one), parallel multi-worker waves,
and the live dashboard. See the repo roadmap.
