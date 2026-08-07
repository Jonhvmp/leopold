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

- [ ] Add a `--json` flag to the CLI — done when: `mycli --json` emits valid JSON
      @scenario no flag → the human-readable table prints, exactly as before
      @scenario `--json` set → stdout is valid JSON with the table's exact fields
      @scenario `--json` with no rows → prints `[]` and exits 0
- [ ] Second item — done when: <observable check>
- [ ] (after: 1) Third item — done when: <observable check>
