// `jev`: TypeSafe's System One API.
//
// A DESCRIPTOR and nothing else — every line of wire mapping is `systemone.ts`, shared with
// `generic`. `decisions-generic.test.ts` proves that behaviourally: the two providers, given the
// same stub response, return answers that differ only in the provider name.

import type { ProviderDescriptor } from "../contract.js";
import type { Provider } from "../provider.js";
import { createSystemOneProvider, type SystemOneDeps } from "./systemone.js";

/** The shipping descriptor. A project may override the timeout; the pin is not negotiable. */
export const JEV_DESCRIPTOR: ProviderDescriptor = {
  name: "jev",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  calibrated: true,
  calibration_source: "trained",
  auth_env: "TYPESAFE_API_KEY",
  timeout_ms: 5000,
  max_options: 255,
  max_state_tokens: 32000,
};

export type JevDeps = SystemOneDeps;

export function createJevProvider(descriptor: ProviderDescriptor = JEV_DESCRIPTOR, deps: JevDeps = {}): Provider {
  return createSystemOneProvider(descriptor, deps);
}
