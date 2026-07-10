// The single seam through which the whole driver reaches Claude Code.
//
// Production: the real Agent SDK `query`, which runs on the user's OWN Claude Code
// auth (their subscription) — no external API key, no separate billing. Every
// worker turn, conductor decision, review lens, hypothesis, route, and tournament
// judge goes through here, so nothing in the driver talks to a model any other way.
//
// Tests: `setQuery` swaps in a deterministic fake, so the entire conductor ↔ worker
// ↔ review ↔ retry loop can be exercised end-to-end with ZERO model calls and zero
// spend. `resetQuery` restores the real one. Production behavior is unchanged — the
// default impl IS the real SDK query.

import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = typeof realQuery;

let impl: QueryFn = realQuery;

/** Swap the query implementation (tests only). */
export function setQuery(q: QueryFn): void { impl = q; }

/** Restore the real Agent SDK query (the user's Claude Code). */
export function resetQuery(): void { impl = realQuery; }

/** Call Claude Code through the active implementation. */
export function query(...args: Parameters<QueryFn>): ReturnType<QueryFn> {
  return impl(...args);
}
