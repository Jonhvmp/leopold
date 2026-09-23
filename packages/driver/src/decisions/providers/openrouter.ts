// `openrouter`: an LLM behind OpenRouter's chat-completions endpoint, mapped onto the contract.
//
// UNCALIBRATED, and the descriptor says so in the one field that changes behaviour. Its
// probabilities come from token logprobs, which measure how concentrated the model's next-token
// distribution was — not how often it is right. The catalog loader therefore refuses to run it
// against bars fitted for a calibrated provider, and `leopold doctor` prints the warning.

import type { ProviderDescriptor } from "../contract.js";
import type { Provider } from "../provider.js";
import { createChatProvider, type LlmDeps } from "./llm.js";

export const OPENROUTER_DESCRIPTOR: ProviderDescriptor = {
  name: "openrouter",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  // No default model: an operator picks one and pins it. There is no sensible default here the
  // way `jev-1.13.0` is a default, and guessing one would put an unpinned alias in the config.
  model: "",
  calibrated: false,
  auth_env: "OPENROUTER_API_KEY",
  timeout_ms: 20000,
  // A conservative default, not a measurement: an LLM's structured output degrades as the enum
  // grows, and logprob matching needs each option to survive as its own token. Lower it for a
  // small model; raising it past what the model handles is how you get `off_schema`.
  max_options: 64,
  max_state_tokens: 32000,
};

export function createOpenRouterProvider(
  descriptor: ProviderDescriptor = OPENROUTER_DESCRIPTOR,
  deps: LlmDeps = {},
): Provider {
  return createChatProvider(descriptor, deps);
}
