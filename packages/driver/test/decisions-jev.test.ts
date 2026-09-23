// The `jev` provider against a real HTTP server — the Python stub in scripts/decisions/ —
// with no network and no key that means anything.
//
// Every path item 4 promises is walked here: the happy mapping, the 429/429/200 retry with its
// backoff schedule, the statuses that must NOT be retried, and the model pin. The stub logs
// only the Authorization SCHEME, which is what lets the leak test be a proof rather than a
// hope: a fake key with a distinctive value is used, and then searched for everywhere the
// provider could have put it.
//
// MUTATION-VERIFIED: add 401 to RETRYABLE and the no-retry case fails on the request count;
// return `descriptor.model` instead of `parsed.model` and the provenance case fails; drop the
// validateProvider call and the pin case fails.
//
// HERMETIC: binds 127.0.0.1 on a kernel-chosen port, writes only to a mkdtemp directory, and
// kills the child in every exit path.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ask,
  CONTRACT_VERSION,
  createJevProvider,
  JEV_DESCRIPTOR,
  type Catalog,
  type DecisionEvent,
  type ProviderDescriptor,
  type Result,
} from "../src/decisions/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STUB = path.join(REPO, "scripts", "decisions", "systemone-stub.py");

/** A key with a value nothing else in this file uses, so a search for it is meaningful. */
const FAKE_KEY = "sk-stub-NEVER-LOGGED-8f31";

const catalog: Catalog = {
  version: CONTRACT_VERSION,
  questions: {
    critical: { type: "noul", instructions: "Does this touch money or identity?" },
    effort: {
      type: "choice",
      instructions: "How much effort?",
      criteria: { high: "wide blast radius", low: "cosmetic", medium: "ordinary" },
    },
    blast: { type: "score", instructions: "How far does a defect reach?", criteria: ["one file", "a module", "cross-cutting"] },
  },
  thresholds: {
    critical: { floor: 0.5, escalate: 0.65, act: 0.85 },
    effort: { floor: 0.5, escalate: 0.65, act: 0.85 },
    blast: { floor: 0.5, escalate: 0.65, act: 0.85 },
  },
};

interface Stub {
  port: number;
  logPath: string;
  requests(): Array<Record<string, unknown>>;
  stop(): void;
}

async function startStub(t: TestContext, args: string[]): Promise<Stub> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-decisions-"));
  const logPath = path.join(dir, "requests.jsonl");
  const child: ChildProcessWithoutNullStreams = spawn(
    "python3",
    [STUB, "--log", logPath, ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/^PORT (\d+)/m);
      if (m) {
        child.stdout.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`stub exited early (${code})`)));
    setTimeout(() => reject(new Error("stub did not report a port in 5s")), 5000);
  });
  const stop = () => {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  };
  t.after(stop);
  return {
    port,
    logPath,
    stop,
    requests: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

function descriptorFor(port: number, over: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return { ...JEV_DESCRIPTOR, endpoint: `http://127.0.0.1:${port}/v1/systemone`, timeout_ms: 4000, ...over };
}

/** Drive the provider through the seam, the way a consumer would. */
async function callThroughSeam(
  d: ProviderDescriptor,
  opts: { sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv } = {},
): Promise<{ answers: Record<string, Result>; events: DecisionEvent[]; usable: boolean }> {
  const events: DecisionEvent[] = [];
  const delays: number[] = [];
  const provider = createJevProvider(d, {
    env: opts.env ?? { [d.auth_env]: FAKE_KEY },
    sleep: opts.sleep ?? (async (ms) => void delays.push(ms)),
  });
  const r = await ask<string>({
    catalog,
    questions: ["critical", "effort", "blast"],
    state: { item: "add a retry helper", callers: 12 },
    fallback: "regex-verdict",
    provider,
    emit: (e) => events.push(e),
  });
  return { answers: r.answers, events, usable: r.usable };
}

test("scenario: a well-formed answer maps to the contract shape, and the model comes from the RESPONSE", async (t) => {
  const stub = await startStub(t, ["--script", "200", "--model", "jev-1.13.0-served"]);
  const { answers, events, usable } = await callThroughSeam(descriptorFor(stub.port));

  assert.equal(usable, true);

  const critical = answers.critical;
  assert.equal(critical.ok, true);
  assert.equal(critical.ok === true && critical.type, "noul");
  assert.equal(critical.ok === true && critical.type === "noul" && critical.noul, 0.95);
  assert.equal(
    critical.ok === true && critical.type === "noul" && critical.confidence,
    null,
    "a noul must carry no invented confidence",
  );

  const effort = answers.effort;
  assert.equal(effort.ok === true && effort.type === "choice" && effort.choice, "high");
  assert.equal(effort.ok === true && effort.type === "choice" && effort.confidence, 0.94);

  const blast = answers.blast;
  assert.equal(blast.ok === true && blast.type === "score" && blast.score, 1.0);
  assert.deepEqual(
    blast.ok === true && blast.type === "score" ? blast.legend : null,
    { "0": "one file", "1": "a module", "2": "cross-cutting" },
  );

  // Provenance: the served model, not the requested one.
  for (const q of ["critical", "effort", "blast"]) {
    const a = answers[q];
    assert.equal(a.ok === true && a.model, "jev-1.13.0-served", `${q} logged the requested model, not the served one`);
  }
  assert.equal(events.find((e) => e.event === "decision_answered" && e.question === "effort")?.model, "jev-1.13.0-served");

  // The request actually carried the state and every question id.
  const [req] = stub.requests();
  assert.equal(req.model_requested, "jev-1.13.0");
  assert.deepEqual(req.question_ids, ["blast", "critical", "effort"]);
  assert.equal(req.state_type, "dict");
});

test("scenario: 429 twice then 200 — two backoffs, one decision_retry each, and it succeeds", async (t) => {
  const stub = await startStub(t, ["--script", "429,429,200"]);
  const delays: number[] = [];
  const { usable, events } = await callThroughSeam(descriptorFor(stub.port), {
    sleep: async (ms) => void delays.push(ms),
  });

  assert.equal(usable, true, "the third attempt should have succeeded");
  const retries = events.filter((e) => e.event === "decision_retry");
  assert.equal(retries.length, 2, "one decision_retry per failed attempt");
  assert.deepEqual(retries.map((e) => e.attempt), [1, 2]);
  assert.deepEqual(retries.map((e) => e.status), [429, 429]);
  assert.deepEqual(retries.map((e) => e.reason), ["rate_limit", "rate_limit"]);
  assert.deepEqual(delays, [250, 500], "backoff must double");
  assert.equal(stub.requests().length, 3);
});

test("a retry-after header overrides the computed backoff", async (t) => {
  const stub = await startStub(t, ["--script", "529,200", "--retry-after", "1.5"]);
  const delays: number[] = [];
  const { usable, events } = await callThroughSeam(descriptorFor(stub.port), {
    sleep: async (ms) => void delays.push(ms),
  });
  assert.equal(usable, true);
  assert.deepEqual(delays, [1500], "retry-after seconds must win over the schedule");
  assert.equal(events.find((e) => e.event === "decision_retry")?.reason, "overloaded");
});

test("scenario: 401 fails as auth, is never retried, and the key appears nowhere", async (t) => {
  const stub = await startStub(t, ["--script", "401"]);
  const { answers, events, usable } = await callThroughSeam(descriptorFor(stub.port));

  assert.equal(usable, false);
  for (const q of ["critical", "effort", "blast"]) {
    const a = answers[q];
    assert.equal(a.ok, false);
    assert.equal(a.ok === false && a.reason, "auth");
  }
  assert.equal(stub.requests().length, 1, "an auth failure must not be retried");
  assert.equal(events.filter((e) => e.event === "decision_retry").length, 0);

  // The leak proof: the key is in none of the surfaces the provider writes to.
  const surfaces = JSON.stringify({ answers, events }) + fs.readFileSync(stub.logPath, "utf8");
  assert.equal(surfaces.includes(FAKE_KEY), false, "the API key leaked into an answer, an event or the request log");
  assert.equal(stub.requests()[0].auth_scheme, "Bearer", "the key was not sent as a bearer token");
  assert.equal(stub.requests()[0].auth_present, true);
});

test("422 fails as validation and is never retried", async (t) => {
  const stub = await startStub(t, ["--script", "422"]);
  const { answers } = await callThroughSeam(descriptorFor(stub.port));
  assert.equal(answers.critical.ok === false && answers.critical.reason, "validation");
  assert.equal(stub.requests().length, 1, "a rejected request must not be retried");
});

test("a retryable status that never clears exhausts the budget and fails with its own reason", async (t) => {
  const stub = await startStub(t, ["--script", "529"]);
  const { answers, events } = await callThroughSeam(descriptorFor(stub.port), { sleep: async () => {} });
  assert.equal(answers.effort.ok === false && answers.effort.reason, "overloaded");
  assert.equal(stub.requests().length, 3, "the attempt budget is 3");
  assert.equal(events.filter((e) => e.event === "decision_retry").length, 2);
});

test("scenario: a moving alias is refused at validation time, naming the pin rule", async (t) => {
  const stub = await startStub(t, ["--script", "200"]);
  const { answers, usable } = await callThroughSeam(descriptorFor(stub.port, { model: "jev-latest" }));
  assert.equal(usable, false);
  const a = answers.critical;
  assert.equal(a.ok === false && a.reason, "validation");
  assert.match(String(a.ok === false ? a.detail : ""), /moving alias/);
  assert.match(String(a.ok === false ? a.detail : ""), /pin an exact version/);
  assert.equal(stub.requests().length, 0, "a pin violation must never reach the network");
});

test("a missing key fails as auth without a request, naming the variable and not a value", async (t) => {
  const stub = await startStub(t, ["--script", "200"]);
  const { answers } = await callThroughSeam(descriptorFor(stub.port), { env: {} });
  const a = answers.critical;
  assert.equal(a.ok === false && a.reason, "auth");
  assert.equal(a.ok === false && a.detail, "TYPESAFE_API_KEY is not set");
  assert.equal(stub.requests().length, 0);
});

test("the shipping descriptor is pinned, calibrated, and sized to the documented limits", () => {
  assert.equal(JEV_DESCRIPTOR.model, "jev-1.13.0");
  assert.equal(JEV_DESCRIPTOR.calibrated, true);
  assert.equal(JEV_DESCRIPTOR.calibration_source, "trained");
  assert.equal(JEV_DESCRIPTOR.max_options, 255);
  assert.equal(JEV_DESCRIPTOR.max_state_tokens, 32000);
  assert.equal(JEV_DESCRIPTOR.auth_env, "TYPESAFE_API_KEY");
});

test("the error body is consumed before a retry, so the connection is released", async () => {
  // WHY THIS IS A TEST AND NOT A COMMENT. An unread response body is never returned to the
  // connection pool, so a retry can stall or leak a connection against a real service. The
  // stub server is threaded and therefore tolerant of the bug, which means the end-to-end
  // cases above pass either way — verified by mutation: removing the drain leaves all nine of
  // them green. The observable property is that the provider CONSUMES the body, and a fake
  // fetch can see that directly. `Response.bodyUsed` is the platform's own witness.
  const seen: Array<{ status: number; bodyUsed: boolean }> = [];
  const responses = [
    new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 }),
    new Response(JSON.stringify({ model: "jev-1.13.0", answers: { critical: { type: "noul", noul: 0.95 } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  const first = responses[0];
  const fetchImpl = (async () => {
    const res = responses.shift()!;
    // When the SECOND request is issued, the first response must already be consumed.
    if (res.status === 200) seen.push({ status: first.status, bodyUsed: first.bodyUsed });
    return res;
  }) as unknown as typeof fetch;

  const provider = createJevProvider(descriptorFor(1, { timeout_ms: 4000 }), {
    fetchImpl,
    env: { TYPESAFE_API_KEY: FAKE_KEY },
    sleep: async () => {},
  });
  const events: DecisionEvent[] = [];
  const r = await ask<string>({
    catalog,
    questions: ["critical"],
    state: {},
    fallback: "regex-verdict",
    provider,
    emit: (e) => events.push(e),
  });

  assert.equal(r.usable, true, "the retry should have succeeded");
  assert.equal(seen.length, 1, "the second attempt never happened");
  assert.equal(
    seen[0].bodyUsed,
    true,
    "the 429 body was still unread when the retry was issued — the connection is not released",
  );
  assert.equal(
    (responses as unknown[]).length,
    0,
    "both canned responses should have been used",
  );
  assert.equal(events.filter((e) => e.event === "decision_retry").length, 1);
});
