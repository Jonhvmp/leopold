# Personas — nothing halts, and git stays locked

Leopold used to have a dead end in it. A `@human` node parked the run. An escalation
ended it. A route with a typo in it refused to start. Three failures of the same kind
gave up. Every one of those is the harness saying *"a person should decide this"* — and
for the people who adopt an autonomous harness, "wait for a person" means "sit there
until Monday". They did not buy a to-do list.

So Leopold does the thing a person would have done: it works out **who** the decision
needs, becomes them, decides, does the work, and writes down what it decided and how you
undo it.

That is a persona.

!!! warning "The `@human` semantics changed in this release"
    A `@human` node **no longer halts the run** by default. It is decided by a role
    Leopold synthesizes and recorded in `DECISIONS.md`. This is deliberate and it is the
    point of the feature — but if your plan relied on `@human` stopping and waiting for
    you, set [`autonomy: ask`](#autonomy-choosing-the-posture) in `GUARDRAILS.md` and the
    old behaviour comes back on both engines, unchanged.

---

## What a persona is

A persona is a **role synthesized for one decision**, from three inputs Leopold already
has:

- **the item** — what the work actually is,
- **`MISSION.md`** — what the run is for,
- **`CHARTER.md`** — your taste, your priorities, your hard rules.

It carries a name, a specific role title, the expertise the item genuinely needs, what
that role optimizes for, and the charter rules binding it.

```
Persona:     Rui Salgado — Release Engineer
Fork:        @human node, item 7: "Approve the production cutover"
Charter:     "TRUST BEFORE REACH. The git lock is the boundary this product rests on."
Decision:    Approve the cutover behind a flag; the change is staged, not shipped.
Reversal:    Flip cutover_enabled back to false in config/flags.yml.
```

### The plan never names the persona

This is the part worth internalising. **You do not author personas.** There is no
`PERSONAS.md`, no `@persona` marker, no roster to maintain. The plan says *what* needs
doing; Leopold derives *who* should do it. A plan that had to name its own experts would
just be a second to-do list — the same authoring burden, one level of indirection away.

### "An agent" is not a persona

A role with no name and no specialty is a costume: you get the same generic answer with a
hat on, and you pay a model call for the hat. So generic roles (`assistant`, `agent`,
`engineer`, `expert`, …) are **refused**, and the item runs under the ordinary worker
prompt instead. The fit is the whole feature.

### The constraints are not synthesized — they are lifted

The role's *fit* comes from a model call. Its *binding rules* do not: Leopold lifts the
hard lines out of `CHARTER.md` **verbatim** and those are the persona's constraints.
A model that forgot your rules cannot produce a persona without them; a model that
paraphrased one cannot soften it. Same item + same charter → byte-identical binding
rules, every time.

### Synthesis failing is not fatal

An unparseable answer, a generic role, an empty response, a harness error — all of them
mean "no persona", and the item runs under the default worker prompt. A run never dies
because it could not decide who it was.

---

## The four forks a persona takes

| Fork | What used to happen | What happens now |
| --- | --- | --- |
| **`@human` node** | run stops with `awaiting_human` | a synthesized role decides the item and does the work |
| **Escalation** | run ends; the item sits with a question attached | a role settles the fork against the charter, hands the resolution back to the worker, and the item finishes |
| **Broken graph / deadlock** | pre-flight refuses to start | a plan engineer proposes the narrowest repair, inside the bounds `@feedback` amendments already obey |
| **Repeated failure** | third failure of a kind ends the run | one persona-led **change of approach**, then the ceiling holds |

Two of them deserve their exact bounds spelled out, because "bounded" is doing real work
in that table.

### Graph repair is bounded by the rules that already existed

A repair may only do two things: **point a route the plan already declares at an item
that exists**, and **append a plain work item**. At most **3 changes**, never a deletion,
never on an item already marked done, never a touch of `GUARDRAILS.md`. Those are
[`amend.ts`](../reference/plan-grammar.md#feedback-nodes-and-amendments)'s bounds — the
same single writer a `@feedback` node goes through. There is no second, looser path: a
repair that wants a fourth change gets the same refusal, logged with the bound that
refused it.

And it is all-or-nothing. The repaired plan is validated **in memory**; `PLAN.md` is
opened for writing only once it validates. A repair that does not fix the graph leaves
the file byte-identical, the run still refuses to start, and the refusal prints both the
original diagnostics *and* what the repair attempted. It costs nothing on a valid plan —
no persona, no model call, unless the validator already produced a diagnostic.

### The repeated-failure rescue is one attempt, not a budget increase

On the **last allowed** failure, Leopold synthesizes the role that failure needs, hands
it the evidence, and asks for one genuinely different approach. The next attempt runs
under it.

`max_failures` is never written. `max_iterations` is never written. The kill switch is
never touched. The rescue is spent **once per run** (it persists, so a resumed run
inherits that it was spent) and the attempt it buys is charged as an iteration like any
other. If that attempt fails too, the run stops with `repeated_failure` exactly as it
does today. And it is granted only when a role actually decided something — a synthesis
that produced no approach means the run stops and the log says the rescue produced
nothing. A silent extra attempt with no new idea in it is just a fourth try.

---

## The persona decides. It never ships.

This is the seam that makes "nothing halts" safe rather than reckless, and **this
feature does not touch it**.

The git lock is about **actions**, not decisions. A persona may conclude "release the
cutover" and record that conclusion with its Reversal line — and
`hooks/guard-irreversible.sh` still denies the `git commit` and `git push` that would
carry it out. Full autonomy of judgment; the trust boundary exactly where it was.

**A persona may never:**

- `git commit`, `git push`, force-push, `git tag`, publish a package, or open an external PR
- raise `max_iterations`, `max_failures` or the USD budget
- clear the kill switch
- edit `GUARDRAILS.md`

Two of those are machine-enforced: the guard's scope is `git commit` and `git push`
(force-push always). The rest are hard rules the role is told, in the prompt, that it
must keep — and the prompt says so plainly rather than promising a hook that is not
there. If a decision cannot be carried out because git is locked, that is the design
working, not a bug to route around.

---

## Every persona decision leaves a trail

Autonomy without a record is an unaudited machine, so the record is not optional.

Every persona decision appends to
[`DECISIONS.md`](../decision-protocol.md#the-decision-log-format) naming the **persona**, the
**fork** it came from, the **charter basis**, and a **Reversal** line. When no role could
be synthesized the `Persona:` line still appears, saying so — an autonomous call with no
record of who made it is not auditable.

Both engines write through the **same single writer**, which also closes a real gap:
a `/leopold-workflow` run used to write **no decisions at all**, because the logging
lived in the driver loop.

And the run does not wait for you to open the file. Every run ends with **"What I decided
for you"** — the calls made on your behalf, riskiest first, in the completion report, the
terminal and the webhook body. See
[the decision protocol](../decision-protocol.md#what-i-decided-for-you) for how that
ordering works.

---

## Autonomy: choosing the posture

`GUARDRAILS.md`:

```markdown
## Judgment posture
- autonomy: full             # full | ask
```

| Value | Behaviour |
| --- | --- |
| `full` *(default)* | Nothing halts for a judgment call. A `@human` node is decided by a synthesized role; escalations, broken graphs and repeated failures get their persona path. |
| `ask` | A `@human` node stops both engines with `awaiting_human`, names the item and stages everything. Answer it, mark the item `[x]`, re-run to resume. |

Override per run with `LEOPOLD_AUTONOMY=ask` or the driver's `--ask` / `--autonomy ask`.
`ask`, `halt` and `human` all spell the strict posture. Precedence is the usual one:
**CLI flag / env var → `GUARDRAILS.md` → `full`**.

An unrecognised value is *ignored*, not treated as strict — a typo must not silently
change the posture in either direction.

Both engines resolve it identically. `/leopold-run` (the Stop hook), `/leopold-workflow`
(the compiled script) and the SDK driver read the same key, the same three spellings, the
same default. A node that resolves on one engine and halts on the other teaches you a
lie.

---

## What still stops the run

This is the complete list. Nothing here is a judgment call, which is exactly why a
persona cannot touch any of it.

| Stop reason | What it means | Can a persona affect it? |
| --- | --- | --- |
| `plan_complete` | No unchecked items remain in `PLAN.md`. | — it is the goal |
| `routed_complete` | A route steered the run to a terminal node; remaining items are named in the report. | — |
| `kill_switch` | `.leopold/STOP` exists (`/leopold-stop`, or `touch`). | **Never.** It may not clear it. |
| `iteration_budget` | The counter reached `max_iterations` (default 50). | **Never.** It may not raise it. |
| `budget_exceeded` | Accumulated real spend crossed `--budget-usd` (opt-in, driver only). | **Never.** |
| `context_budget` | One context window filled (default 5 MB). Since 0.18.0 this is a **window roll, not a death**: the run checkpoints and the next window continues — see [Continuity](continuity.md). | **Never.** |
| `no_progress_across_windows` | Two consecutive windows closed zero plan items — the livelock gate. Nothing relaunches. | **Never.** |
| `max_windows` | The run consumed its window ceiling (default 10). Nothing relaunches. | **Never.** It may not raise it. |
| `no_progress` | N turns in a row with no change in the plan's signature (default 6). | **Never.** |
| `repeated_failure` | The same kind of failure hit the ceiling **and** the one persona-led change of approach was already spent, or produced nothing. | Buys **one** attempt, once per run. Never raises the ceiling. |
| `escalation` | A fork a synthesized role could not settle either — an unusable answer, or a harness error. | Settles what it can; an unsettleable fork still stops. |
| `deadlock` / `invalid_graph` | The plan's graph is unsound and the bounded repair did not fix it. | Repairs within `amend.ts` bounds; a repair that fails still stops. |
| `awaiting_human` | **Only under `autonomy: ask`.** Unreachable in a default run. | It is the posture that decides, not the persona. |

Budgets and the kill switch are **cost and safety ceilings**, not decisions. "It was
nearly done" is exactly the reasoning a runaway loop produces, so it is not reasoning a
persona is allowed to do.

Every stop writes a final summary to the run output and a `stop` event to
`events.jsonl`, naming which condition fired.

---

## Backward compatibility

A plan with no `@human` node and no escalation runs **byte-for-byte as it did before**.
No persona is synthesized, no extra model call is made, nothing is written that was not
written before. The persona paths cost nothing until the run reaches work that used to
wait for a person.

The one deliberate behaviour change is `@human`, and `autonomy: ask` restores it.

---

## See also

- [Plan Grammar → `@human` and autonomy](../reference/plan-grammar.md#autonomy)
- [Decision Protocol](../decision-protocol.md) — the log format and "What I decided for you"
- [Guardrails](../guardrails.md) — the stop conditions and the git lock
- [Driver Config](../reference/driver-config.md) — the flags and env vars
