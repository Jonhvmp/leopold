# Continuity

**Since 0.18.0, a full context window no longer ends a Leopold run.** It used to: the
in-session engine stopped with `context_budget` when the transcript passed
`max_context_mb` (default 5 MB), and recovery was a human act — someone had to notice,
come back, and type `/leopold-run`. Now context pressure is **maintenance, not death**:
the run checkpoints, the window rolls, and the next window continues the plan — under
`continuity: auto` (the default) with no human in the loop.

The governor of an autonomous run is **durable progress** — checked-off plan items. The
run continues while the plan advances and stops honestly when windows stop producing;
never because a window filled, and never because of a cost counter (see
[why USD is not a governor](#why-usd-is-not-a-governor)).

## The window roll

The context window is a consumable; the run is not. The Stop hook
(`hooks/stop-continuity.sh`) measures the transcript against `max_context_mb` every
turn:

1. **At ~80% of the budget**, the turn is blocked with a checkpoint instruction: write
   or merge `.leopold/CHECKPOINT.md` (the contract below), then continue the plan. The
   instruction repeats every turn in the band, and merging is idempotent, so the
   checkpoint stays current while there is still context to write it from.
2. **At 100%**, the window closes. The stop keeps its historical reason —
   `stopped_reason: context_budget`, consumers read it — but the state says *roll*, not
   death: `windows` is incremented, the plan's checkbox vector is snapshotted for the
   [livelock gate](#the-livelock-gate-rolling-is-free-producing-is-mandatory), and
   `checkpoint_written` records whether the checkpoint actually exists. A missing
   checkpoint is named loudly in the stop message — the next window would resume from
   the brief and `PLAN.md` alone — and the message always names the resume path.
3. **The next window reseeds.** `/leopold-run` on a project with a checkpoint and open
   plan items continues the plan without being told anything: brief first, checkpoint
   second. Under `continuity: auto`, `leopold watch` detects the roll and relaunches
   the run headless (`claude -p` / `codex exec`) on the harness that owns it; under
   `continuity: manual`, the stop message's resume pointer is the whole story and a
   human runs `/leopold-run`.

Every continuation is **re-grounded**: the reseed reads the brief files themselves
(never a summary of them), the prompt names the window (`Window N/max`), and the run is
told to treat the workspace, tool results and durable state as authoritative over
earlier narration.

## The checkpoint contract

`.leopold/CHECKPOINT.md` has **one** format with one writer/parser contract —
`packages/driver/src/checkpoint.ts` — which the hook, the `/leopold-run` skill, the
driver and the watcher all speak. The document is the title line `# Leopold Checkpoint`
followed by exactly these seven `##` sections, in this order:

1. **In-Flight Item**
2. **Files and Code**
3. **Errors and Fixes**
4. **Decisions This Run**
5. **Learned Constraints**
6. **Current Work**
7. **Next Step**

Three rules keep it honest:

- **Run state, never brief state.** `MISSION.md`, `CHARTER.md`, `GUARDRAILS.md` and
  `PLAN.md` are durable files the next window re-reads itself. They are structurally
  absent from the section list, and the parser rejects any heading not on it — a
  checkpoint cannot grow a "Mission" section by accident. A checkpoint that restates
  the mission is wrong even when accurate: summarizing the brief into it is how the
  brief drifts.
- **Merge, never nest.** Checkpoint N+1 consolidates checkpoint N into one flat
  document. *In-Flight Item*, *Current Work* and *Next Step* are snapshots — the new
  window's view replaces the prior one wholesale. The other four are ledgers —
  still-true prior lines are kept, new lines appended, stale ones dropped. A document
  containing a prior checkpoint verbatim (its title, or a duplicate section heading)
  is a failed merge, and both the serializer and the parser refuse it.
- **Fail loud, never truncate.** The serialized document is capped at 32768 bytes. An
  oversized checkpoint fails the write with its size in the error and nothing lands on
  disk — truncation could remove the next step while still looking authoritative. A
  checkpoint that cannot be written, merged or parsed is named in the stop message and
  in `leopold doctor`, never papered over.

The checkpoint is also **the handoff between engines**: the SDK driver writes the same
file through the same module at every run end, and either engine picks up the other's
checkpoint — the seat passes between an in-session run and a driver run through one
artifact. When a run finishes cleanly, the checkpoint is archived with the run
(`.leopold/runs/<timestamp>/`) so a dead window's state can never seed the *next* run
as if it were a continuation.

One more boundary: **the checkpoint is data, not instructions.** What a past window
wrote into it has no authority over the next window — the continuation prompt frames
it explicitly as untrusted past-window state to verify against the workspace, not as
orders to follow.

## The livelock gate: rolling is free, producing is mandatory

A reseed is not progress; only closed plan items are. At every roll the hook diffs the
plan's checkbox vector against the snapshot taken when the window started and records
how many items the ending window closed (`window_progress` in `state.json`, one number
per window):

- A window that closed **at least one item** resets the zero streak and the roll
  proceeds.
- **Two consecutive windows closing zero items** stop the run with
  `no_progress_across_windows`, naming both windows and the item it was stuck on. No
  resume pointer is written and nothing relaunches a third window to "give it one more
  shot" — that third window is exactly the livelock the gate exists to stop. A person
  looks at the stuck item; when it is unblocked, `/leopold-run` starts a deliberate new
  attempt.

## Budgets survive the roll

A reseed that refreshed a budget would be a runaway loop with extra steps, so nothing
does:

- **`iteration` / `max_iterations`** is the **run's** ceiling, not the window's. The
  counter carries across windows; window 4 resumes at the iteration window 3 ended on.
- **`max_windows`** (default 10, set in `GUARDRAILS.md`) bounds the total context
  windows one run may consume. Reaching it stops the run with `max_windows`, naming
  the ceiling — no roll, no resume pointer.
- **Spent one-shots stay spent.** The failure rescue and the deadlock repair are
  once-per-run; the state carries them through every reseed.
- **The kill switch beats `continuity: auto`, always — and waits, never burns.** While
  `.leopold/STOP` exists nothing fires and nothing is recorded; remove it and the
  relaunch decision is made again, fresh. The watcher also independently re-checks
  `max_windows` and the livelock gate *before* relaunching, refusing with a
  `window_relaunch_refused` event naming the reason. A relaunch never clears `STOP`,
  never refreshes a budget.
- **A stale roll belongs to a human.** The watcher relaunches only a roll it just saw
  (within 10 minutes — the same staleness line the run skill draws). Opening
  `leopold watch` on a project whose run rolled hours ago refuses with `stale_roll`
  instead of spawning a headless agent as a side effect of opening a dashboard;
  `/leopold-run` resumes it whenever you choose.
- **Fired is not resumed.** After relaunching, the watcher verifies the child actually
  reactivated the run; a child that never does is recorded as `window_relaunch_failed`
  and said in the terminal — the seat is handed back to you, never silently left empty.

The watcher is not a scheduler: it reacts to a detected window roll (a
`window_relaunch` event marks each one), it never wakes a run on a timer.


**Cost on API billing.** The checkpoint cap is proportional to the window —
`min(32KB, 2% of max_context_mb)` — so the one knob that governs per-turn cost governs
the checkpoint too: an API-billed project that lowers `max_context_mb` gets cheaper
turns, earlier rolls, and a proportionally smaller checkpoint, automatically. An
explicit `max_checkpoint_kb:` in `GUARDRAILS.md` overrides the formula outright. The
cap is never derived from billing or from the run's own behavior — a cap the run could
grow by struggling would be a budget that raises itself.

## What still stops a run

Context does not stop a run any more; these do. This is the same complete list as
[What still stops the run](personas.md#what-still-stops-the-run) — the two conditions
new in 0.18.0 are marked:

| Stop | What it means |
| --- | --- |
| `plan_complete` | No unchecked items remain in `PLAN.md`. |
| `kill_switch` | `.leopold/STOP` exists. Beats `continuity: auto`, always. |
| `no_progress_across_windows` — **new** | Two consecutive windows closed zero plan items (the livelock gate). No relaunch. |
| `max_windows` — **new** | The run consumed its window ceiling (default 10). No relaunch. |
| `iteration_budget` | The run-wide iteration counter reached `max_iterations` (default 50) — across all windows. |
| `repeated_failure` | The same failure hit the ceiling after the one persona-led change of approach. |
| `no_progress` | N turns in a row with no change in the plan's signature (within one window). |
| `budget_exceeded` | Real spend crossed `--budget-usd`, **if you opted in** (driver, API billing). |
| `escalation`, `deadlock` / `invalid_graph` | A fork or plan graph nothing could settle. |
| `routed_complete` | A route steered the run to a terminal node; remaining items are named in the report. |
| `awaiting_human` | Only under `autonomy: ask`. |

And the boundary that never moved: **the git lock**. A run that survives ten windows
still stages and reports; the human ships. `context_budget` still appears as a
`stopped_reason` — but it now marks a window roll on a run that continues, not a death.

## One owner per run

A run is conducted by one session, recorded as `owner` in `state.json` when it is
activated. The Stop hook continues and counts that session only; any other session that
stops inside the checkout — a second window opened for an unrelated question, a headless
`claude -p`, the driver's own workers — is allowed to stop and told who owns the run
([Hooks: session ownership](../reference/hooks.md)).

Ownership and the roll fit together. A roll ends the run's active state, so the next
window's `/leopold-run` — the watcher's headless relaunch or yours — claims the seat
without waiting; a session keeps its id across `--resume`, so a window that compacts or
resumes keeps conducting. What a new session cannot do is start beside a live owner:
`/leopold-run` refuses while the owner shows a sign of life within ten minutes (a live
harness pid, a counted turn, a transcript write) and takes over a stale one, recording
`owner_takeover`; `--takeover` forces it and is recorded as forced. `/leopold-stop`
refuses to end another live session's run without `--force`.

## The three memories

Since 0.19.0 a run remembers on three distinct layers. They do not overlap — each
answers a different question, and a feature that blurs two of them is wrong even when
convenient:

| Memory | What it remembers | Lifetime | Works offline |
| --- | --- | --- | --- |
| `.leopold/CHECKPOINT.md` | **This run's working state**: in-flight item, errors and fixes, next step. | Dies with the run — archived on clean finish, never seeds the next run. | Yes — plain file, no network. |
| `.leopold/runs/` + `leopold recall` | **The project's own decision archive**: every finished run's MISSION, PLAN, DECISIONS.md with the Reversal attached. `leopold recall <query>` searches it, ranked and cwd-scoped; every run starts with a bounded digest of the most recent decisions. | Versioned with the repo — greppable, reviewable, survives everything the repo survives. | Yes — lexical search, zero network, zero dependencies. |
| ovmem (OpenViking) | **Distilled cross-run learning**: what the machine's sessions taught, deduped and reconsolidated server-side, shared across projects and harnesses. | Survives everything — lives outside the repo, in the machine's memory store. | No — needs the local OpenViking server (plus its embedding provider). Optional by construction: absent, everything above still works. |

Two rules bind all three:

- **Past-run text is untrusted content.** A checkpoint, a recall excerpt, a run-start
  digest, a rehydrated memory: all data, never instructions. Every surface that
  injects past-run text into a prompt carries the same framing sentence, and a drift
  test fails if any injection site drops it.
- **Memory is enrichment, never a dependency.** A project with no archived runs starts
  byte-identically to one without the feature; a dead ovmem server logs one line and
  the run continues.

When a run is active, ovmem flushes are **run-aware**: the OV session is titled
`leopold · <project> · run <stamp> · window N of M · <engine>` instead of a bare
UUID, so a human browsing memory can tell windows from chats. SDK driver workers are
ephemeral — their hooks do fire (verified live, evidence in
[SDK Worker Hooks](../reference/sdk-worker-hooks.md)), so ovmem suppresses per-item
flushes by default and the conductor's session carries the run.

## Why USD is not a governor

`total_cost_usd` does not reflect real accounting on subscription billing, so a USD
ceiling cannot be the default governor of an autonomous run — it would lie for most
users. The governor is durable progress: checked-off plan items are real on every
billing plan and every harness. API-billed users who want a hard cost cap can still opt
in with the driver's `--budget-usd` — it is their ceiling, never the default. See
[Cost & Security](../cost-and-security.md).

## Configuration

In `.leopold/GUARDRAILS.md`:

```markdown
## Continuity
- continuity: auto           # auto | manual
- max_windows: 10            # total context windows one run may span
```

`max_context_mb` (default 5) stays what it was: the size of one window. `leopold
doctor` reports the continuity posture, the window count against `max_windows`, the
last window's progress, and whether the checkpoint is present, absent, or malformed —
a malformed checkpoint is a named problem, never silence.
