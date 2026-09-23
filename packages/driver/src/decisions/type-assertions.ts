// COMPILE-TIME assertions about the seam's public shape. This file exists only to be
// typechecked: it exports nothing and runs nothing.
//
// WHY IT IS IN src/ AND NOT test/. `tsconfig.json` includes `src/**/*.ts` only, so
// `make driver-check` — which IS in the gate — never sees test files. A `@ts-expect-error`
// written in test/ would therefore prove nothing: nothing would ever compile it. Put the
// proof where the compiler looks.
//
// `@ts-expect-error` fails the build when the line it guards STOPS being an error. So if
// someone makes `fallback` optional, or lets a stray field through, `make driver-check` goes
// red naming this file. That is the point: the requirement is enforced by the compiler
// rather than by a reviewer noticing.
//
// MUTATION-VERIFIED: make `fallback` optional in AskInput and `make driver-check` fails here.

import { ask, type AskInput } from "./ask.js";
import { CONTRACT_VERSION, type Catalog } from "./contract.js";

const catalog: Catalog = {
  version: CONTRACT_VERSION,
  questions: { q: { type: "noul", instructions: "true?" } },
  thresholds: { q: { floor: 0.5, escalate: 0.65, act: 0.85 } },
};

/** The deterministic fallback is REQUIRED — "refine, never replace", enforced by the compiler. */
// @ts-expect-error - fallback is required: a consumer that cannot state what it does without
// a provider does not get to use one.
const _missingFallback: AskInput<string> = { catalog, questions: ["q"], state: "x" };

/** The same call WITH a fallback is legal. If this line ever errors, the seam got harder to
 *  use than it should be. */
const _withFallback: AskInput<string> = { catalog, questions: ["q"], state: "x", fallback: "regex-verdict" };

/** `ask` returns a promise that resolves — it has no throwing overload to catch. */
const _returns: (i: AskInput<string>) => Promise<{ usable: boolean; fallback: string }> = ask;

void _missingFallback;
void _withFallback;
void _returns;
