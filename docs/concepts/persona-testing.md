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
  domains the flow declares. Point flows at staging.
- **Irreversible actions are never executed.** Payments, deletions, destructive
  submits: the conductor journals the intent as a finding instead of acting — the
  same philosophy as the [git lock](../guardrails.md). The run observes and stages;
  a human ships side effects.
- **No secrets in journals or reports.** Test credentials come from the environment
  (the secrets vault); recorded and reported text is governed by the credential mask.

## Both harnesses, honestly

The three skills install identically on Claude Code and Codex CLI from the one
installer. What differs is the session's perception tools: a web flow needs browser
control in the session that runs it. When that capability is absent, the run reports
it and stops — a persona run that silently "imagined" the interface would be worse
than no run at all.

On-demand today (`/leopold-persona run <flow>`); scheduled cadence rides a later
release, after both harnesses' schedulers are verified live.
