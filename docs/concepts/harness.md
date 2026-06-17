# What Is a Harness

In current usage, an **agent harness** is everything wrapped around the model
except the model itself: tool execution, memory and state, orchestration,
guardrails, and observability.

<p style="text-align:center; font-size:1.25em"><code>Agent = Model + Harness</code></p>

A good harness is what turns a general LLM into a system that can run long,
complex workflows reliably. It is the difference between a model that quits after
one turn and one that finishes the job.

## The six layers

```mermaid
flowchart TB
    API["API Layer<br/><small>entrypoint, streaming</small>"]
    ORC["Orchestration Layer<br/><small>plans, loops, replanning</small>"]
    TOOL["Tooling / MCP Layer<br/><small>tools, skills, schema</small>"]
    MEM["Memory / Context Layer<br/><small>logs, durable artifacts, RAG</small>"]
    EXE["Execution / Sandbox Layer<br/><small>run code, isolation, quotas</small>"]
    OBS["Observability Layer<br/><small>events, traces, audit</small>"]
    API --> ORC --> TOOL --> EXE
    ORC --> MEM
    ORC --> OBS
```

## Where Leopold sits

Claude Code is already a strong harness for a **single interactive turn**. It has
the tooling, execution, and a permission system. What it lacks for **unattended,
long-running work** is exactly what Leopold adds:

```mermaid
flowchart LR
    subgraph CC["Claude Code (one turn)"]
        T[Tooling] --- E[Execution] --- P[Permissions]
    end
    subgraph LEO["Leopold (long-running)"]
        DEC["Decider<br/>(your charter)"]
        CON["Continuity<br/>(stop hook / driver)"]
        GUARD["Guardrails<br/>(git lock)"]
    end
    CC --> LEO
```

- a **decider** (your charter) so the agent has authority to choose instead of asking,
- **continuity** (a stop hook, or the SDK driver) so a finished turn rolls into the next item,
- **guardrails** (a tool-call gate) so autonomy never touches your git.

See the full mapping in the [Architecture Overview](../architecture.md).
