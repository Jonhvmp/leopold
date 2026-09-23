// `vercel` — the Vercel AI Gateway — and the proof that it is a descriptor rather than a second
// implementation.
//
// The sharing is asserted BEHAVIOURALLY, not by reading the source: the same catalog and the same
// stub response, put through `openrouter` and through `vercel`, must produce answers that differ
// only in the provider name. A future edit that special-cases one gateway fails here, which is
// what "share the mapping code" has to mean if it is to stay true.
//
// MUTATION-VERIFIED: give vercel.ts its own `toAnswer` that rounds differently and the parity
// case fails; drop the `body.error` branch in llm.ts and the envelope case fails; remove the
// empty-model guard and the unset-model case fails.
//
// HERMETIC: the Python stub in `--shape chat`. No network, no key.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ask,
  CONTRACT_VERSION,
  createOpenRouterProvider,
  createVercelProvider,
  JEV_DESCRIPTOR,
  validateCatalog,
  VERCEL_DESCRIPTOR,
  type Catalog,
  type DecisionEvent,
  type ProviderDescriptor,
  type Result,
} from "../src/decisions/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STUB = path.join(REPO, "scripts", "decisions", "systemone-stub.py");

const ENV = { AI_GATEWAY_API_KEY: "vc-stub-NEVER-LOGGED-7", OPENROUTER_API_KEY: "or-stub-NEVER-LOGGED-7" };

const catalog: Catalog = {
  version: CONTRACT_VERSION,
  thresholds_for: "vercel",
  questions: {
    effort: { type: "choice", instructions: "How much effort?", criteria: { high: "wide", low: "cosmetic", medium: "ordinary" } },
    critical: { type: "noul", instructions: "Does this touch money or identity?" },
    blast: { type: "score", instructions: "How far does a defect reach?", criteria: ["one file", "a module", "cross-cutting"] },
  },
  thresholds: {
    effort: { floor: 0.5, escalate: 0.8, act: 0.9 },
    critical: { floor: 0.5, escalate: 0.8, act: 0.9 },
    blast: { floor: 0.5, escalate: 0.8, act: 0.9 },
  },
};

async function startStub(t: TestContext, args: string[]): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-vc-"));
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
  return port;
}

function vercelAt(port: number, over: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return { ...VERCEL_DESCRIPTOR, endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: "openai/gpt-5.1", timeout_ms: 4000, ...over };
}

async function run(
  descriptor: ProviderDescriptor,
  make = createVercelProvider,
  cat: Catalog = catalog,
): Promise<{ answers: Record<string, Result>; events: DecisionEvent[]; usable: boolean }> {
  const events: DecisionEvent[] = [];
  const r = await ask<string>({
    catalog: cat,
    questions: ["effort", "critical", "blast"],
    state: { item: "add a retry helper" },
    fallback: "regex-verdict",
    provider: make(descriptor, { env: ENV, sleep: async () => {} }),
    emit: (e) => events.push(e),
  });
  return { answers: r.answers, events, usable: r.usable };
}

// ---- the two declared scenarios --------------------------------------------------------------

test("scenario: the gateway resolves a routing string, and the CONCRETE model is what gets logged", async (t) => {
  const port = await startStub(t, ["--script", "200", "--model", "anthropic/claude-sonnet-5-20260115"]);
  const { answers, events } = await run(vercelAt(port, { model: "anthropic/claude-sonnet-5" }));

  for (const q of ["effort", "critical", "blast"]) {
    assert.equal(
      answers[q].ok === true && answers[q].model,
      "anthropic/claude-sonnet-5-20260115",
      `${q} logged the routing string instead of the model that answered`,
    );
  }
  assert.equal(
    events.find((e) => e.event === "decision_answered" && e.question === "effort")?.model,
    "anthropic/claude-sonnet-5-20260115",
  );
  // The request still carried what the operator configured.
  assert.equal(events.find((e) => e.event === "decision_asked")?.model, "anthropic/claude-sonnet-5");
});

test("scenario: a provider-level error envelope is a named failure, not a parse crash", async (t) => {
  const port = await startStub(t, ["--script", "200", "--error-envelope"]);
  const { answers, usable } = await run(vercelAt(port));

  assert.equal(usable, false);
  for (const q of ["effort", "critical", "blast"]) {
    const a = answers[q];
    assert.equal(a.ok, false);
    assert.equal(a.ok === false && a.reason, "transport");
    assert.match(String(a.ok === false ? a.detail : ""), /upstream provider_error/);
    assert.match(String(a.ok === false ? a.detail : ""), /upstream model unavailable/);
    assert.doesNotMatch(String(a.ok === false ? a.detail : ""), /not JSON/, "the envelope must not read as malformed");
  }
});

// ---- the four cases openrouter passes --------------------------------------------------------

test("a catalog fitted for another provider is refused, naming both", () => {
  const borrowed: Catalog = { ...catalog, thresholds_for: "jev" };
  const r = validateCatalog(borrowed, vercelAt(1));
  assert.equal(r.ok, false);
  const m = r.errors.join(" | ");
  assert.match(m, /"jev"/);
  assert.match(m, /"vercel"/);
  assert.deepEqual(validateCatalog(catalog, vercelAt(1)).errors, []);
  // Unlabelled bars remain legal for a calibrated provider only.
  const unlabelled: Catalog = { ...catalog };
  delete (unlabelled as { thresholds_for?: string }).thresholds_for;
  assert.equal(validateCatalog(unlabelled, vercelAt(1)).ok, false);
  assert.deepEqual(validateCatalog(unlabelled, JEV_DESCRIPTOR).errors, []);
});

test("no logprobs means an unmeasured answer that cannot clear a floor", async (t) => {
  const port = await startStub(t, ["--script", "200", "--no-logprobs"]);
  const { answers, usable } = await run(vercelAt(port));
  assert.equal(usable, false);
  assert.equal(answers.effort.ok === true && answers.effort.estimated, true);
  assert.equal(answers.effort.ok === true && answers.effort.confidence, null);
});

test("an answer outside the enum is off_schema", async (t) => {
  const port = await startStub(t, ["--script", "200", "--off-schema"]);
  const { answers } = await run(vercelAt(port));
  assert.equal(answers.critical.ok === false && answers.critical.reason, "off_schema");
});

test("logprobs become a measured distribution", async (t) => {
  const port = await startStub(t, ["--script", "200"]);
  const { answers } = await run(vercelAt(port));
  const effort = answers.effort;
  assert.equal(effort.ok === true && effort.type === "choice" && effort.choice, "high");
  assert.equal(effort.ok === true && effort.estimated, undefined);
  assert.ok((effort.ok === true && effort.confidence ? effort.confidence : 0) > 0.85);
});

// ---- the sharing, proven --------------------------------------------------------------------

test("vercel and openrouter are the SAME mapping: identical answers but for the provider name", async (t) => {
  const port = await startStub(t, ["--script", "200", "--model", "served/model-1"]);

  const asVercel = await run(vercelAt(port), createVercelProvider);
  const asOpenRouter = await run(
    { ...vercelAt(port), name: "openrouter", auth_env: "OPENROUTER_API_KEY" },
    createOpenRouterProvider,
    { ...catalog, thresholds_for: "openrouter" },
  );

  const strip = (answers: Record<string, Result>) =>
    JSON.parse(JSON.stringify(answers).replaceAll('"vercel"', '"P"').replaceAll('"openrouter"', '"P"')) as unknown;

  assert.deepEqual(
    strip(asVercel.answers),
    strip(asOpenRouter.answers),
    "the two gateways diverged — one of them has grown its own mapping",
  );
  assert.equal(asVercel.usable, asOpenRouter.usable);
});

test("a descriptor with no model set is a named configuration failure, not a guess", async (t) => {
  const port = await startStub(t, ["--script", "200"]);
  const { answers } = await run(vercelAt(port, { model: "" }));
  const a = answers.effort;
  assert.equal(a.ok === false && a.reason, "validation");
  assert.match(String(a.ok === false ? a.detail : ""), /has no model set/);
});

test("the shipping descriptor is uncalibrated, gateway-addressed, and model-less", () => {
  assert.equal(VERCEL_DESCRIPTOR.calibrated, false);
  assert.equal(VERCEL_DESCRIPTOR.auth_env, "AI_GATEWAY_API_KEY");
  assert.equal(VERCEL_DESCRIPTOR.model, "");
  assert.match(VERCEL_DESCRIPTOR.endpoint, /ai-gateway\.vercel\.sh/);
});
