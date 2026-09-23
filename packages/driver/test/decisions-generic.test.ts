// `generic` — the escape hatch — and the two properties that make it one: it needs no code, and
// its calibration claim is the operator's, said out loud.
//
// The strongest test here is the descriptor-only one: a config naming "generic" and nothing else,
// resolved through the registry, answering against the stub. If that works, a new wire-compatible
// vendor costs a config entry rather than a pull request.
//
// MUTATION-VERIFIED: make calibrationLabel drop the "(operator-declared, unverified)" caveat and
// the label case fails; remove validateProvider from the shared System One provider and the
// missing-field case fails; give generic.ts its own mapping and the parity case fails.
//
// HERMETIC: the Python stub in its default systemone shape. No network, no key.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ask,
  calibrationLabel,
  CONTRACT_VERSION,
  createGenericProvider,
  createJevProvider,
  GENERIC_DESCRIPTOR,
  JEV_DESCRIPTOR,
  providerNames,
  validateCatalog,
  validateProvider,
  type Catalog,
  type DecisionEvent,
  type ProviderDescriptor,
  type Result,
} from "../src/decisions/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STUB = path.join(REPO, "scripts", "decisions", "systemone-stub.py");
const KEY = "gen-stub-NEVER-LOGGED-9";

const catalog: Catalog = {
  version: CONTRACT_VERSION,
  questions: {
    critical: { type: "noul", instructions: "Does this touch money or identity?" },
    effort: { type: "choice", instructions: "How much effort?", criteria: { high: "wide", low: "cosmetic", medium: "ordinary" } },
  },
  thresholds: {
    critical: { floor: 0.5, escalate: 0.65, act: 0.85 },
    effort: { floor: 0.5, escalate: 0.65, act: 0.85 },
  },
};

async function startStub(t: TestContext, args: string[] = ["--script", "200"]): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-gen-"));
  const child = spawn("python3", [STUB, "--log", path.join(dir, "req.jsonl"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
  return port;
}

/** A complete generic configuration — the thing an operator would actually write. */
function genericAt(port: number, over: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    ...GENERIC_DESCRIPTOR,
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    model: "openjev-sglang-0.4.1",
    auth_env: "LEOPOLD_DECISIONS_API_KEY",
    timeout_ms: 4000,
    ...over,
  };
}

// ---- scenario 1: an operator's calibration claim is honoured AND labelled ---------------------

test("scenario: a generic descriptor declaring calibrated:true is honoured for threshold selection", () => {
  const declared = genericAt(1, { calibrated: true });
  // Honoured: an unlabelled catalog is legal against it, exactly as against a trained provider.
  // (An UNCALIBRATED provider would be refused here — that is the rule from turn 5.)
  assert.deepEqual(validateCatalog(catalog, declared).errors, []);
  assert.equal(validateCatalog(catalog, genericAt(1, { calibrated: false })).ok, false);
});

test("scenario: the doctor label says the claim is the operator's and unverified", () => {
  assert.equal(calibrationLabel(genericAt(1, { calibrated: true })), "calibrated (operator-declared, unverified)");
  assert.equal(calibrationLabel(JEV_DESCRIPTOR), "calibrated");
  assert.equal(calibrationLabel({ calibrated: false }), "UNCALIBRATED — thresholds not portable");
  // The caveat is not optional decoration: an operator-declared claim must never read like a
  // trained one.
  assert.notEqual(calibrationLabel(genericAt(1, { calibrated: true })), calibrationLabel(JEV_DESCRIPTOR));
});

// ---- scenario 2: a half-filled descriptor is refused, by field -------------------------------

test("scenario: a generic descriptor missing endpoint or model is refused, naming the field", () => {
  const noEndpoint = validateProvider({ ...genericAt(1), endpoint: "" });
  assert.equal(noEndpoint.ok, false);
  assert.match(noEndpoint.errors.join(" | "), /endpoint is required/);

  const noModel = validateProvider({ ...genericAt(1), model: "" });
  assert.equal(noModel.ok, false);
  assert.match(noModel.errors.join(" | "), /model is required/);

  // The shipping template is deliberately incomplete, so an unedited copy cannot silently run.
  const template = validateProvider(GENERIC_DESCRIPTOR);
  assert.equal(template.ok, false);
  assert.match(template.errors.join(" | "), /endpoint is required/);
  assert.match(template.errors.join(" | "), /model is required/);
});

test("a moving alias is refused here too: a System One model id lives in Jev's naming universe", () => {
  assert.equal(validateProvider(genericAt(1, { model: "openjev-latest" })).ok, false);
  assert.match(validateProvider(genericAt(1, { model: "openjev-latest" })).errors.join(" | "), /moving alias/);
  assert.deepEqual(validateProvider(genericAt(1)).errors, []);
});

// ---- no provider-specific code path ------------------------------------------------------------

test("a descriptor-only configuration answers through the registry, with no code naming it", async (t) => {
  const port = await startStub(t);
  const events: DecisionEvent[] = [];
  const r = await ask<string>({
    // Bars labelled for the provider that will use them — the turn-5 rule, which an uncalibrated
    // provider like a default `generic` is subject to.
    catalog: { ...catalog, thresholds_for: "generic" },
    questions: ["critical", "effort"],
    state: { item: "add a retry helper" },
    fallback: "regex-verdict",
    // No `provider:` — this resolves through config, exactly as a project's would.
    config: { provider: "generic", providers: { generic: genericAt(port) } },
    env: { LEOPOLD_DECISIONS_API_KEY: KEY },
    emit: (e) => events.push(e),
  });

  assert.equal(r.source, "config");
  assert.equal(r.provider, "generic");
  assert.equal(r.usable, true, "a descriptor-only configuration should have answered");
  assert.equal(r.answers.critical.ok === true && r.answers.critical.type === "noul" && r.answers.critical.noul, 0.95);
  assert.equal(events.find((e) => e.event === "decision_asked")?.provider, "generic");
});

test("generic is in the registry alongside the named vendors", () => {
  assert.deepEqual(providerNames(), ["generic", "jev", "none", "openrouter", "vercel"]);
});

test("generic and jev are the SAME mapping: identical answers but for the provider name", async (t) => {
  const port = await startStub(t, ["--script", "200", "--model", "served/systemone-1"]);
  const call = async (descriptor: ProviderDescriptor, make: typeof createJevProvider): Promise<Record<string, Result>> => {
    const r = await ask<string>({
      catalog: { ...catalog, thresholds_for: descriptor.name },
      questions: ["critical", "effort"],
      state: { item: "add a retry helper" },
      fallback: "regex-verdict",
      provider: make(descriptor, { env: { [descriptor.auth_env]: KEY }, sleep: async () => {} }),
    });
    return r.answers;
  };
  const asGeneric = await call(genericAt(port), createGenericProvider);
  const asJev = await call(
    { ...genericAt(port), name: "jev", model: "jev-1.13.0", auth_env: "TYPESAFE_API_KEY" },
    createJevProvider,
  );
  const strip = (a: Record<string, Result>) =>
    JSON.parse(JSON.stringify(a).replaceAll('"generic"', '"P"').replaceAll('"jev"', '"P"')) as unknown;
  assert.deepEqual(strip(asGeneric), strip(asJev), "the two System One providers diverged");
});

test("a misconfigured generic fails as validation without reaching the network", async (t) => {
  const port = await startStub(t);
  const r = await ask<string>({
    catalog: { ...catalog, thresholds_for: "generic" },
    questions: ["critical"],
    state: {},
    fallback: "regex-verdict",
    provider: createGenericProvider(genericAt(port, { model: "" }), { env: { LEOPOLD_DECISIONS_API_KEY: KEY } }),
  });
  assert.equal(r.usable, false);
  assert.equal(r.answers.critical.ok === false && r.answers.critical.reason, "validation");
  assert.match(String(r.answers.critical.ok === false ? r.answers.critical.detail : ""), /model is required/);
});
