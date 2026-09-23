// `ask()` — the ONE entry point into the decisions seam.
//
// THE CONTRACT WITH ITS CALLERS, in three sentences.
//   1. It never throws. A provider that rejects, hangs, returns nonsense, or does not exist
//      all arrive at the caller as a typed `Failure`. A consumer wrapping this in try/catch
//      is a consumer that misread it.
//   2. The deterministic fallback is a REQUIRED argument. A consumer that cannot say what it
//      does without a model does not get to use a model — that is the "refine, never replace"
//      rule made structural, checked by the compiler rather than by review.
//   3. Every call leaves a trail. One `decision_asked`, then one `decision_answered` or
//      `decision_failed` per question, carrying provider, model, probabilities, confidence,
//      the band that fired and the elapsed ms — the raw material item 16 turns into fitted
//      thresholds.
//
// WHAT IT DELIBERATELY DOES NOT DO: compose. It reports per-question results and the band each
// landed in; turning those into an `ItemClass`, a severity or a permission verdict is the
// consumer's job, in code the human can read. The seam judges nothing.

import {
  validateCatalog,
  type Answer,
  type Catalog,
  type Failure,
  type FailureReason,
  type Result,
  type Thresholds,
} from "./contract.js";
import type { Provider } from "./provider.js";
import { buildProvider } from "./registry.js";
import { loadCatalog, loadConfig, resolveDescriptor, type DecisionsConfig } from "./config.js";
import { noneProvider } from "./providers/none.js";
import type { DecisionEvent } from "./events.js";

export type { DecisionEvent, DecisionEventName } from "./events.js";

/** Which confidence band an answer landed in. `floor` means "do not act", and it is also what
 *  an answer with no expressible confidence gets — an uncalibrated provider that cannot say
 *  how sure it is has, for gating purposes, not said anything. */
export type Band = "act" | "escalate" | "floor";

export interface AskInput<T> {
  catalog: Catalog;
  /** The question ids to ask. All see the same state and are evaluated together. */
  questions: string[];
  state: unknown;
  /** REQUIRED: what the caller uses when the seam cannot answer. Removing this is how
   *  "refine, never replace" would quietly stop being true, so the type keeps it. */
  fallback: T;
  /** An explicit provider outranks every other source. Tests pass a stub here. */
  provider?: Provider;
  /** The project's `.leopold` directory; used to find config.json. */
  leoDir?: string;
  config?: DecisionsConfig;
  env?: NodeJS.ProcessEnv;
  emit?: (event: DecisionEvent) => void;
  now?: () => number;
}

export interface AskResult<T> {
  /** True only when EVERY requested question came back as an answer in the `act` band.
   *  A caller that reads nothing else and branches on this is already correct. */
  usable: boolean;
  answers: Record<string, Result>;
  /** Per question: the band it landed in. A `Failure` lands in `floor`. */
  bands: Record<string, Band>;
  /** Handed straight back, so a caller can do `const v = r.usable ? compose(r) : r.fallback`. */
  fallback: T;
  provider: string;
  source: string;
}

/** How sure an answer is, on one 0-1 scale, whatever its type.
 *
 *  Choice and Score report `confidence` directly. A Noul has none by construction — a
 *  two-outcome distribution is described completely by one number — so its certainty is its
 *  distance from the coin flip. This is NOT a claim that a Noul's certainty and a Choice's
 *  confidence are the same quantity (the charter forbids carrying a threshold between them);
 *  it is only the gating scalar for THIS question, compared only against THIS question's floor. */
export function certaintyOf(a: Answer): number | null {
  // An asserted distribution is not evidence of anything. A provider that picked an option but
  // could not say how sure it was has, for gating purposes, not said how sure it was — and a
  // one-hot noul from such a provider would otherwise read as total certainty.
  if (a.estimated === true) return null;
  if (a.type === "noul") return Math.abs(a.noul - 0.5) * 2;
  return a.confidence;
}

/** The band a certainty lands in. `direction` picks the asymmetric bar when the catalog
 *  declares one: a consumer raising scrutiny passes "raise", one lowering it passes "lower". */
export function bandOf(t: Thresholds, certainty: number | null, direction?: "raise" | "lower"): Band {
  if (certainty === null || !Number.isFinite(certainty)) return "floor";
  if (certainty < t.floor) return "floor";
  const act = direction === "raise" ? (t.act_raise ?? t.act) : direction === "lower" ? (t.act_lower ?? t.act) : t.act;
  return certainty >= act ? "act" : "escalate";
}

function pickProvider<T>(input: AskInput<T>): { provider: Provider; source: string; detail?: string } {
  if (input.provider) return { provider: input.provider, source: "explicit" };
  const config = input.config ?? (input.leoDir ? loadConfig(input.leoDir) : {});
  const r = resolveDescriptor(config, input.env ?? process.env);
  if (!r.descriptor) {
    return {
      provider: noneProvider,
      source: r.source,
      detail: r.unknownName ? `no descriptor for provider "${r.unknownName}"` : undefined,
    };
  }
  const built = buildProvider(r.descriptor, { env: input.env });
  if (!built) {
    return { provider: noneProvider, source: r.source, detail: `this build has no provider named "${r.descriptor.name}"` };
  }
  return { provider: built, source: r.source };
}

const TIMED_OUT = Symbol("timed-out");

export async function ask<T>(input: AskInput<T>): Promise<AskResult<T>> {
  const emit = input.emit ?? (() => {});
  const clock = input.now ?? (() => Date.now());
  const { provider, source, detail } = pickProvider(input);
  const name = provider.descriptor.name;

  /** Every question fails the same way, once, with the same reason — and each one is
   *  emitted exactly once. `elapsedMs` is present only when a call was actually made. */
  const failAll = (reason: FailureReason, why?: string, elapsedMs?: number): AskResult<T> => {
    const answers: Record<string, Result> = {};
    const bands: Record<string, Band> = {};
    for (const q of input.questions) {
      const failure: Failure = { ok: false, reason, provider: name, ...(why ? { detail: why } : {}) };
      answers[q] = failure;
      bands[q] = "floor";
      emit({
        event: "decision_failed",
        provider: name,
        question: q,
        reason,
        source,
        ...(why ? { detail: why } : {}),
        ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
      });
    }
    return { usable: false, answers, bands, fallback: input.fallback, provider: name, source };
  };

  const validation = validateCatalog(input.catalog, provider.descriptor.name === "none" ? undefined : provider.descriptor);
  if (!validation.ok) return failAll("validation", validation.errors.join("; "));

  const missing = input.questions.filter((q) => !(q in input.catalog.questions));
  if (missing.length > 0) return failAll("validation", `catalog has no question(s): ${missing.join(", ")}`);

  // `decision_asked` means a provider was ENGAGED. Asking nobody is not asking: the meter in
  // `leopold watch` reads these as calls, so emitting one here would show traffic on a project
  // that has no extension installed and would make the fallback rate a lie. The run is still
  // told what happened — one `decision_failed` per question, with the reason.
  if (name === "none") {
    return failAll("no_provider", detail);
  }

  emit({ event: "decision_asked", provider: name, model: provider.descriptor.model, questions: input.questions, source });

  const started = clock();
  const timeoutMs = provider.descriptor.timeout_ms > 0 ? provider.descriptor.timeout_ms : 0;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  let raw: Record<string, Result> | typeof TIMED_OUT;
  try {
    const call = provider.ask({
      catalog: input.catalog,
      questions: input.questions,
      state: input.state,
      timeoutMs,
      signal: controller.signal,
      emit,
    });
    if (timeoutMs > 0) {
      const ticking = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(TIMED_OUT);
        }, timeoutMs);
      });
      raw = await Promise.race([call, ticking]);
    } else {
      raw = await call;
    }
  } catch (err) {
    // A provider that throws is a provider that broke its own contract. The caller still
    // gets a typed failure — an exception never reaches it.
    if (timer) clearTimeout(timer);
    return failAll("transport", err instanceof Error ? err.message : String(err));
  }
  if (timer) clearTimeout(timer);
  const elapsed = clock() - started;

  if (raw === TIMED_OUT) {
    return failAll("timeout", `provider "${name}" did not answer within ${timeoutMs}ms`, elapsed);
  }

  const answers: Record<string, Result> = {};
  const bands: Record<string, Band> = {};
  let usable = true;

  for (const q of input.questions) {
    const got = raw[q];
    if (!got) {
      answers[q] = { ok: false, reason: "malformed", provider: name, detail: `provider returned no result for "${q}"` };
      bands[q] = "floor";
      usable = false;
      emit({ event: "decision_failed", provider: name, question: q, reason: "malformed", elapsed_ms: elapsed, source });
      continue;
    }
    if (got.ok === false) {
      answers[q] = got;
      bands[q] = "floor";
      usable = false;
      emit({ event: "decision_failed", provider: name, question: q, reason: got.reason, elapsed_ms: elapsed, source });
      continue;
    }
    const thresholds = input.catalog.thresholds[q];
    const certainty = certaintyOf(got);
    const band = bandOf(thresholds, certainty);
    answers[q] = got;
    bands[q] = band;
    if (band !== "act") usable = false;
    emit({
      event: "decision_answered",
      provider: name,
      model: got.model,
      question: q,
      // A noul has no distribution to report. Setting the key to `undefined` would still CREATE
      // it — `Object.keys({a: undefined})` is `["a"]` — and the shell seam, which omits it
      // properly, would then look like the one that diverged. Spread it or leave it out.
      ...(got.type === "noul" ? {} : { probabilities: got.probabilities }),
      confidence: got.confidence,
      certainty,
      threshold_fired: band,
      elapsed_ms: elapsed,
      source,
    });
  }

  return { usable, answers, bands, fallback: input.fallback, provider: name, source };
}

/** `ask()` for a catalog that lives on disk — the driver's counterpart to what the shell seam
 *  does, so both produce the SAME `no_catalog` failure for the same missing file. Consumers that
 *  ship a catalog with the project (every one of them) use this rather than reading the file
 *  themselves, which keeps one answer to "where does a catalog come from". */
export async function askCatalog<T>(
  input: Omit<AskInput<T>, "catalog"> & { leoDir: string; catalogName: string },
): Promise<AskResult<T>> {
  const raw = loadCatalog(input.leoDir, input.catalogName);
  if (raw === null) {
    const emit = input.emit ?? (() => {});
    const answers: Record<string, Result> = {};
    const bands: Record<string, Band> = {};
    const detail = `no catalog at ${input.leoDir}/decisions/${input.catalogName}.json`;
    for (const q of input.questions) {
      answers[q] = { ok: false, reason: "no_catalog", provider: "none", detail };
      bands[q] = "floor";
      emit({ event: "decision_failed", provider: "none", question: q, reason: "no_catalog", detail, source: "none" });
    }
    return { usable: false, answers, bands, fallback: input.fallback, provider: "none", source: "none" };
  }
  return ask({ ...input, catalog: raw as Catalog });
}
