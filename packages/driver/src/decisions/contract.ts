// The `decisions/1.0` contract: the ONE home for what a typed, calibrated question is,
// what a provider must return, and what makes a catalog legal.
//
// WHY A CONTRACT AND NOT PROSE. Every consumer of this module (item routing, review
// dedupe, triage, the permission hook) asks a provider a question whose answer changes
// what the run does. A rule about how those answers may be used, written in a prompt or a
// doc, is a wish. So the shape is data, the rules are a validator, and both engines — the
// TypeScript driver and the bash seam — read the SAME catalog files. The JSON Schema this
// file emits is DERIVED from the same constants the validator uses, so the two can never
// drift: `decisions-contract.test.ts` fails if they do.
//
// WHAT IS DELIBERATELY NOT HERE. No HTTP, no provider, no network. This file is pure and
// has no imports: it is the vocabulary, and everything else in `src/decisions/` depends on
// it rather than the other way round.

export const CONTRACT_VERSION = "decisions/1.0";

/** The three question types. This array is the single source: the validator tests against
 *  it and the JSON Schema enumerates it. */
export const QUESTION_TYPES = ["choice", "score", "noul"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** A Score's rubric must have enough levels to be a spectrum and few enough to describe
 *  distinctly. Both bounds are enforced, both are quoted in the error, and the JSON Schema
 *  reads them from here. */
export const SCORE_LEVELS = { min: 2, max: 10 } as const;

/** The ceiling any provider may declare for a Choice. A provider descriptor may declare
 *  LESS (a small local model), never more. */
export const CHOICE_MAX_OPTIONS = 255;

/** Instructions and criteria accept structure, not just a string: an object separates a
 *  question from the data that guides it, which is how two confusable options are told
 *  apart. `null` is legal for an option whose name speaks for itself. */
export type Entry = string | number | boolean | null | Entry[] | { [k: string]: Entry };

export interface ChoiceQuestion {
  type: "choice";
  instructions: Entry;
  /** option name -> description. `null` when the name needs no elaboration. */
  criteria: Record<string, Entry>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: Entry;
  /** Ordered level descriptions, low end first. Position IS the level number. */
  criteria: Entry[];
}
export interface NoulQuestion {
  type: "noul";
  instructions: Entry;
  /** Optional clarification of what a yes and a no mean. */
  criteria?: { true?: Entry; false?: Entry };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** What a consumer is allowed to do at each confidence band.
 *
 *  `floor` is the do-not-act line: below it the deterministic fallback stands, always.
 *  `escalate` is the band where the answer is kept but not acted on unattended.
 *  `act` is the bar to act on the answer.
 *
 *  `act_raise` / `act_lower` exist because some decisions are ASYMMETRIC: raising scrutiny
 *  is recoverable and cheap, lowering it skips a review that was deserved. When present
 *  they override `act` for that direction; the consumer decides which direction it is in.
 *  (Item 1's spike set routing's priors this way: raise 0.65, lower 0.85.) */
export interface Thresholds {
  floor: number;
  escalate: number;
  act: number;
  act_raise?: number;
  act_lower?: number;
}

export interface Catalog {
  version: string;
  questions: Record<string, Question>;
  thresholds: Record<string, Thresholds>;
  /** The provider these thresholds were fitted or declared against.
   *
   *  A threshold is a statement about ONE model's probabilities. Carrying it to another
   *  provider is the silent invalidation the charter forbids, so a catalog that names its
   *  provider may only be used with that provider, and an UNCALIBRATED provider may only ever
   *  be used with a catalog that names it — it has no calibrated bars to borrow.
   *
   *  Absent is legal for a calibrated provider: that is the backward-compatible case, and it
   *  reads as "these bars are this project's own judgement, not a fit". */
  thresholds_for?: string;
}

/** Everything a provider declares about itself. `calibrated` is the load-bearing field:
 *  an uncalibrated provider's probabilities are a concentration measure, not a probability
 *  of being right, so its thresholds are its own and are never portable. */
export interface ProviderDescriptor {
  name: string;
  endpoint: string;
  /** Pinned to an exact version. A moving alias is refused: thresholds are tuned against
   *  a specific model and an alias that moves silently invalidates them. */
  model: string;
  calibrated: boolean;
  /** How the calibration claim is backed. An operator-declared claim is honored for
   *  threshold selection and said out loud by `leopold doctor`. */
  calibration_source?: "trained" | "operator-declared";
  auth_env: string;
  timeout_ms: number;
  max_options: number;
  /** ADVISORY. It is validated as positive and reported by `leopold doctor`, but nothing
   *  truncates a state against it — token counting needs the provider's own tokenizer. Consumers
   *  bound their own state instead (routing caps its charter excerpt at 2000 chars). */
  max_state_tokens: number;
}

// ---- answers ---------------------------------------------------------------------------
// Every answer carries its provenance (`provider`, `model`) because a decision that cannot
// be audited later cannot be calibrated later.

interface AnswerBase {
  ok: true;
  provider: string;
  model: string;
  /** True when the distribution was ASSERTED rather than measured — an uncalibrated provider
   *  that returned a decision but no token probabilities. The answer is still worth keeping
   *  (the ledger wants it), but `certaintyOf()` reports null for it, so it can never clear a
   *  floor and the consumer falls back. Absent means measured, which is what every calibrated
   *  provider returns. */
  estimated?: boolean;
}
export interface ChoiceAnswer extends AnswerBase {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** null when the provider cannot express one (an uncalibrated provider without logprobs). */
  confidence: number | null;
}
export interface ScoreAnswer extends AnswerBase {
  type: "score";
  score: number;
  legend: Record<string, Entry>;
  probabilities: Record<string, number>;
  confidence: number | null;
}
export interface NoulAnswer extends AnswerBase {
  type: "noul";
  /** The probability that the answer is yes. A Noul has no separate confidence: a
   *  two-outcome distribution is described completely by this one number. */
  noul: number;
  confidence: null;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** The REQUIRED explicit failure. There is no empty answer and no silent no-op: a consumer
 *  either gets a typed answer or gets told, in a shape it must handle, why it did not. */
export const FAILURE_REASONS = [
  "no_provider",
  "no_catalog",
  "validation",
  "auth",
  "rate_limit",
  "overloaded",
  "timeout",
  "transport",
  "malformed",
  "off_schema",
  /** The seam that was asked cannot serve this provider — the shell seam speaks the System One
   *  wire shape only, and says so rather than pretending a chat gateway is unreachable. */
  "unsupported",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface Failure {
  ok: false;
  reason: FailureReason;
  provider: string;
  detail?: string;
}
export type Result = Answer | Failure;

export function isFailure(r: Result): r is Failure {
  return r.ok === false;
}

/** How a provider's calibration is stated to a human — in `leopold doctor`, in the extension's
 *  `status` line, and anywhere else it must be read before a threshold is trusted.
 *
 *  ONE HOME, because the caveat is the point: an operator-declared claim is honoured by the code
 *  and must never LOOK like a verified one. Three states, three sentences, no paraphrasing. */
export function calibrationLabel(p: Pick<ProviderDescriptor, "calibrated" | "calibration_source">): string {
  if (!p.calibrated) return "UNCALIBRATED — thresholds not portable";
  return p.calibration_source === "operator-declared"
    ? "calibrated (operator-declared, unverified)"
    : "calibrated";
}

/** Confidence from a distribution: 1.0 when all the mass is on one outcome, falling as it
 *  spreads. This is the definition the contract uses everywhere — a provider that reports its
 *  own confidence is trusted, and one that only reports probabilities gets this. */
export function confidenceFrom(probabilities: Record<string, number>): number | null {
  const values = Object.values(probabilities).filter((v) => Number.isFinite(v));
  const n = values.length;
  if (n === 0) return null;
  if (n === 1) return 1;
  const peak = Math.max(...values);
  return Math.max(0, Math.min(1, (n * peak - 1) / (n - 1)));
}

// ---- validation ------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Validate a catalog against the contract, and against a provider's declared limits when
 *  one is supplied. Every error names the offending question id, so a failure points at the
 *  line to fix rather than at the file. */
export function validateCatalog(input: unknown, provider?: ProviderDescriptor): ValidationResult {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);

  if (!isPlainObject(input)) return { ok: false, errors: ["catalog is not a JSON object"] };

  if (input.version !== CONTRACT_VERSION) {
    push(`version: expected "${CONTRACT_VERSION}", got ${JSON.stringify(input.version ?? null)}`);
  }
  if (!isPlainObject(input.questions)) {
    return { ok: false, errors: [...errors, "questions: missing or not an object"] };
  }
  const thresholds = isPlainObject(input.thresholds) ? input.thresholds : {};
  if (!isPlainObject(input.thresholds)) push("thresholds: missing or not an object");

  const maxOptions = provider ? Math.min(provider.max_options, CHOICE_MAX_OPTIONS) : CHOICE_MAX_OPTIONS;

  for (const [id, raw] of Object.entries(input.questions)) {
    if (!isPlainObject(raw)) {
      push(`question "${id}": not an object`);
      continue;
    }
    const type = raw.type;
    if (typeof type !== "string" || !(QUESTION_TYPES as readonly string[]).includes(type)) {
      push(
        `question "${id}": unknown type ${JSON.stringify(type ?? null)} — legal types are ${QUESTION_TYPES.map((t) => `"${t}"`).join(", ")}`,
      );
      continue;
    }
    if (raw.instructions === undefined) push(`question "${id}": instructions is required`);

    if (type === "choice") {
      if (!isPlainObject(raw.criteria)) {
        push(`question "${id}": a choice needs criteria as an object of option -> description`);
      } else {
        const n = Object.keys(raw.criteria).length;
        if (n < 2) push(`question "${id}": a choice needs at least 2 options, got ${n}`);
        if (n > maxOptions) {
          push(
            `question "${id}": ${n} options exceeds the ${maxOptions} allowed${provider ? ` by provider "${provider.name}"` : ""}`,
          );
        }
      }
    }
    if (type === "score") {
      if (!Array.isArray(raw.criteria)) {
        push(`question "${id}": a score needs criteria as an ordered array of level descriptions`);
      } else {
        const n = raw.criteria.length;
        if (n < SCORE_LEVELS.min || n > SCORE_LEVELS.max) {
          push(
            `question "${id}": a score takes ${SCORE_LEVELS.min}-${SCORE_LEVELS.max} levels, got ${n}`,
          );
        }
      }
    }
    if (type === "noul" && raw.criteria !== undefined && !isPlainObject(raw.criteria)) {
      push(`question "${id}": a noul's optional criteria must be an object with true/false`);
    }

    if (!(id in thresholds)) push(`question "${id}": has no threshold block`);
  }

  if (provider) {
    const fittedFor = typeof input.thresholds_for === "string" ? input.thresholds_for : undefined;
    if (fittedFor && fittedFor !== provider.name) {
      push(
        `thresholds_for: this catalog's bars were fitted against "${fittedFor}" and the active provider is "${provider.name}" — a threshold is a statement about one model's probabilities and does not carry across providers. Give "${provider.name}" its own threshold file.`,
      );
    }
    if (!fittedFor && !provider.calibrated && provider.name !== "none") {
      push(
        `thresholds_for: provider "${provider.name}" is uncalibrated, so it must carry thresholds fitted for itself — set "thresholds_for": "${provider.name}" on a catalog whose bars were chosen for it, and do not reuse a calibrated provider's.`,
      );
    }
  }

  for (const id of Object.keys(thresholds)) {
    if (!(id in input.questions)) {
      push(`thresholds: "${id}" is an orphan — no question with that id exists in this catalog`);
      continue;
    }
    const t = thresholds[id];
    if (!isPlainObject(t)) {
      push(`thresholds "${id}": not an object`);
      continue;
    }
    for (const k of ["floor", "escalate", "act"] as const) {
      if (!inUnit(t[k])) push(`thresholds "${id}": ${k} must be a number in [0,1], got ${JSON.stringify(t[k] ?? null)}`);
    }
    for (const k of ["act_raise", "act_lower"] as const) {
      if (t[k] !== undefined && !inUnit(t[k])) {
        push(`thresholds "${id}": ${k} must be a number in [0,1], got ${JSON.stringify(t[k])}`);
      }
    }
    if (inUnit(t.floor) && inUnit(t.escalate) && inUnit(t.act) && !(t.floor <= t.escalate && t.escalate <= t.act)) {
      push(`thresholds "${id}": expected floor <= escalate <= act, got ${t.floor} / ${t.escalate} / ${t.act}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Refuse a provider whose model is a moving alias. Thresholds are fitted against a
 *  specific model; an alias that moves under them is a silent invalidation. */
export const ALIAS_PATTERN = /-(latest|preview|stable)$/i;

export function validateProvider(p: ProviderDescriptor): ValidationResult {
  const errors: string[] = [];
  if (!p.name) errors.push("provider: name is required");
  if (!p.endpoint) errors.push(`provider "${p.name}": endpoint is required`);
  if (!p.model) errors.push(`provider "${p.name}": model is required`);
  else if (ALIAS_PATTERN.test(p.model)) {
    errors.push(
      `provider "${p.name}": model "${p.model}" is a moving alias — pin an exact version, because thresholds are tuned against one`,
    );
  }
  if (!p.auth_env) errors.push(`provider "${p.name}": auth_env is required (the env var holding the key)`);
  if (!(typeof p.timeout_ms === "number" && p.timeout_ms > 0)) {
    errors.push(`provider "${p.name}": timeout_ms must be a positive number`);
  }
  if (!(typeof p.max_options === "number" && p.max_options >= 2 && p.max_options <= CHOICE_MAX_OPTIONS)) {
    errors.push(`provider "${p.name}": max_options must be between 2 and ${CHOICE_MAX_OPTIONS}`);
  }
  if (!(typeof p.max_state_tokens === "number" && p.max_state_tokens > 0)) {
    errors.push(`provider "${p.name}": max_state_tokens must be a positive number`);
  }
  if (typeof p.calibrated !== "boolean") errors.push(`provider "${p.name}": calibrated must be declared true or false`);
  return { ok: errors.length === 0, errors };
}

// ---- the shipped provider templates, derived ---------------------------------------------------

/** The descriptors the installer offers, as data.
 *
 *  ONE HOME. `extensions/decisions/install.sh` cannot import TypeScript, so it reads
 *  `providers.json` — which is generated FROM this function and pinned to it by a test, exactly
 *  as `catalog.schema.json` is. A second hand-written copy in bash is how `jev-1.13.0` would
 *  quietly become `jev-latest` in one of the two places. */
export function providerTemplates(
  descriptors: readonly ProviderDescriptor[],
): { version: string; providers: Record<string, ProviderDescriptor> } {
  return {
    version: CONTRACT_VERSION,
    providers: Object.fromEntries(descriptors.map((d) => [d.name, d])),
  };
}

// ---- the JSON Schema, derived ------------------------------------------------------------

/** The catalog's JSON Schema, built FROM the constants above so the bash seam validates
 *  against the same rules the driver enforces. Nothing here is typed by hand twice:
 *  `decisions-contract.test.ts` asserts the schema's enums and bounds are these values. */
export function catalogJsonSchema(): Record<string, unknown> {
  const entry = { $comment: "Entry: string | number | boolean | null | array | object" };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://leopold.dev/schema/${CONTRACT_VERSION}/catalog.json`,
    title: `Leopold ${CONTRACT_VERSION} question catalog`,
    type: "object",
    required: ["version", "questions", "thresholds"],
    additionalProperties: false,
    properties: {
      version: { const: CONTRACT_VERSION },
      thresholds_for: { type: "string" },
      questions: {
        type: "object",
        minProperties: 1,
        additionalProperties: {
          type: "object",
          required: ["type", "instructions"],
          properties: {
            type: { enum: [...QUESTION_TYPES] },
            instructions: entry,
            criteria: {},
          },
          allOf: [
            {
              if: { properties: { type: { const: "choice" } }, required: ["type"] },
              then: {
                required: ["criteria"],
                properties: {
                  criteria: { type: "object", minProperties: 2, maxProperties: CHOICE_MAX_OPTIONS },
                },
              },
            },
            {
              if: { properties: { type: { const: "score" } }, required: ["type"] },
              then: {
                required: ["criteria"],
                properties: {
                  criteria: { type: "array", minItems: SCORE_LEVELS.min, maxItems: SCORE_LEVELS.max },
                },
              },
            },
            {
              if: { properties: { type: { const: "noul" } }, required: ["type"] },
              then: {
                properties: {
                  criteria: {
                    type: "object",
                    additionalProperties: false,
                    properties: { true: entry, false: entry },
                  },
                },
              },
            },
          ],
        },
      },
      thresholds: {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["floor", "escalate", "act"],
          additionalProperties: false,
          properties: {
            floor: { type: "number", minimum: 0, maximum: 1 },
            escalate: { type: "number", minimum: 0, maximum: 1 },
            act: { type: "number", minimum: 0, maximum: 1 },
            act_raise: { type: "number", minimum: 0, maximum: 1 },
            act_lower: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };
}
