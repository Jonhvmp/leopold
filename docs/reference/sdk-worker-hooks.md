# SDK Worker Hooks — Live Verification

**The question:** the SDK driver spawns each plan item as a fresh worker with
`settingSources: ["user", "project"]` (`packages/driver/src/worker.ts`). That means
hooks are *configured* to load — but does a driver worker actually fire
`SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd`? This claim kept being
assumed and never verified. This page is the captured evidence from a live run.

**The answer: yes — all four fire, per worker, from both settings sources.**

## Versions

| Component | Version |
| --- | --- |
| Claude Code CLI (`claude`) | 2.1.234 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.228 |
| Node.js | v22.22.0 |
| Leopold driver | built from `packages/driver` at 0.18.x (`dist/worker.js`, `settingSources: ["user", "project"]` present) |
| Date | 2026-08-18 |

## Method (hermetic)

- A throwaway project under `mktemp -d` (`/tmp/leopold-hookprobe.*/project`),
  `git init`-ed, with its own empty `.leopold/`.
- A marker hook script that appends its full stdin payload (tagged `user` or
  `project`) to `$MARKER_DIR/<hook_event_name>.log`.
- The hook wired identically for `SessionStart`, `UserPromptSubmit`, `Stop`, and
  `SessionEnd` in **both** a temp `CLAUDE_CONFIG_DIR/settings.json` (user source)
  and the temp project's `.claude/settings.json` (project source).
- One real driver worker, launched through the production code path — a Node
  script calling `runItem` from `dist/worker.js` with a minimal brief rooted in the
  temp project — with a trivial prompt ("reply with one leopold-status block").
- Two runs: (1) fully hermetic with a fresh, unauthenticated `CLAUDE_CONFIG_DIR`;
  (2) an authenticated confirmation run with the marker hooks wired only in the
  temp project's settings, to prove the behavior on a real completed model turn.

## Evidence — run 1 (temp `CLAUDE_CONFIG_DIR`, unauthenticated)

The fresh config dir has no login, so the model turn errored ("Not logged in") —
and the hooks fired anyway, from both sources, proving the harness wires and fires
them upstream of the model call. Marker file contents, verbatim:

```
=== markers/SessionStart.log ===
2026-08-18T08:20:57.857Z  user     {"session_id":"f76e7e02-bf74-4048-9639-42bb8921a875","transcript_path":"/tmp/leopold-hookprobe.Nypw5l/claude-config/projects/-tmp-leopold-hookprobe-Nypw5l-project/f76e7e02-bf74-4048-9639-42bb8921a875.jsonl","cwd":"/tmp/leopold-hookprobe.Nypw5l/project","hook_event_name":"SessionStart","source":"startup"}
2026-08-18T08:20:57.858Z  project  {…same payload…}

=== markers/UserPromptSubmit.log ===
2026-08-18T08:20:57.919Z  user     {"session_id":"f76e7e02-…","prompt_id":"c35b44c0-…","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"Do not use any tools. Reply with exactly one fenced leopold-status block …"}
2026-08-18T08:20:57.920Z  project  {…same payload…}

=== markers/SessionEnd.log ===
2026-08-18T08:20:57.978Z  user     {"session_id":"f76e7e02-…","prompt_id":"c35b44c0-…","hook_event_name":"SessionEnd","reason":"other"}
2026-08-18T08:20:57.978Z  project  {…same payload…}
```

No `Stop.log` in this run — the turn errored before an assistant stop, so `Stop`
did not fire. `SessionEnd` fired regardless.

## Evidence — run 2 (authenticated, real completed turn)

Same probe, marker hooks in the temp project's `.claude/settings.json`. The worker
completed a real turn (`TURN status= done`, `COST 0.8902` USD reported through the
`result` message). All four marker files exist; contents, verbatim:

```
=== markers2/SessionStart.log ===
2026-08-18T08:22:52.636Z  project  {"session_id":"9698a738-b760-44cf-8813-a457c3ea1790","transcript_path":"…/9698a738-….jsonl","cwd":"/tmp/leopold-hookprobe.Nypw5l/project","hook_event_name":"SessionStart","source":"startup"}

=== markers2/UserPromptSubmit.log ===
2026-08-18T08:22:56.572Z  project  {"session_id":"9698a738-…","prompt_id":"3c23f2fb-…","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"Do not use any tools. Reply with exactly one fenced leopold-status block …"}

=== markers2/Stop.log ===
2026-08-18T08:23:08.451Z  project  {"session_id":"9698a738-…","prompt_id":"3c23f2fb-…","permission_mode":"default","effort":{"level":"xhigh"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"```leopold-status\nSTATUS: done\nITEM: hook probe\nSUMMARY: probe complete\n…```","background_tasks":[],"session_crons":[]}

=== markers2/SessionEnd.log ===
2026-08-18T08:23:08.632Z  project  {"session_id":"9698a738-…","prompt_id":"3c23f2fb-…","hook_event_name":"SessionEnd","reason":"other"}
```

## Findings

1. **Hooks fire per SDK worker.** Every `runItem` session fires
   `SessionStart(source: "startup")` → `UserPromptSubmit` → (on a completed turn)
   `Stop` → `SessionEnd(reason: "other")`, in that order.
2. **Both settings sources load**, exactly as `settingSources: ["user", "project"]`
   promises: the same event lands once for the user-level hook and once for the
   project-level hook, milliseconds apart.
3. **Each worker is its own session** — a fresh `session_id` and a fresh transcript
   file per item. A 30-item run therefore produces 30 `SessionStart`/`SessionEnd`
   pairs: any hook keyed by `session_id` alone (ovmem's flush is) will create one
   record per item unless made run-aware.
4. **`SessionEnd` fires even on a failed turn** (run 1): a flush hook cannot assume
   the session produced useful content.
5. **Hook processes inherit the driver's environment** — `$MARKER_DIR` set on the
   `runItem` process reached the hook commands. This is the seam a run-aware flush
   can use.

## The policy this evidence decided

Because hooks do fire per worker, per-item ovmem flushes are **suppressed**: the
driver marks the environment of **every SDK session it spawns** — per-item workers,
review lenses, tournament judges, hypothesis and route sessions — with
`LEOPOLD_SDK_WORKER=1` at its one query seam (`packages/driver/src/sdk.ts`; one
call site would leave the reviewer and judge sessions, which also load
`settingSources: ["user","project"]` hooks, flushing unmarked), and `ovmem.py`
skips its write path (the
`SessionEnd` and `PreCompact` flushes) when the marker is present, logging one line
instead of failing silent. Memory reads (rehydrate, recall) are untouched. The
reversal is one env var on the driver: `LEOPOLD_OVMEM_WORKER_FLUSH=1` restores
per-item flushes. Decision D4 in the run's DECISIONS.md; asserted hermetically by
`scripts/test-ovmem-ext.sh` and `packages/driver/test/worker-env.test.ts`.

## Hermeticity

The probe never touched this repository: `git status --porcelain .leopold` was
empty before and after, and a `sha1sum` over a tar of `.leopold/` was identical
before and after both runs (`3a59fc63914dda7f8bb1cb65c5924293bfb2db2e`). All writes
landed under the `mktemp -d` root.

## Addendum (2026-09-02) — the Stop hook fired *into* the workers

The finding above had a consequence nobody drew at the time: because a worker runs in
the project's cwd with the user's hooks loaded, Leopold's own `stop-continuity.sh` fires
inside every driver worker — and during a driver run `state.json` is active. Reproduced
with a real `runItem` from `dist/worker.js` on Claude Code 2.1.258: the hook blocked the
worker's stop after its status block, the worker announced "I'll read the plan and get
started on the next item", the conductor received a spurious second `onTurn` (kind
`blocked`), and the item took twice as long. `--worktree` runs escaped only because
`.leopold/` is gitignored and the worktree has no `state.json`.

The fix is the owner record: the driver's `initState` writes `owner.engine: "driver"`
with no session id, and the hook allows every stop from a session carrying
`LEOPOLD_SDK_WORKER=1` silently. `scripts/test-hooks.sh` holds the case ("a driver
worker stops silently"), and [Hooks](hooks.md) documents the full decision table.

<!-- @emit hooks_fire=true -->
