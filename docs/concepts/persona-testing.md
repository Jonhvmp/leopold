# Persona testing — synthetic customers that walk your product

Real customers find what builders cannot: bugs on the unhappy path, screens that
confuse, copy that does not explain, flows that quietly lose people. Waiting for real
users to hit those walls is the slowest, most expensive feedback loop there is.

The persona module puts a **synthetic customer** in front of your product: an
evidence-grounded archetype that walks a declared flow with its own goals, patience,
vocabulary and limits — perceiving the real interface, reacting in character,
journaling every step — and ends the run with a structured report of what broke, what
confused, and where it gave up.

!!! note "Different module from [Personas](personas.md)"
    [Personas](personas.md) are the *decision-makers* Leopold synthesizes when a run
    hits a `@human` node. This page is about *customer simulation* — personas that
    test the product. They share a philosophy (bounded, honest, recorded), not code.

## The three pieces

Two portable skills own the persona semantics, vendored verbatim and installed on
both harnesses:

- **`persona-contract-builder`** compiles a `persona-contract/1.0`: an
  evidence-grounded archetype with a claim catalog, source ledger, epistemic
  boundaries (what this persona knows, half-knows, must not know), behavior and
  communication models, and an explicit validation gate. No stereotypes, no invented
  citations — an unsupported dimension is recorded as unknown, not filled in.
- **`persona-contract-runtime`** enacts a contract one bounded turn at a time:
  `contract + prior state + visible stimulus + task → reaction + observable action +
  state delta`. Its sincerity protocol is the product: confusion stays confusion,
  distrust stays distrust, and abandonment is respected — never softened into praise.

The third piece is Leopold's: **`/leopold-persona`** (Claude Code) /
**`$leopold-persona`** (Codex CLI) conducts the run — workspace, loop, journal,
continuity, evidence, report.

## The structure (nothing loose)

```
.leopold/persona/
  personas/<id>/contract.yaml     # the cast, built from evidence
  flows/<flow>.md                 # entry point, goal, success, allowlist, bounds
  runs/<UTCstamp>-<flow>/         # one deliverable tree per run
    <persona-id>/
      JOURNEY.jsonl               # one enacted turn per line, with state deltas
      evidence/                   # screenshots and recordings
      FINDINGS.md                 # typed: bug | ux | a11y | copy | perf + severity
    REPORT.md                     # cross-persona synthesis, app version pinned
```

## How a run works

1. **Preflight, loud:** the flow file must declare entry point, goal, success
   criteria and a domain allowlist; every contract passes the runtime's audit gate;
   the session must actually be able to perceive the surface (browser tools for web,
   a shell for CLI). No browser → the run says so and stops. **A persona that never
   saw the screen has nothing true to say.**
2. **The loop:** capture what the persona can see → enact one instrumented turn →
   append the full result to `JOURNEY.jsonl` → execute the persona's intended action
   → repeat, chaining each turn's `state_delta` into the next turn's prior state.
3. **The journal is the memory.** If the session hits its context window, Leopold's
   [continuity machinery](continuity.md) rolls it — and the next window resumes from
   the journal tail, re-perceives the screen, and continues from the same turn. A
   long flow never loses a step, and everything re-read from the journal is framed
   as past-run data, never as instructions.
4. **The report:** findings distilled from the journal alone (no journey turn, no
   finding), ranked by severity and by how many personas hit the same wall — *"3 of
   4 personas stalled at the same checkout step"* outranks any solo observation.
   Abandonment is data: where a persona gave up is often the most valuable line in
   the report.

## Bounds that never move

- **The allowlist is a hard boundary** — the persona never navigates outside the
  domains the flow declares. Point flows at staging. The `/leopold-persona` run
  lifecycle arms this bound at preflight and disarms it at run end, so while a run
  is active it is also enforced *upstream of the tool call*: a `PreToolUse` hook
  denies off-allowlist MCP navigation in every session that starts under the
  active run, on both harnesses, verified live — the conductor's own in-loop check
  stands regardless. [Persona Guard Hooks](../reference/persona-guard-hooks.md).
- **Irreversible actions are never executed.** Payments, deletions, destructive
  submits: the conductor journals the intent as a finding instead of acting — the
  same philosophy as the [git lock](../guardrails.md). The run observes and stages;
  a human ships side effects.
- **No secrets in journals or reports.** Test credentials come from the environment
  (the secrets vault); recorded and reported text is governed by the credential mask.

## The second engine: the driver

`/leopold-persona` is a skill telling a session what to do. `leopold persona run`
is a harness doing it: the [SDK driver](../architecture/driver.md) conducts the
same `.leopold/persona/` artifacts headless, with run-engine depth. It is the same
[two-phase pattern](two-phases.md) as `/leopold-run` vs `leopold run` — one
artifact layout, two engines over it, and a test asserts the parity: a run started
in a session and a headless run write the same journal header and the same run
tree, so a report reader never knows which engine walked the flow.

What the driver adds is that everything the skill *asks* for, the driver *does*:

- **The conduction loop, driver-owned.** One supervised worker session per
  persona. The worker perceives the screen, enacts the turn through the vendored
  runtime skill, and returns the `persona-runtime-result/1.0` turn in a fenced
  block — but **the driver writes the journal**, not the worker. Every turn is
  validated before it is appended; a malformed turn is rejected loudly and
  re-asked with the named reason. There is no silent repair: a journal line is
  either valid or it does not exist.
- **Supervision, not hope.** A session that ends without a valid turn or a
  declared outcome is either window continuity or a stall — the conductor decides,
  journals the stall with a named reason, and caps relaunches, so a wedged persona
  ends as an honest `stall` line instead of an infinite loop.
- **Continuity with proof.** The journal is the only state: the driver chains each
  turn's `state_delta` into the next turn's prior state and can rebuild a re-seed
  block from the journal tail at any moment. The regression test kills the window
  after turn N and relaunches — the next journal line is turn N+1, no step lost,
  no step repeated.
- **Bounds enforced in code.** The conductor checks every journaled action against
  the flow's domain allowlist and the irreversibility rule *before* the action
  executes. A violation appends a named stop line and ends that persona's run —
  the prompt restates the bounds, the code enforces them. The
  [persona guard hooks](../reference/persona-guard-hooks.md) add the same bound
  upstream of the tool call, with the live evidence per harness on that page.
- **Fan-out.** `--persona all --parallel N` runs the cast concurrently, each
  persona in its own run subdirectory — no worktrees needed, personas write
  artifacts, not code.
- **A deterministic report.** `REPORT.md` is synthesized from the journals alone,
  byte-stable: findings ranked by severity × how many personas hit the same wall,
  app version pinned, evidence linked, per-persona journey summaries.
  `leopold persona report <run-dir>` re-synthesizes the same bytes from the same
  journals, any time.

## Which engine when

| | `/leopold-persona` (in-session) | `leopold persona run` (driver) |
| --- | --- | --- |
| Where it runs | inside your Claude Code / Codex session | headless, from any terminal |
| Best for | building the cast and flows, watching one persona live, iterating on a contract | full-cast runs, long flows, CI-adjacent proof runs |
| Journal contract | the skill follows it | the driver validates and writes it |
| Stalls and windows | the session's own continuity | supervised: stall detection, capped relaunches, proven journal resume |
| Bounds | armed via the guard hooks, restated in prose | enforced in code on every journaled action, plus the guard hooks |
| Fan-out | one persona at a time | `--persona all --parallel N` |
| Output | the same `.leopold/persona/runs/` tree | the same tree, plus the deterministic cross-persona `REPORT.md` |

Rule of thumb: build and debug in the session; measure with the driver.

## Both harnesses, honestly

The three skills install identically on Claude Code and Codex CLI from the one
installer. What differs is the session's perception tools: a web flow needs browser
control in the session that runs it. When that capability is absent, the run reports
it and stops — a persona run that silently "imagined" the interface would be worse
than no run at all.

`leopold doctor` reports the persona module per harness — skills present,
contracts found, guard hook wired, browser capability honestly stated — so an
absent capability is a named line, never a zero that reads as success. Driver
flags and environment live in
[Driver Config](../reference/driver-config.md#persona-runs-leopold-persona).

On-demand today — in-session (`/leopold-persona run <flow>`) or headless
(`leopold persona run <flow>`, which writes the same run tree and re-synthesizes
any run's report with `leopold persona report <run-dir>`); scheduled cadence
rides a later release, after both harnesses' schedulers are verified live.

---

*Inspired by the persona work of [Daniel Mendes](https://github.com/DanielMendesSensei).*
