# Brief Artifacts

Everything a run needs lives under `.leopold/` in the target project. The first
four are written by `/leopold-brief`; the rest are runtime state.

```mermaid
flowchart TB
    subgraph Brief["written by /leopold-brief"]
        M[MISSION.md] 
        C[CHARTER.md]
        G[GUARDRAILS.md]
        P[PLAN.md]
    end
    subgraph Runtime["written during a run"]
        D[DECISIONS.md]
        ST[state.json]
        EV[events.jsonl]
    end
    Brief --> Runtime
```

## `MISSION.md`

What we are building and why: problem, goal, explicit non-goals, definition of
done, constraints. This is *what*.

## `CHARTER.md`

The decider. Priorities, technology and style preferences, hard `Always` /
`Never` rules, tie-breakers, and worked examples of decisions you would make.
This is *how you would choose* — the part that "becomes you".

## `GUARDRAILS.md`

The autonomy boundary: action classes, the git posture (locked by default), stop
conditions (`max_iterations`, `max_failures`, budgets), and the kill switch.

## `PLAN.md`

An ordered, checkbox backlog. The run takes the next `- [ ]` item each turn and
marks it `- [x]` when done.

```markdown
- [ ] First item
- [ ] Second item
```

## `DECISIONS.md`

Append-only audit trail. Each non-mechanical decision is one block:

```text
## D1 — Cache layer for the MVP        (turn 3, 2026-06-17T15:00:00Z)
Fork:        in-memory vs Redis
Class:       reversible
Charter:     "no new infrastructure for the MVP"
Decision:    in-memory map with a TTL
Why:         charter rule + principle 5 (explicit over clever)
Reversal:    swap the cache module for a Redis client; interface unchanged
```

## Runtime state

| File | Holds |
| --- | --- |
| `state.json` | `active`, `iteration`, `max_iterations`, `consecutive_failures`, `max_failures`, timestamps |
| `events.jsonl` | structured event stream |
| `STOP` | kill switch (presence halts the loop) |
| `ALLOW_GIT` / `ALLOW_PUSH` / `ALLOW_PUBLISH` | per-session opt-in tokens, absent by default |
