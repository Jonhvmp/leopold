// `vercel`: the Vercel AI Gateway, which speaks the OpenAI chat shape.
//
// This file is a DESCRIPTOR and nothing else. Every line of mapping — the enum, the constrained
// response, the logprobs, the off-schema refusal, the error envelope — is `llm.ts`, shared with
// `openrouter`. `decisions-vercel.test.ts` proves that behaviourally rather than by inspection:
// the two providers, given the same catalog and the same stub response, return answers that
// differ only in the provider name.
//
// THE GATEWAY ROUTES. A model string here is a routing expression the gateway resolves, so the
// name that answers is often not the name that was asked for. The shared mapping already logs
// the response's own `model` field for exactly this reason, and the test pins it.

import type { ProviderDescriptor } from "../contract.js";
import type { Provider } from "../provider.js";
import { createChatProvider, type LlmDeps } from "./llm.js";

export const VERCEL_DESCRIPTOR: ProviderDescriptor = {
  name: "vercel",
  endpoint: "https://ai-gateway.vercel.sh/v1/chat/completions",
  // Carried verbatim: whatever routing string the operator configures is what is sent, and what
  // comes back in the response is what gets logged. No default — see `openrouter`.
  model: "",
  calibrated: false,
  auth_env: "AI_GATEWAY_API_KEY",
  timeout_ms: 20000,
  max_options: 64,
  max_state_tokens: 32000,
};

export function createVercelProvider(
  descriptor: ProviderDescriptor = VERCEL_DESCRIPTOR,
  deps: LlmDeps = {},
): Provider {
  return createChatProvider(descriptor, deps);
}
