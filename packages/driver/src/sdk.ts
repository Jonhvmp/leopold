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
import { resolveProvider, type ProviderId, type AgentRole, type RoleProviders } from "./provider.js";

type QueryFn = typeof claudeQuery;

/** Resolved once per process, from `--provider` / LEOPOLD_PROVIDER / what's installed.
 *  A bad value must not throw during module load — that would surface as an import
 *  stack trace instead of a usable error — so this falls back and lets the CLI
 *  re-parse strictly and report the typo itself. */
let provider: ProviderId = (() => {
  try { return resolveProvider(process.argv.slice(2)); } catch { return "claude"; }
})();
let override: QueryFn | undefined;
/** Hybrid assignment, or undefined for a single-provider run (the common case). */
let roles: RoleProviders | undefined;

function implFor(id: ProviderId): QueryFn {
  // The Codex shim implements the message contract every call site consumes (an
  // async iterable of assistant/result messages) but not the Agent SDK's extra
  // control methods, which the driver never calls. The cast keeps that seam honest
  // in one place instead of at nine call sites.
  return id === "codex" ? (codexQuery as unknown as QueryFn) : claudeQuery;
}

/** Which harness this process conducts on by default. */
export function currentProvider(): ProviderId { return provider; }

/** Point the driver at a harness (the CLI does this once, after parsing argv). */
export function setProvider(id: ProviderId): void { provider = id; }

/** Assign a harness per role (hybrid). Undefined restores single-provider. */
export function setRoleProviders(map: RoleProviders | undefined): void { roles = map; }

/** The current hybrid assignment, or undefined when the run is single-provider. */
export function roleProviders(): RoleProviders | undefined { return roles; }

/** Which harness answers for `role`. Without a hybrid assignment every role is the
 *  process default, which is why a non-hybrid run is unchanged. */
export function providerForRole(role?: AgentRole): ProviderId {
  return (role && roles?.[role]) || provider;
}

/** Swap the query implementation (tests only). */
export function setQuery(q: QueryFn): void { override = q; }

/** Restore the provider-backed query. */
export function resetQuery(): void { override = undefined; }

/** Call the harness that answers for this call.
 *
 *  A call site may tag itself with `options.leopoldRole` ("executor" | "review" |
 *  "conductor"); under a hybrid assignment that decides which harness answers, and
 *  otherwise it is ignored. The tag is stripped from nothing — both backends already
 *  ignore unknown option keys — so tagging a call site is a one-word change.
 *
 *  Every session spawned through this seam also gets LEOPOLD_SDK_WORKER=1 in its
 *  environment. Everything the driver spawns here is an ephemeral helper — a
 *  per-item worker, a review lens, a tournament judge, a hypothesis, a route probe,
 *  a one-shot conductor decision — never a session a human lives in, so hooks that
 *  inherit the environment (ovmem keys its per-item flush suppression on this
 *  marker) can tell a driver-spawned session from a real one. Marking it at ONE
 *  call site (worker.ts, as it used to be) left reviewer/judge/hypothesis/route
 *  sessions — which also load `settingSources: ["user","project"]` hooks —
 *  flushing one untagged OV session each; the seam is where the marker belongs.
 *  Sessions that load no settings (`settingSources: []`) run no hooks, so the
 *  marker is inert there. Injected before the test-override dispatch so a fake
 *  query sees exactly what a real backend would. */
export function query(...args: Parameters<QueryFn>): ReturnType<QueryFn> {
  const req = args[0] as
    | { options?: { leopoldRole?: AgentRole; env?: Record<string, string | undefined> } }
    | undefined;
  if (req) {
    const env = req.options?.env ?? (process.env as Record<string, string | undefined>);
    // A FRESH request object, never a mutation of the caller's: this seam is the one
    // path every model call flows through, and a caller that reuses or inspects its
    // request after query() must not find an env snapshot it never set.
    args[0] = { ...req, options: { ...req.options, env: { ...env, LEOPOLD_SDK_WORKER: "1" } } } as unknown as (typeof args)[0];
  }
  if (override) return override(...args);
  return implFor(providerForRole(req?.options?.leopoldRole))(...args);
}
