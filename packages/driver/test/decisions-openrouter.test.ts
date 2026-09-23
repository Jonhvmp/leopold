// The first UNCALIBRATED provider, and the rule that exists because of it: a threshold is a
// statement about one model's probabilities, so a provider whose probabilities are not
// calibrated may not borrow bars that were fitted for one that is.
//
// The three scenarios item 5 declares are the first three tests. The rest pin the mapping:
// logprobs into a distribution, an answer outside the enum into `off_schema`, and a model that
// reports no logprobs into an answer that is kept but can never clear a floor.
//
// MUTATION-VERIFIED: drop the thresholds_for check in validateCatalog and the first two cases
// fail; make `estimated` unset when the distribution is asserted and the no-logprobs case fails;
// accept an answer outside the enum and the off-schema case fails.
//
// HERMETIC: the Python stub in `--shape chat`, on a kernel-chosen port. No network, no key.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ask,
  bandOf,
  certaintyOf,
  confidenceFrom,
  CONTRACT_VERSION,
  createOpenRouterProvider,
  distributionFrom,
  enumFor,
  JEV_DESCRIPTOR,
  OPENROUTER_DESCRIPTOR,
  validateCatalog,
  type Catalog,
  type DecisionEvent,
  type ProviderDescriptor,
} from "../src/decisions/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STUB = path.join(REPO, "scripts", "decisions", "systemone-stub.py");
const FAKE_KEY = "or-stub-NEVER-LOGGED-42";

/** Bars chosen FOR openrouter: higher than jev's, because an uncalibrated answer earns less. */
const catalog: Catalog = {
  version: CONTRACT_VERSION,
  thresholds_for: "openrouter",
  questions: {
    effort: { type: "choice", instructions: "How much effort?", criteria: { high: "wide", low: "cosmetic", medium: "ordinary" } },
    critical: { type: "noul", instructions: "Does this touch money or identity?" },
    blast: { type: "score", instructions: "How far does a defect reach?", criteria: ["one file", "a module", "cross-cutting"] },
  },
  thresholds: {
    effort: { floor: 0.5, escalate: 0.8, act: 0.95 },
    critical: { floor: 0.5, escalate: 0.8, act: 0.95 },
    blast: { floor: 0.5, escalate: 0.8, act: 0.95 },
  },
};

async function startStub(t: TestContext, args: string[]): Promise<{ port: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-or-"));
  const child = spawn("python3", [STUB, "--log", path.join(dir, "req.jsonl"), "--shape", "chat", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString();
      const m = buf.match(/^PORT (\d+)/m);
      if (m) resolve(Number(m[1]));
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("no port in 5s")), 5000);
  });
  t.after(() => {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { port };
}

function descriptorFor(port: number, over: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return { ...OPENROUTER_DESCRIPTOR, endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: "openai/gpt-5.1", timeout_ms: 4000, ...over };
}

async function run(port: number, over: Partial<ProviderDescriptor> = {}, cat: Catalog = catalog) {
  const events: DecisionEvent[] = [];
  const provider = createOpenRouterProvider(descriptorFor(port, over), {
    env: { OPENROUTER_API_KEY: FAKE_KEY },
    sleep: async () => {},
  });
  const r = await ask<string>({
    catalog: cat,
    questions: ["effort", "critical", "blast"],
    state: { item: "add a retry helper" },
    fallback: "regex-verdict",
    provider,
    emit: (e) => events.push(e),
  });
  return { r, events };
}

// ---- scenario 1: thresholds do not cross providers ---------------------------------------

test("scenario: a catalog fitted for jev is refused when openrouter is active, naming both", () => {
  const borrowed: Catalog = { ...catalog, thresholds_for: "jev" };
  const r = validateCatalog(borrowed, descriptorFor(1));
  assert.equal(r.ok, false);
  const m = r.errors.join(" | ");
  assert.match(m, /"jev"/, "the provider the bars were fitted for is not named");
  assert.match(m, /"openrouter"/, "the active provider is not named");
  assert.match(m, /does not carry across providers/);
});

test("an uncalibrated provider must carry its own bars — an unlabelled catalog is refused", () => {
  const unlabelled: Catalog = { ...catalog };
  delete (unlabelled as { thresholds_for?: string }).thresholds_for;
  const r = validateCatalog(unlabelled, descriptorFor(1));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" | "), /uncalibrated, so it must carry thresholds fitted for itself/);

  // The same unlabelled catalog is fine for a CALIBRATED provider: that is the backward
  // compatible case, and it reads as "these bars are this project's own judgement".
  assert.deepEqual(validateCatalog(unlabelled, JEV_DESCRIPTOR).errors, []);
});

test("a catalog fitted for the active uncalibrated provider validates", () => {
  assert.deepEqual(validateCatalog(catalog, descriptorFor(1)).errors, []);
});

// ---- scenario 2: no logprobs ---------------------------------------------------------------

test("scenario: a model that reports no logprobs yields a one-hot, unmeasured answer that cannot act", async (t) => {
  const { port } = await startStub(t, ["--script", "200", "--no-logprobs", "--model", "openai/gpt-5.1-served"]);
  const { r, events } = await run(port);

  assert.equal(r.usable, false, "an asserted distribution must never clear a bar");
  assert.equal(r.fallback, "regex-verdict");

  const effort = r.answers.effort;
  assert.equal(effort.ok, true);
  assert.equal(effort.ok === true && effort.estimated, true, "the answer must be marked unmeasured");
  assert.equal(effort.ok === true && effort.confidence, null);
  assert.deepEqual(effort.ok === true && effort.type === "choice" ? effort.probabilities : null, { high: 1, low: 0, medium: 0 });

  for (const q of ["effort", "critical", "blast"]) {
    assert.equal(r.bands[q], "floor", `${q} must land on the floor`);
    assert.equal(events.find((e) => e.event === "decision_answered" && e.question === q)?.certainty, null);
  }

  // A one-hot noul would read as total certainty without the `estimated` flag — this is the
  // case the flag exists for.
  const critical = r.answers.critical;
  assert.equal(critical.ok === true && critical.type === "noul" && critical.noul, 1);
  assert.equal(certaintyOf(critical.ok === true ? critical : ({} as never)), null);
});

// ---- scenario 3: off schema -----------------------------------------------------------------

test("scenario: an answer outside the catalog's options is off_schema, never coerced", async (t) => {
  const { port } = await startStub(t, ["--script", "200", "--off-schema"]);
  const { r } = await run(port);
  for (const q of ["effort", "critical", "blast"]) {
    const a = r.answers[q];
    assert.equal(a.ok, false, `${q} was coerced instead of refused`);
    assert.equal(a.ok === false && a.reason, "off_schema");
    assert.match(String(a.ok === false ? a.detail : ""), /NOT_AN_OPTION/);
  }
});

// ---- the mapping -----------------------------------------------------------------------------

test("logprobs become the distribution, and the served model is what gets logged", async (t) => {
  const { port } = await startStub(t, ["--script", "200", "--model", "openai/gpt-5.1-served"]);
  const { r, events } = await run(port);

  const effort = r.answers.effort;
  assert.equal(effort.ok === true && effort.type === "choice" && effort.choice, "high");
  assert.equal(effort.ok === true && effort.estimated, undefined, "a measured distribution is not estimated");
  const probs = effort.ok === true && effort.type === "choice" ? effort.probabilities : {};
  assert.ok(probs.high > 0.9, `expected the head to carry the mass, got ${JSON.stringify(probs)}`);
  assert.ok(Math.abs(Object.values(probs).reduce((a, b) => a + b, 0) - 1) < 1e-6, "probabilities must sum to 1");
  assert.equal(effort.ok === true && effort.confidence, confidenceFrom(probs));
  assert.equal(effort.ok === true && effort.model, "openai/gpt-5.1-served");
  assert.equal(events.find((e) => e.event === "decision_answered" && e.question === "effort")?.model, "openai/gpt-5.1-served");

  // A score's expectation is taken over the level indices, and the legend comes from the catalog.
  const blast = r.answers.blast;
  assert.equal(blast.ok === true && blast.type === "score" && blast.score < 0.2, true, "mass on level 0 means a low score");
  assert.deepEqual(blast.ok === true && blast.type === "score" ? blast.legend : null, {
    "0": "one file",
    "1": "a module",
    "2": "cross-cutting",
  });
});

test("the answer space is the enum the model is constrained to", () => {
  assert.deepEqual(enumFor(catalog.questions.effort), ["high", "low", "medium"]);
  assert.deepEqual(enumFor(catalog.questions.critical), ["true", "false"]);
  assert.deepEqual(enumFor(catalog.questions.blast), ["0", "1", "2"]);
});

test("a logprob payload with nothing matching the enum yields no distribution", () => {
  assert.equal(distributionFrom({}, ["a", "b"]), null, "no logprobs at all");
  assert.equal(
    distributionFrom({ logprobs: { content: [{ token: "zzz", top_logprobs: [{ token: "zzz", logprob: -0.1 }] }] } }, ["a", "b"]),
    null,
    "logprobs that mention none of the options",
  );
});

test("borrowing a calibrated provider's bars would have changed the decision — which is why it is refused", async (t) => {
  // This is the rule's reason, measured rather than asserted. ONE answer, ONE distribution, two
  // sets of bars: jev's (act 0.85) would have acted on it; openrouter's own (act 0.95) does not.
  // If the loader let a catalog carry bars across providers, that difference would be silent.
  const { port } = await startStub(t, ["--script", "200"]);
  const own = await run(port, {}, catalog);

  const borrowedNumbers: Catalog = {
    ...catalog,
    thresholds: { ...catalog.thresholds, effort: { floor: 0.5, escalate: 0.65, act: 0.85 } },
  };
  const borrowed = await run(port, {}, borrowedNumbers);

  const confidence = own.r.answers.effort.ok === true ? own.r.answers.effort.confidence : null;
  assert.ok(confidence !== null && confidence > 0.85 && confidence < 0.95, `expected a confidence between the two bars, got ${confidence}`);

  assert.equal(own.r.bands.effort, "escalate", "openrouter's own bar is not cleared by this answer");
  assert.equal(own.r.usable, false, "and so the consumer falls back");
  assert.equal(borrowed.r.bands.effort, "act", "jev's bar WOULD have been cleared by the very same answer");

  // The loader is what stops that difference from ever being reached by accident.
  const mislabelled: Catalog = { ...borrowedNumbers, thresholds_for: "jev" };
  assert.equal(validateCatalog(mislabelled, descriptorFor(port)).ok, false);
});

test("the shipping descriptor is uncalibrated and ships no model to guess with", () => {
  assert.equal(OPENROUTER_DESCRIPTOR.calibrated, false);
  assert.equal(OPENROUTER_DESCRIPTOR.calibration_source, undefined);
  assert.equal(OPENROUTER_DESCRIPTOR.auth_env, "OPENROUTER_API_KEY");
  assert.equal(OPENROUTER_DESCRIPTOR.model, "", "a default model would put an unpinned guess in every config");
});
