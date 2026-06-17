# Conductor & Worker Protocol

This is how the driver's two agents talk. It is a real message exchange, not a
blind "continue": the worker reports, the conductor reads and judges, the
conductor replies.

## The exchange

```mermaid
sequenceDiagram
    autonumber
    participant C as Conductor (your charter)
    participant W as Worker (fresh Claude Code)
    C->>W: work on item "build settings form"
    activate W
    W->>W: implement · run tests
    W-->>C: STATUS: needs-decision<br/>Zustand vs Context?
    deactivate W
    C->>C: classify: reversible + charter-clear
    C->>C: log D1 to DECISIONS.md
    C-->>W: use Context API (charter: no new infra)
    activate W
    W->>W: wire it up · verify
    W-->>C: STATUS: done · 12 tests green
    deactivate W
    C->>C: mark item [x] · next item (fresh worker)
```

## The status contract

The worker closes **every turn** with a fenced status block, then stops and waits
for the conductor:

````text
```leopold-status
STATUS: done | needs-decision | blocked
ITEM: <the item you are on>
SUMMARY: <what you did this turn, 1-3 lines>
DECISION-NEEDED: <if needs-decision: the question + options A/B + tradeoff; else empty>
NEXT: <what you think comes next>
EVIDENCE: <build/lint/test result if relevant>
```
````

The driver parses this deterministically (a fenced block, or a bare `STATUS:`
fallback), then the conductor reasons over the parsed result.

## The conductor's verdict

The conductor returns one of three actions:

```mermaid
flowchart TD
    Status["worker status"] --> Class{classify}
    Class -- "STATUS: done + good evidence" --> Finish["finish · mark item done"]
    Class -- "reversible OR charter-clear" --> Answer["answer · push instruction · log"]
    Class -- "irreversible AND ambiguous" --> Esc["escalate · notify · pause"]
    classDef stop fill:#e63946,stroke:#9d0208,color:#fff;
    class Esc stop;
```

| Action | When | Effect |
| --- | --- | --- |
| `answer` | reversible or the charter covers it | push a concrete instruction back into the same worker session, log the decision |
| `finish` | item complete with evidence | mark the plan item done, start the next item with a fresh worker |
| `escalate` | irreversible and ambiguous, or a charter contradiction | notify the human, pause the run |

Why it works: the conductor is **itself a reasoning model** reading the full
message with your charter as its system prompt, not a regex. The structured
status block makes the *signal* reliable; the charter makes the *judgment* yours.
