# Decisions

> Append-only audit trail of decisions the run made on your behalf, newest last.
> Each non-mechanical decision is one block. The Reversal line is your escape
> hatch: it tells you how to undo a call you disagree with.

<!-- Example:
## D1 — Cache layer for the MVP            (turn 3, 2026-06-17T15:00:00Z)
Fork:        in-memory cache vs Redis
Class:       reversible
Charter:     "no new infrastructure for the MVP"
Decision:    in-memory map with a TTL
Why:         charter rule + principle 5 (explicit over clever)
Reversal:    swap the cache module for a Redis client; interface is unchanged
-->
