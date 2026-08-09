# Plan

> Ordered, checkbox backlog. Each item should be independently completable and
> verifiable. The run takes the next unchecked item each turn and marks it [x]
> when done. Order by dependency, then by value. Keep items small.
>
> State each item as behavior with an observable done-check — "do X; done when: Y
> is true", where Y is something a caller or user can see (an output, a screen, a
> passing behavior test), not an internal detail. That check is what the review
> gate and the worker verify against; a vague item is a vague verification.
>
> For a behavioral item, spell the check out as `@scenario` lines directly under it,
> one per case (given → when → then, observable). The run treats them as the item's
> definition of done, and a conformance reviewer verifies the diff satisfies EVERY
> one before the item closes — an unmet scenario is handed back as the fix. An item
> with no `@scenario` lines is fine; it just uses its prose done-check, unchanged.
>
> Declare a real dependency with a leading `(after: N)` marker (N = an earlier
> item's 1-based position); independent items run concurrently under --parallel.
>
> The plan is a GRAPH, and everything past this point is optional — a plan that uses
> none of it runs exactly as it always has. An item may declare a node kind
> (`@gate` / `@verify` review the diff without editing it, `@tool` IS a shell command
> the driver runs with no model turn, `@human` is decided by a role the run synthesizes
> for it — set `autonomy: ask` in GUARDRAILS.md to have it stop for a person instead —,
> `@feedback` lets the run propose at most 3 appended follow-ups), emit and require
> routing signals (`@emit key=value`, `@needs key`), and route on what happened
> (`@on fail -> 5`, `@on exit!=0 -> 5`). The repo is the truth of what was BUILT; the
> signal channel is the truth of what was DECIDED — never put work product in it.
> Run `leopold graph` to print and validate the graph before trusting it; it names a
> dangling route, a cycle, an unreachable item or an `@on` routing on a signal no item
> emits, before a single agent runs. Full
> grammar: docs/reference/plan-grammar.md.

- [ ] Add a `--json` flag to the CLI — done when: `mycli --json` emits valid JSON
      @scenario no flag → the human-readable table prints, exactly as before
      @scenario `--json` set → stdout is valid JSON with the table's exact fields
      @scenario `--json` with no rows → prints `[]` and exits 0
- [ ] Second item — done when: <observable check>
- [ ] (after: 1) Third item — done when: <observable check>
- [ ] (after: 3) @tool make test
      @on exit=0  -> 5
      @on exit!=0 -> 6
- [ ] (after: 4) Fourth item, reached only when the suite is green — done when: <observable check>
- [ ] (after: 4) Fix what the suite caught — done when: `make test` is green
