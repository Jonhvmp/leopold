// The shared chat-completions mapping, used by every LLM-backed provider (`openrouter`,
// `vercel`, and any other gateway that speaks the OpenAI shape).
//
// WHAT AN LLM-BACKED PROVIDER IS AND IS NOT. It is a way to reach the contract's typed answers
// through a model that was never trained to produce them: the question's answer space becomes a
// JSON-schema enum, the model picks from it, and token logprobs — WHEN the model reports them —
// become the distribution. It is NOT a calibrated decision model. Its probabilities are a
// concentration measure over tokens, not a statement about being right, which is why every
// descriptor built on this sets `calibrated: false` and why the catalog loader refuses to let it
// borrow a calibrated provider's bars.
//
// ONE QUESTION PER REQUEST, deliberately. The seam promises questions are independent and see no
// part of each other's answers; batching them into one completion would put them all in one
// context where the model's first answer conditions the rest, and would make the logprobs at any
// single token position unattributable. The requests go out together, so the cost is tokens, not
// latency.

import {
  confidenceFrom,
  type Entry,
  type ProviderDescriptor,
  type Question,
  type Result,
} from "../contract.js";
import type { Provider, ProviderRequest } from "../provider.js";
import { postWithRetry } from "./http.js";

export interface LlmDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** The answer space, as an enum the model is constrained to. A Score's levels are their own
 *  indices, which is exactly how the contract numbers them. */
export function enumFor(q: Question): string[] {
  if (q.type === "choice") return Object.keys(q.criteria);
  if (q.type === "score") return q.criteria.map((_, i) => String(i));
  return ["true", "false"];
}

interface ChatChoice {
  message?: { content?: string };
  logprobs?: { content?: Array<{ token?: string; top_logprobs?: Array<{ token?: string; logprob?: number }> }> };
}

/** The distribution over the answer space, from the logprobs at the position the model emitted
 *  the answer. Returns null when the model reported none, or when nothing at that position can
 *  be matched to the enum — in which case the caller marks the answer `estimated`. */
export function distributionFrom(choice: ChatChoice, options: string[]): Record<string, number> | null {
  const tokens = choice.logprobs?.content;
  if (!tokens || tokens.length === 0) return null;
  const wanted = new Set(options);
  const slot = tokens.find((t) => wanted.has((t.token ?? "").trim()));
  const tops = slot?.top_logprobs;
  if (!tops || tops.length === 0) return null;

  const mass: Record<string, number> = {};
  let total = 0;
  for (const entry of tops) {
    const name = (entry.token ?? "").trim();
    if (!wanted.has(name) || typeof entry.logprob !== "number") continue;
    const p = Math.exp(entry.logprob);
    mass[name] = (mass[name] ?? 0) + p;
    total += p;
  }
  if (total <= 0) return null;
  const out: Record<string, number> = {};
  for (const option of options) out[option] = Number(((mass[option] ?? 0) / total).toFixed(6));
  return out;
}

function oneHot(options: string[], answer: string): Record<string, number> {
  return Object.fromEntries(options.map((o) => [o, o === answer ? 1 : 0]));
}

/** Build the typed answer. `estimated` is set whenever the distribution was asserted rather than
 *  measured, which is what stops a one-hot from reading as certainty. */
export function toAnswer(
  q: Question,
  qid: string,
  options: string[],
  answer: string,
  probabilities: Record<string, number> | null,
  provider: string,
  model: string,
): Result {
  if (!options.includes(answer)) {
    return {
      ok: false,
      reason: "off_schema",
      provider,
      detail: `"${qid}": the model answered ${JSON.stringify(answer)}, which is not one of ${options.map((o) => JSON.stringify(o)).join(", ")}`,
    };
  }
  const estimated = probabilities === null;
  const probs = probabilities ?? oneHot(options, answer);
  const confidence = estimated ? null : confidenceFrom(probs);

  if (q.type === "noul") {
    return { ok: true, type: "noul", noul: probs.true ?? 0, confidence: null, provider, model, ...(estimated ? { estimated } : {}) };
  }
  if (q.type === "choice") {
    return { ok: true, type: "choice", choice: answer, probabilities: probs, confidence, provider, model, ...(estimated ? { estimated } : {}) };
  }
  const legend: Record<string, Entry> = Object.fromEntries(q.criteria.map((lv, i) => [String(i), lv]));
  const score = Object.entries(probs).reduce((acc, [level, p]) => acc + Number(level) * p, 0);
  return {
    ok: true,
    type: "score",
    score: Number(score.toFixed(4)),
    legend,
    probabilities: probs,
    confidence,
    provider,
    model,
    ...(estimated ? { estimated } : {}),
  };
}

const SYSTEM = [
  "You are a decision function inside a program, not an assistant.",
  "Read the state and answer the single question with exactly one value from the allowed set.",
  "Return only the JSON object the schema describes. No prose, no explanation, no hedging.",
].join(" ");

export function buildChatBody(descriptor: ProviderDescriptor, q: Question, options: string[], state: unknown): string {
  return JSON.stringify({
    model: descriptor.model,
    temperature: 0,
    logprobs: true,
    top_logprobs: 20,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "decision",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["answer"],
          properties: { answer: { enum: options } },
        },
      },
    },
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          state,
          question: { instructions: q.instructions, criteria: "criteria" in q ? q.criteria : undefined },
          allowed_answers: options,
        }),
      },
    ],
  });
}

/** One provider for every gateway that speaks the OpenAI chat shape. The descriptor is the only
 *  difference between them, which is the point: `openrouter` and `vercel` are configurations. */
export function createChatProvider(descriptor: ProviderDescriptor, deps: LlmDeps = {}): Provider {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = deps.env ?? process.env;

  return {
    descriptor,
    async ask(req: ProviderRequest): Promise<Record<string, Result>> {
      const all = (r: Result): Record<string, Result> => Object.fromEntries(req.questions.map((q) => [q, r]));

      // A descriptor whose model was never filled in is a configuration error, not a request to
      // guess. The shipping descriptors ship `model: ""` precisely so this is loud.
      if (!descriptor.model) {
        return all({
          ok: false,
          reason: "validation",
          provider: descriptor.name,
          detail: `provider "${descriptor.name}" has no model set — pin an exact model in the descriptor`,
        });
      }

      const key = env[descriptor.auth_env];
      if (!key) {
        return all({ ok: false, reason: "auth", provider: descriptor.name, detail: `${descriptor.auth_env} is not set` });
      }

      const results = await Promise.all(
        req.questions.map(async (qid): Promise<[string, Result]> => {
          const question = req.catalog.questions[qid];
          const options = enumFor(question);
          const outcome = await postWithRetry({
            url: descriptor.endpoint,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: buildChatBody(descriptor, question, options, req.state),
            provider: descriptor.name,
            signal: req.signal,
            fetchImpl: doFetch,
            sleep,
            emit: req.emit,
          });
          if (!outcome.ok) {
            return [qid, { ok: false, reason: outcome.reason ?? "transport", provider: descriptor.name, detail: outcome.detail }];
          }

          const body = (outcome.body ?? {}) as {
            model?: string;
            choices?: ChatChoice[];
            error?: { type?: string; message?: string };
          };

          // A GATEWAY-LEVEL ENVELOPE. The gateway itself answered 200 -- it is healthy -- and is
          // reporting that the model behind it is not. There are no choices to parse, and
          // treating that as malformed JSON would hide the one useful fact in the response.
          if (body.error) {
            const kind = body.error.type ?? "provider_error";
            return [
              qid,
              {
                ok: false,
                reason: "transport",
                provider: descriptor.name,
                detail: `"${qid}": upstream ${kind}${body.error.message ? `: ${body.error.message}` : ""}`,
              },
            ];
          }
          // The model that ANSWERED. A gateway resolves an alias to a concrete model, and the
          // ledger needs the name that actually did the work, not the one we asked for.
          const served = body.model ?? descriptor.model;
          const choice = body.choices?.[0];
          const content = choice?.message?.content;
          if (typeof content !== "string") {
            return [qid, { ok: false, reason: "malformed", provider: descriptor.name, detail: `"${qid}": no message content` }];
          }
          let answer: unknown;
          try {
            answer = (JSON.parse(content) as { answer?: unknown }).answer;
          } catch {
            return [qid, { ok: false, reason: "malformed", provider: descriptor.name, detail: `"${qid}": content is not JSON` }];
          }
          if (typeof answer !== "string") {
            return [qid, { ok: false, reason: "malformed", provider: descriptor.name, detail: `"${qid}": no string answer` }];
          }
          return [qid, toAnswer(question, qid, options, answer, distributionFrom(choice ?? {}, options), descriptor.name, served)];
        }),
      );
      return Object.fromEntries(results);
    },
  };
}
