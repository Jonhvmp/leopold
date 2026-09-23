// The seam's promise, held: `ask()` never throws, always hands back the caller's
// deterministic fallback, and leaves a trail that says which provider answered and on what
// band it landed.
//
// Every provider here is a stub: no network, no key, no config file on disk. The four
// scenarios item 3 declares are the first four tests; the rest pin the provenance and the
// resolution order.
//
// The FIFTH scenario — "a consumer calls ask() without a fallback is a type error" — cannot
// live here: tsconfig includes src/**/*.ts only, so test files are never compiled by
// `make driver-check`. That proof is in src/decisions/type-assertions.ts, where the gate
// actually looks.
//
// MUTATION-VERIFIED: make the catch in ask() rethrow and the throwing-provider case fails;
// drop the band check and the below-floor case fails; return `usable: true` unconditionally
// and three cases fail.
//
// HERMETIC: stub providers and in-memory config only. No network, no home, no writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ask,
  bandOf,
  certaintyOf,
  CONTRACT_VERSION,
  NONE_DESCRIPTOR,
  type AskResult,
  type Catalog,
  type DecisionEvent,
  type Provider,
  type ProviderDescriptor,
  type Result,
} from "../src/decisions/index.ts";

const FALLBACK = "deterministic-verdict";

const catalog: Catalog = {
  version: CONTRACT_VERSION,
  questions: {
    critical: { type: "noul", instructions: "Does this touch money, identity or data integrity?" },
    effort: {
      type: "choice",
      instructions: "How much effort does this need?",
      criteria: { low: null, medium: null, high: null },
    },
  },
  thresholds: {
    critical: { floor: 0.5, escalate: 0.65, act: 0.85 },
    effort: { floor: 0.5, escalate: 0.65, act: 0.85, act_raise: 0.65, act_lower: 0.9 },
  },
};

const descriptor: ProviderDescriptor = {
  name: "stub",
  endpoint: "http://127.0.0.1:1/v1/systemone",
  model: "stub-1.0.0",
  calibrated: true,
  auth_env: "STUB_API_KEY",
  timeout_ms: 50,
  max_options: 255,
  max_state_tokens: 32000,
};

function stub(handler: (questions: string[]) => Promise<Record<string, Result>>): Provider {
  return { descriptor, ask: (req) => handler(req.questions) };
}

/** The whole seam is exercised through this: questions, a stub, a captured event log. */
async function run(
  provider: Provider | undefined,
  extra: Partial<Parameters<typeof ask<string>>[0]> = {},
): Promise<{ r: AskResult<string>; events: DecisionEvent[] }> {
  const events: DecisionEvent[] = [];
  const r = await ask<string>({
    catalog,
    questions: ["critical", "effort"],
    state: { item: "add a retry helper" },
    fallback: FALLBACK,
    provider,
    emit: (e) => events.push(e),
    env: {},
    config: {},
    ...extra,
  });
  return { r, events };
}

const answered = (events: DecisionEvent[], q: string) =>
  events.find((e) => e.event === "decision_answered" && e.question === q);
const failed = (events: DecisionEvent[], q: string) =>
  events.find((e) => e.event === "decision_failed" && e.question === q);

// ---- the four declared scenarios ---------------------------------------------------------

test("scenario: no provider configured — the fallback comes back and every question fails no_provider", async () => {
  const { r, events } = await run(undefined);
  assert.equal(r.usable, false);
  assert.equal(r.fallback, FALLBACK);
  assert.equal(r.provider, NONE_DESCRIPTOR.name);
  assert.equal(r.source, "none");
  for (const q of ["critical", "effort"]) {
    assert.equal(failed(events, q)?.reason, "no_provider", `${q} did not fail as no_provider`);
    assert.equal(r.bands[q], "floor");
    assert.equal(r.answers[q].ok, false);
  }
  assert.equal(events.filter((e) => e.event === "decision_asked").length, 0, "nothing should be asked of nobody");
});

test("scenario: a provider that throws, times out, or answers malformed never propagates", async () => {
  const thrown = await run(
    stub(() => {
      throw new Error("socket hang up");
    }),
  );
  assert.equal(thrown.r.usable, false);
  assert.equal(thrown.r.fallback, FALLBACK);
  assert.equal(failed(thrown.events, "critical")?.reason, "transport");
  assert.match(String(failed(thrown.events, "critical")?.detail), /socket hang up/);

  const rejected = await run(stub(() => Promise.reject(new Error("ECONNREFUSED"))));
  assert.equal(failed(rejected.events, "effort")?.reason, "transport");

  const hung = await run(stub(() => new Promise<Record<string, Result>>(() => {})));
  assert.equal(hung.r.usable, false);
  assert.equal(failed(hung.events, "critical")?.reason, "timeout");
  assert.match(String(failed(hung.events, "critical")?.detail), /50ms/);

  const partial = await run(
    stub(async () => ({ critical: { ok: true, type: "noul", noul: 0.99, confidence: null, provider: "stub", model: "stub-1.0.0" } })),
  );
  assert.equal(failed(partial.events, "effort")?.reason, "malformed");
  assert.equal(partial.r.usable, false, "a partial answer set is not usable");
});

test("scenario: confidence below the floor uses the fallback and records threshold_fired floor", async () => {
  const { r, events } = await run(
    stub(async () => ({
      critical: { ok: true, type: "noul", noul: 0.52, confidence: null, provider: "stub", model: "stub-1.0.0" },
      effort: {
        ok: true,
        type: "choice",
        choice: "medium",
        probabilities: { low: 0.34, medium: 0.36, high: 0.3 },
        confidence: 0.04,
        provider: "stub",
        model: "stub-1.0.0",
      },
    })),
  );
  assert.equal(r.usable, false, "a below-floor answer must not be usable");
  assert.equal(r.fallback, FALLBACK);
  for (const q of ["critical", "effort"]) {
    assert.equal(r.bands[q], "floor");
    assert.equal(answered(events, q)?.threshold_fired, "floor", `${q} did not record the floor band`);
    assert.equal(r.answers[q].ok, true, "the answer is kept for the ledger even when unusable");
  }
});

test("scenario: a confident answer is usable and carries full provenance", async () => {
  const { r, events } = await run(
    stub(async () => ({
      critical: { ok: true, type: "noul", noul: 0.98, confidence: null, provider: "stub", model: "stub-1.0.0" },
      effort: {
        ok: true,
        type: "choice",
        choice: "high",
        probabilities: { low: 0.01, medium: 0.05, high: 0.94 },
        confidence: 0.91,
        provider: "stub",
        model: "stub-1.0.0",
      },
    })),
  );
  assert.equal(r.usable, true);
  assert.deepEqual(r.bands, { critical: "act", effort: "act" });

  const asked = events.find((e) => e.event === "decision_asked");
  assert.deepEqual(asked?.questions, ["critical", "effort"]);
  assert.equal(asked?.model, "stub-1.0.0");

  const ev = answered(events, "effort");
  assert.equal(ev?.model, "stub-1.0.0", "the model that ANSWERED is what gets logged");
  assert.deepEqual(ev?.probabilities, { low: 0.01, medium: 0.05, high: 0.94 });
  assert.equal(ev?.confidence, 0.91);
  assert.equal(typeof ev?.elapsed_ms, "number");
  assert.equal(answered(events, "critical")?.probabilities, undefined, "a noul has no distribution to log");
});

// ---- certainty, bands, resolution --------------------------------------------------------

test("a noul's certainty is its distance from the coin flip; a choice reports its confidence", () => {
  assert.equal(certaintyOf({ ok: true, type: "noul", noul: 0.5, confidence: null, provider: "p", model: "m" }), 0);
  assert.equal(certaintyOf({ ok: true, type: "noul", noul: 1, confidence: null, provider: "p", model: "m" }), 1);
  assert.equal(certaintyOf({ ok: true, type: "noul", noul: 0, confidence: null, provider: "p", model: "m" }), 1);
  assert.equal(
    certaintyOf({ ok: true, type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 0.77, provider: "p", model: "m" }),
    0.77,
  );
});

test("an answer with no expressible confidence cannot clear a floor", () => {
  assert.equal(bandOf(catalog.thresholds.effort, null), "floor");
});

test("the asymmetric bars apply per direction, and default to act when absent", () => {
  const t = catalog.thresholds.effort; // act 0.85, raise 0.65, lower 0.9
  assert.equal(bandOf(t, 0.7, "raise"), "act", "0.7 clears the raise bar");
  assert.equal(bandOf(t, 0.7, "lower"), "escalate", "0.7 does not clear the lower bar");
  assert.equal(bandOf(t, 0.7), "escalate", "without a direction the symmetric act bar applies");
  assert.equal(bandOf(catalog.thresholds.critical, 0.7, "lower"), "escalate", "no act_lower declared -> act");
});

test("resolution order: explicit beats config, config beats env, env beats none", async () => {
  const seen: string[] = [];
  const spy = stub(async (qs) => {
    seen.push("called");
    return Object.fromEntries(
      qs.map((q) => [q, { ok: false, reason: "transport", provider: "stub" } as Result]),
    );
  });
  const providers = { stub: descriptor };

  const explicit = await run(spy, { config: { provider: "nope", providers }, env: { LEOPOLD_DECISIONS_PROVIDER: "nope" } });
  assert.equal(explicit.r.source, "explicit");
  assert.equal(seen.length, 1, "the explicit provider was not used");

  const fromConfig = await run(undefined, { config: { provider: "stub", providers } });
  assert.equal(fromConfig.r.source, "config");

  const fromEnv = await run(undefined, { config: { providers }, env: { LEOPOLD_DECISIONS_PROVIDER: "stub" } });
  assert.equal(fromEnv.r.source, "env");

  const nothing = await run(undefined, { config: {}, env: {} });
  assert.equal(nothing.r.source, "none");
});

test("a configured provider this build does not know fails as no_provider, saying so", async () => {
  const { r, events } = await run(undefined, {
    config: { provider: "quantum", providers: { quantum: { ...descriptor, name: "quantum" } } },
  });
  assert.equal(r.usable, false);
  assert.equal(failed(events, "critical")?.reason, "no_provider");
  assert.match(String(failed(events, "critical")?.detail), /no provider named "quantum"/);
});

test("an invalid catalog fails before the provider is ever called", async () => {
  let called = false;
  const spy = stub(async () => {
    called = true;
    return {};
  });
  const broken: Catalog = { ...catalog, thresholds: { ...catalog.thresholds, ghost: { floor: 0, escalate: 0, act: 1 } } };
  const events: DecisionEvent[] = [];
  const r = await ask<string>({
    catalog: broken,
    questions: ["critical"],
    state: {},
    fallback: FALLBACK,
    provider: spy,
    emit: (e) => events.push(e),
  });
  assert.equal(called, false, "a broken catalog must not reach the provider");
  assert.equal(r.usable, false);
  assert.equal(failed(events, "critical")?.reason, "validation");
  assert.match(String(failed(events, "critical")?.detail), /ghost.*orphan/);
});

test("asking for a question the catalog does not define is a validation failure, not a crash", async () => {
  const events: DecisionEvent[] = [];
  const r = await ask<string>({
    catalog,
    questions: ["critical", "nonexistent"],
    state: {},
    fallback: FALLBACK,
    provider: stub(async () => ({})),
    emit: (e) => events.push(e),
  });
  assert.equal(r.usable, false);
  assert.match(String(failed(events, "nonexistent")?.detail), /no question\(s\): nonexistent/);
});

test("a provider's own Failure is passed through with its reason intact", async () => {
  const { r, events } = await run(
    stub(async (qs) =>
      Object.fromEntries(qs.map((q) => [q, { ok: false, reason: "rate_limit", provider: "stub" } as Result])),
    ),
  );
  assert.equal(r.usable, false);
  assert.equal(failed(events, "critical")?.reason, "rate_limit");
  assert.equal(failed(events, "effort")?.reason, "rate_limit");
});
