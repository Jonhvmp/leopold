# The Canvas

Leopold's plan is not a chat thread — it is a **graph**. The Canvas makes that graph
visible and steerable: a live, zero-dependency DAG of the run, served on loopback by
`leopold-watch`. It is the open, git-locked answer to a linear agent workspace.

Open it with `/leopold-watch` (or `make watch` / `npx leopold-driver watch`), then switch
to the **Canvas** tab at `http://127.0.0.1:4179`.

## What it renders

The Canvas reads the run's own files (`.leopold/`) and every dynamic-workflow record the
runtime writes, and lays them out as a directed graph with a hand-rolled layered layout
(no framework, no bundler, no web fonts — it works fully offline):

- **Plan items** as nodes, with `(after: N)` dependencies as edges.
- **The node kinds you authored.** An item that declares one — `@gate`, `@human`,
  `@tool`, `@verify` — wears it on the node, with its label (`@gate security` reads
  `GATE · SECURITY`). An item that declares none is a plain work node, exactly as before.
- **Conditional edges.** An `@on <condition> -> <item>` route is drawn as a bowed, dashed
  edge in its own colour, carrying the condition **as written** (`migrated=false`), so a
  branch never reads like a dependency. The inspector lists an item's routes, the signals
  it `@emit`s and the ones it `@needs`.
- **A `@human` node waiting on you — when one actually is.** Under the default posture
  (`autonomy: full`) neither engine waits at a `@human` node: it logs a `persona` event
  instead, which the timeline shows with the role the run synthesized to decide it. Under
  [`autonomy: ask`](reference/plan-grammar.md#autonomy) the engine logs `awaiting_human`
  and the node switches to a distinct `awaiting` state — amber, pulsing, labelled *needs
  you*. Nothing is inferred: the node waits only when the run says it does.
- **Dynamic-workflow** phases and agents: phase→phase (`seq`), phase→agent (`contains`),
  and each adversarial-verify agent linked to the exact node it reviews (`verifies`).
  The edge is precise wherever Leopold's own scripts label agents `impl:<id>` /
  `verify:<id>:<lens>`; generic workflows fall back to phase-level inference.
- **Forks**, **reviews**, and **root-cause hypotheses** as nodes hanging off the item
  that spawned them.
- **Tasks** as first-class standalone nodes (see below).

Pan (drag the background), zoom (wheel), drag a node to pin it (positions persist), and
**Fit** to reframe. Click a node to open the **inspector**: model, tokens, a per-node cost
estimate, tool calls, prompt/result previews, and — for a plan item — the matching
`DECISIONS.md` rationale.

## Steering from the Canvas

The inspector turns a node into a control. You can **redirect**, **inject** a note,
**kill**, or **re-run** an item. What happens next depends on how the run is executing:

- A live **`/leopold-run`** loop drains these commands from `.leopold/commands.jsonl` at
  the same turn boundary it checks the kill switch, and applies them: redirect/inject
  prepend guidance to the next item, kill closes it, re-run re-opens it.
- A **dynamic-workflow** node can't be preempted from outside — the runtime owns it — so
  a steer becomes a **directive for the next resume/re-run**, recorded in
  `.leopold/workflow-directives.json` and labelled as such. Leopold does not pretend to
  kill a workflow agent mid-flight.

Either way, **git stays locked.** A steer command can only log a note, prepend guidance,
or flip a `PLAN.md` checkbox — it can never unlock `ALLOW_GIT`/`ALLOW_PUSH` or commit.
That invariant is proven by a red-team test on both the dashboard and the driver.

## What the Canvas is not

Leopold Canvas is deliberately narrow. It is **not** a general knowledge-work assistant:
no deck/spreadsheet/document generation, no connectors marketplace, no enterprise SIEM,
no real-time multi-user collaboration, no task board, no mobile app. It is a graph-native,
open-source, self-hostable view-and-steer surface for an autonomous coding run — and
nothing it shows is a claim the tests don't back.
