// The System One wire shape, shared by every provider that speaks it.
//
// `jev` is TypeSafe's hosted endpoint; `generic` is any wire-compatible reproduction — a
// self-hosted openjev-sglang, a future open model, an internal service. They differ ONLY in their
// descriptors, which is what makes the seam a seam: a new vendor in this family costs a config
// entry, not a code path.
//
// THREE THINGS IT IS CAREFUL ABOUT:
//   * The DESCRIPTOR IS VALIDATED, including the moving-alias check. Unlike a chat gateway's
//     routing string (see DECISIONS, turn 6), a System One model id lives in Jev's own naming
//     universe, where `-latest` and `-preview` are documented as moving. Every threshold in
//     `.leopold/decisions/` is fitted against one model, so an alias is a silent invalidation.
//   * The KEY NEVER TRAVELS. It is read from the descriptor's `auth_env` at call time, put in one
//     header, and never placed in a message, a detail string, an event or a log line. The stub's
//     request log records the auth SCHEME only, which is how the test proves it.
//   * RETRY IS FOR CONGESTION, NOT FOR REJECTION — and the loop that does it lives in `http.ts`,
//     one home, because forgetting its drain leaks a connection where nothing is watching.

import {
  validateProvider,
  type Catalog,
  type ProviderDescriptor,
  type Question,
  type Result,
} from "../contract.js";
import type { Provider, ProviderRequest } from "../provider.js";
import { postWithRetry } from "./http.js";

export interface SystemOneDeps {
  fetchImpl?: typeof fetch;
  /** Injected so a test proves the backoff SCHEDULE without waiting it out. */
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

interface WireAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  legend?: Record<string, unknown>;
  probabilities?: Record<string, number>;
}

/** The catalog question, as the wire wants it. The shapes already match by design — this is
 *  the seam's whole bet — so the mapping is a projection, not a translation. */
function wireQuestion(q: Question): Record<string, unknown> {
  if (q.type === "noul") {
    return q.criteria === undefined
      ? { type: "noul", instructions: q.instructions }
      : { type: "noul", instructions: q.instructions, criteria: q.criteria };
  }
  return { type: q.type, instructions: q.instructions, criteria: q.criteria };
}

function mapAnswer(qid: string, raw: WireAnswer, provider: string, model: string): Result {
  const bad = (detail: string): Result => ({ ok: false, reason: "malformed", provider, detail });
  if (raw.type === "noul") {
    if (typeof raw.noul !== "number") return bad(`"${qid}": a noul answer with no noul value`);
    // A Noul carries NO confidence and none is invented here: the contract types it `null`,
    // and `certaintyOf()` derives the gating scalar from the probability itself.
    return { ok: true, type: "noul", noul: raw.noul, confidence: null, provider, model };
  }
  if (raw.type === "choice") {
    if (typeof raw.choice !== "string" || !raw.probabilities) return bad(`"${qid}": a choice answer with no choice`);
    return {
      ok: true,
      type: "choice",
      choice: raw.choice,
      probabilities: raw.probabilities,
      confidence: typeof raw.confidence === "number" ? raw.confidence : null,
      provider,
      model,
    };
  }
  if (raw.type === "score") {
    if (typeof raw.score !== "number" || !raw.probabilities) return bad(`"${qid}": a score answer with no score`);
    return {
      ok: true,
      type: "score",
      score: raw.score,
      legend: (raw.legend ?? {}) as Record<string, never>,
      probabilities: raw.probabilities,
      confidence: typeof raw.confidence === "number" ? raw.confidence : null,
      provider,
      model,
    };
  }
  return bad(`"${qid}": unknown answer type ${JSON.stringify(raw.type ?? null)}`);
}

export function createSystemOneProvider(descriptor: ProviderDescriptor, deps: SystemOneDeps = {}): Provider {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = deps.env ?? process.env;

  return {
    descriptor,
    async ask(req: ProviderRequest): Promise<Record<string, Result>> {
      const all = (r: Result): Record<string, Result> => Object.fromEntries(req.questions.map((q) => [q, r]));

      // The pin, refused at call time rather than at construction: a provider never throws,
      // so a misconfiguration arrives as a typed failure the run can read and act on.
      const check = validateProvider(descriptor);
      if (!check.ok) {
        return all({ ok: false, reason: "validation", provider: descriptor.name, detail: check.errors.join("; ") });
      }

      const key = env[descriptor.auth_env];
      if (!key) {
        return all({
          ok: false,
          reason: "auth",
          provider: descriptor.name,
          // Names the variable, never a value — there is no value to name.
          detail: `${descriptor.auth_env} is not set`,
        });
      }

      const body = JSON.stringify({
        state: req.state,
        model: descriptor.model,
        questions: Object.fromEntries(req.questions.map((q) => [q, wireQuestion(req.catalog.questions[q])])),
      });

      const outcome = await postWithRetry({
        url: descriptor.endpoint,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        provider: descriptor.name,
        signal: req.signal,
        fetchImpl: doFetch,
        sleep,
        emit: req.emit,
      });

      if (!outcome.ok) {
        return all({ ok: false, reason: outcome.reason ?? "transport", provider: descriptor.name, detail: outcome.detail });
      }

      const parsed = (outcome.body ?? {}) as { model?: string; answers?: Record<string, WireAnswer> };
      // The model that ANSWERED, not the one requested: an alias, a canary or a silent upgrade
      // all show up here, and the ledger needs the truth to calibrate against.
      const served = parsed.model ?? descriptor.model;
      const answers = parsed.answers ?? {};
      const out: Record<string, Result> = {};
      for (const q of req.questions) {
        const raw = answers[q];
        out[q] = raw
          ? mapAnswer(q, raw, descriptor.name, served)
          : { ok: false, reason: "malformed", provider: descriptor.name, detail: `no answer for "${q}"` };
      }
      return out;
    },
  };
}
