// The deterministic floor. It is a real provider so the dispatcher has no special case:
// "nothing is configured" travels the same path as "the network failed", and every consumer
// therefore exercises its fallback in normal operation rather than only in an outage.

import type { Provider, ProviderRequest } from "../provider.js";
import type { ProviderDescriptor, Result } from "../contract.js";

export const NONE_DESCRIPTOR: ProviderDescriptor = {
  name: "none",
  endpoint: "",
  model: "none",
  calibrated: false,
  auth_env: "",
  timeout_ms: 0,
  max_options: 2,
  max_state_tokens: 0,
};

export const noneProvider: Provider = {
  descriptor: NONE_DESCRIPTOR,
  async ask(req: ProviderRequest): Promise<Record<string, Result>> {
    const out: Record<string, Result> = {};
    for (const q of req.questions) out[q] = { ok: false, reason: "no_provider", provider: "none" };
    return out;
  },
};
