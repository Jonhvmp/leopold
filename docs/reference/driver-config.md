# Driver Config

Configuration for the [SDK driver](../architecture/driver.md). It reads the
`.leopold/` brief from the current project and runs the orchestration loop.

## Usage

```bash
cd packages/driver && npm install && npm run build

# from a project that has a .leopold/ brief, with Claude Code logged in:
node /path/to/leopold/packages/driver/dist/index.js            # run
node /path/to/leopold/packages/driver/dist/index.js --dry-run  # load brief, show plan, do nothing
```

## Auth

Uses your existing Claude Code login for both the worker and the conductor. **No
API key required.** `ANTHROPIC_API_KEY` is only needed in a headless environment
with no Claude Code auth.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `LEOPOLD_CONDUCTOR_MODEL` | your Claude Code default | the conductor's model |
| `LEOPOLD_WORKER_MODEL` | your Claude Code default | the worker's model |
| `LEOPOLD_MAX_TURNS_PER_ITEM` | `40` | worker turn budget per item |
| `LEOPOLD_WEBHOOK` | none | URL for JSON POST notifications (Slack/Discord/etc.) |
| `ANTHROPIC_API_KEY` | none | only for headless environments without Claude Code auth |

## Stop conditions

Come from `.leopold/GUARDRAILS.md`, same as the in-session engine: plan complete,
kill switch (`touch .leopold/STOP`), repeated failures, and the iteration budget.

## Notifications

On completion or escalation, the driver writes to the terminal and `events.jsonl`,
and POSTs JSON to `LEOPOLD_WEBHOOK` if set:

```json
{ "title": "Leopold finished", "body": "Plan complete; everything staged.", "source": "leopold" }
```
