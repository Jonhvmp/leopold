// `generic`: any System One wire-compatible endpoint the operator points us at.
//
// THIS IS THE ESCAPE HATCH. An open reproduction, a self-hosted model, an internal service — none
// of them should need a code change in Leopold to be usable. A `generic` entry in
// `.leopold/decisions/config.json` supplies the endpoint, the pinned model, the env var holding
// the key, and the limits, and the shared `systemone.ts` mapping does the rest.
//
// CALIBRATION IS THE OPERATOR'S CLAIM, AND IT IS SAID OUT LOUD. `calibrated: true` on a generic
// descriptor is honoured for threshold selection — we have no way to check it and refusing to
// believe the operator would make the hatch useless — but nothing pretends it was verified.
// `calibrationLabel()` renders it as "calibrated (operator-declared, unverified)", and that is
// what `leopold doctor` prints. A claim nobody checked is still a claim somebody has to see.

import type { ProviderDescriptor } from "../contract.js";
import type { Provider } from "../provider.js";
import { createSystemOneProvider, type SystemOneDeps } from "./systemone.js";

/** A TEMPLATE, not a working configuration: endpoint and model are empty on purpose, so a
 *  half-filled entry is refused by name rather than silently pointed at nothing. */
export const GENERIC_DESCRIPTOR: ProviderDescriptor = {
  name: "generic",
  endpoint: "",
  model: "",
  calibrated: false,
  calibration_source: "operator-declared",
  auth_env: "LEOPOLD_DECISIONS_API_KEY",
  timeout_ms: 5000,
  max_options: 255,
  max_state_tokens: 32000,
};

export function createGenericProvider(
  descriptor: ProviderDescriptor = GENERIC_DESCRIPTOR,
  deps: SystemOneDeps = {},
): Provider {
  return createSystemOneProvider(descriptor, deps);
}
