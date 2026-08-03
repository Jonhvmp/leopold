// The single seam through which the whole driver reaches an agent harness.
//
// Production: whichever harness the run is conducted on.
//   - claude — the real Agent SDK `query`, running on the user's OWN Claude Code
//     auth (their subscription): no external API key, no separate billing.
//   - codex  — `codex exec --json` (providers/codex.ts), running on the user's OWN
//     Codex login, same deal.
// Every worker turn, conductor decision, review lens, hypothesis, route and
// tournament judge goes through here, so nothing in the driver talks to a model any
// other way — and nothing in the driver has to know which harness answered.
//
// Tests: `setQuery` swaps in a deterministic fake, so the entire conductor ↔ worker
// ↔ review ↔ retry loop can be exercised end-to-end with ZERO model calls and zero
// spend. `resetQuery` restores the provider-selected one.

import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { codexQuery } from "./providers/codex.js";
import { resolveProvider, type ProviderId } from "./provider.js";

type QueryFn = typeof claudeQuery;

/** Resolved once per process, from `--provider` / LEOPOLD_PROVIDER / what's installed.
 *  A bad value must not throw during module load — that would surface as an import
 *  stack trace instead of a usable error — so this falls back and lets the CLI
 *  re-parse strictly and report the typo itself. */
let provider: ProviderId = (() => {
  try { return resolveProvider(process.argv.slice(2)); } catch { return "claude"; }
})();
let override: QueryFn | undefined;

function providerQuery(): QueryFn {
  // The Codex shim implements the message contract every call site consumes (an
  // async iterable of assistant/result messages) but not the Agent SDK's extra
  // control methods, which the driver never calls. The cast keeps that seam honest
  // in one place instead of at nine call sites.
  return provider === "codex" ? (codexQuery as unknown as QueryFn) : claudeQuery;
}

/** Which harness this process is conducting on. */
export function currentProvider(): ProviderId { return provider; }

/** Point the driver at a harness (the CLI does this once, after parsing argv). */
export function setProvider(id: ProviderId): void { provider = id; }

/** Swap the query implementation (tests only). */
export function setQuery(q: QueryFn): void { override = q; }

/** Restore the provider-backed query. */
export function resetQuery(): void { override = undefined; }

/** Call the active harness. */
export function query(...args: Parameters<QueryFn>): ReturnType<QueryFn> {
  return (override ?? providerQuery())(...args);
}
