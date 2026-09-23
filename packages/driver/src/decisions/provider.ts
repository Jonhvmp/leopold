// What a provider is, from the seam's point of view: something that turns a catalog plus a
// state into typed results. Nothing here knows about HTTP, keys, or any vendor — items 4-7
// each add one implementation behind this interface, and `ask()` never learns their names.

import type { Catalog, ProviderDescriptor, Result } from "./contract.js";
import type { DecisionEvent } from "./events.js";

export interface ProviderRequest {
  catalog: Catalog;
  /** The question ids to answer, all against the same state, evaluated together. */
  questions: string[];
  state: unknown;
  /** The provider MUST give up by here. `ask()` also races its own timer, so a provider
   *  that ignores this is bounded anyway — but one that honors it can abort in flight. */
  timeoutMs: number;
  signal: AbortSignal;
  /** Providers emit their own in-flight events here (a retry, say). The seam emits the
   *  asked/answered/failed lines around the call; this is for what happens inside it. */
  emit: (event: DecisionEvent) => void;
}

export interface Provider {
  readonly descriptor: ProviderDescriptor;
  /** Resolve one result per requested question id. A provider NEVER throws: a transport
   *  problem is a `Failure`, not an exception. `ask()` catches anyway — belt and braces. */
  ask(req: ProviderRequest): Promise<Record<string, Result>>;
}
