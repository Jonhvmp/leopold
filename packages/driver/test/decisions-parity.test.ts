// The two seams, held to one behaviour.
//
// The driver is TypeScript and the hooks are bash, and both ask the same questions of the same
// providers from the same files. That is two implementations of one contract, which is exactly the
// arrangement that drifts. So nothing here is a hand-written expectation: the SAME catalog, config
// and state go through `decisions.sh` and through `ask()` against the SAME stub, and the two
// results are compared to each other. Edit either mapping alone and this goes red.
//
// ONE FIELD IS EXEMPT, on purpose. The driver stamps `elapsed_ms` on its events; the shell does
// not, because portable millisecond timing in POSIX shell is not available (bash 3.2 ships on
// macOS and has no EPOCHREALTIME) and the caller — a hook that already knows when it started — is
// better placed to measure. The exemption is narrow, named, and asserted to be the ONLY one.
//
// MUTATION-VERIFIED: change the shell's band rule to `>` instead of `>=` and the band case fails;
// drop `source` from the shell's events and the event-shape case fails; change the driver's
// no_catalog REASON and the missing-catalog case fails.
//
// HERMETIC: a mkdtemp project, the Python stub on a kernel-chosen port. No network, no key, no
// home directory.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  askCatalog,
  CONTRACT_VERSION,
  type Catalog,
  type DecisionEvent,
  type ProviderDescriptor,
  type Result,
} from "../src/decisions/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STUB = path.join(REPO, "scripts", "decisions", "systemone-stub.py");
const SEAM = path.join(REPO, "extensions", "decisions", "payload", "decisions.sh");
const SCHEMA = path.join(REPO, "packages", "driver", "src", "decisions", "catalog.schema.json");
const KEY = "parity-NEVER-LOGGED-3";

/** Fields the shell seam does not produce. Kept to exactly one, and asserted below. */
const EXEMPT = new Set(["elapsed_ms"]);

const catalog: Catalog = {
  version: CONTRACT_VERSION,
  questions: {
    critical: { type: "noul", instructions: "Does this touch money or identity?" },
    effort: { type: "choice", instructions: "How much effort?", criteria: { high: "wide", low: "cosmetic", medium: "ordinary" } },
    blast: { type: "score", instructions: "How far does a defect reach?", criteria: ["one file", "a module", "cross-cutting"] },
  },
  thresholds: {
    critical: { floor: 0.5, escalate: 0.65, act: 0.85 },
    effort: { floor: 0.5, escalate: 0.65, act: 0.85 },
    blast: { floor: 0.5, escalate: 0.65, act: 0.85 },
  },
};
const QUESTIONS = ["critical", "effort", "blast"];
const STATE = { item: "add a retry helper", callers: 12 };

interface Project {
  leoDir: string;
  descriptor: ProviderDescriptor;
  stateFile: string;
}

async function project(t: TestContext, stubArgs: string[] = ["--script", "200"]): Promise<Project> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-parity-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(path.join(leoDir, "decisions"), { recursive: true });

  const child = spawn("python3", [STUB, "--log", path.join(root, "req.jsonl"), ...stubArgs], { stdio: ["ignore", "pipe", "pipe"] });
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  const descriptor: ProviderDescriptor = {
    name: "jev",
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    model: "jev-1.13.0",
    calibrated: true,
    calibration_source: "trained",
    auth_env: "TYPESAFE_API_KEY",
    timeout_ms: 4000,
    max_options: 255,
    max_state_tokens: 32000,
  };
  fs.writeFileSync(path.join(leoDir, "decisions", "routing.json"), JSON.stringify(catalog, null, 2));
  fs.writeFileSync(
    path.join(leoDir, "decisions", "config.json"),
    JSON.stringify({ version: CONTRACT_VERSION, provider: "jev", providers: { jev: descriptor } }, null, 2),
  );
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(STATE));
  return { leoDir, descriptor, stateFile };
}

interface SeamResult {
  provider: string;
  source: string;
  usable: boolean;
  answers: Record<string, Result>;
  bands: Record<string, string>;
  events: DecisionEvent[];
}

function viaShell(p: Project, questions = QUESTIONS, catalogName = "routing"): SeamResult {
  const out = execFileSync(
    "bash",
    [SEAM, "--leo-dir", p.leoDir, "--catalog", catalogName, "--questions", questions.join(","), "--state-file", p.stateFile, "--schema", SCHEMA],
    { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: KEY } },
  );
  return JSON.parse(out) as SeamResult;
}

async function viaDriver(p: Project, questions = QUESTIONS, catalogName = "routing"): Promise<SeamResult> {
  const events: DecisionEvent[] = [];
  const r = await askCatalog<string>({
    leoDir: p.leoDir,
    catalogName,
    questions,
    state: STATE,
    fallback: "regex-verdict",
    emit: (e) => events.push(e),
    env: { TYPESAFE_API_KEY: KEY },
  });
  return { provider: r.provider, source: r.source, usable: r.usable, answers: r.answers, bands: r.bands, events };
}

const stripExempt = (e: DecisionEvent): Record<string, unknown> =>
  Object.fromEntries(Object.entries(e).filter(([k]) => !EXEMPT.has(k)));

test("scenario: the same catalog and state give both seams the same answers and bands", async (t) => {
  const p = await project(t);
  const shell = viaShell(p);
  const driver = await viaDriver(p);

  assert.equal(shell.provider, driver.provider);
  assert.equal(shell.source, driver.source);
  assert.equal(shell.usable, driver.usable);
  assert.deepEqual(shell.bands, driver.bands, "the two seams banded the same answers differently");
  assert.deepEqual(shell.answers, driver.answers, "the two seams mapped the same response differently");
});

test("scenario: both seams emit the same events, field for field", async (t) => {
  const p = await project(t);
  const shell = viaShell(p);
  const driver = await viaDriver(p);

  const byKey = (evs: DecisionEvent[]) =>
    evs.map(stripExempt).map((e) => JSON.stringify(Object.keys(e).sort())).sort();
  assert.deepEqual(byKey(shell.events), byKey(driver.events), "the event SHAPES diverged");

  const asked = (evs: DecisionEvent[]) => evs.filter((e) => e.event === "decision_asked").map(stripExempt);
  assert.deepEqual(asked(shell.events), asked(driver.events));

  const answered = (evs: DecisionEvent[]) =>
    evs.filter((e) => e.event === "decision_answered").map(stripExempt).sort((a, b) => String(a.question).localeCompare(String(b.question)));
  assert.deepEqual(answered(shell.events), answered(driver.events), "the answered events diverged");

  // The exemption is exactly one field, and it is the driver's alone.
  const driverKeys = new Set(driver.events.flatMap((e) => Object.keys(e)));
  const shellKeys = new Set(shell.events.flatMap((e) => Object.keys(e)));
  const onlyDriver = [...driverKeys].filter((k) => !shellKeys.has(k));
  assert.deepEqual(onlyDriver.sort(), [...EXEMPT].sort(), "a NEW field appeared on one seam only");
});

test("scenario: a missing catalog is the same no_catalog failure on both seams", async (t) => {
  const p = await project(t);
  const shell = viaShell(p, ["critical"], "nope");
  const driver = await viaDriver(p, ["critical"], "nope");

  assert.equal(shell.usable, false);
  assert.equal(driver.usable, false);
  assert.equal(shell.provider, driver.provider);
  const s = shell.answers.critical;
  const d = driver.answers.critical;
  assert.equal(s.ok, false);
  assert.equal(d.ok, false);
  assert.equal(s.ok === false && s.reason, "no_catalog");
  assert.equal(d.ok === false && d.reason, "no_catalog");
});

test("scenario: with jq off PATH the seam exits non-zero and named, and does not hang", () => {
  const started = Date.now();
  let code = 0;
  let stderr = "";
  try {
    // `bash` by absolute path: with PATH emptied, execFileSync could not resolve the interpreter
    // itself, which would have tested the test rather than the seam.
    execFileSync("/bin/bash", [SEAM, "--leo-dir", "/tmp", "--catalog", "routing", "--questions", "critical"], {
      encoding: "utf8",
      env: { PATH: "/nonexistent" },
      timeout: 5000,
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    code = e.status ?? -1;
    stderr = e.stderr ?? "";
  }
  assert.notEqual(code, 0, "a seam that cannot run must not exit 0");
  assert.match(stderr, /jq is not on PATH/);
  assert.match(stderr, /the caller must fall back/);
  assert.ok(Date.now() - started < 5000, "the seam hung instead of failing fast");
});

test("both seams refuse a catalog whose bars were fitted for another provider, identically", async (t) => {
  const p = await project(t);
  fs.writeFileSync(
    path.join(p.leoDir, "decisions", "routing.json"),
    JSON.stringify({ ...catalog, thresholds_for: "openrouter" }, null, 2),
  );
  const shell = viaShell(p);
  const driver = await viaDriver(p);
  assert.equal(shell.usable, false);
  assert.equal(driver.usable, false);
  const s = shell.answers.critical;
  const d = driver.answers.critical;
  assert.equal(s.ok === false && s.reason, "validation");
  assert.equal(d.ok === false && d.reason, "validation");
  assert.equal(
    s.ok === false && s.detail,
    d.ok === false && d.detail,
    "the two seams explain the same refusal differently",
  );
});

test("an answer sitting exactly ON the act bar clears it, on both seams", async (t) => {
  // The boundary is the only place `>=` and `>` differ, and without a case that lands exactly on
  // it a band rule can be mutated in either seam with every other test still green — which is
  // what happened the first time this suite was mutation-checked. The stub's choice confidence is
  // 0.94 by construction, so a bar of exactly 0.94 puts the answer on the line.
  const p = await project(t);
  const onTheLine: Catalog = {
    ...catalog,
    thresholds: { ...catalog.thresholds, effort: { floor: 0.5, escalate: 0.65, act: 0.94 } },
  };
  fs.writeFileSync(path.join(p.leoDir, "decisions", "routing.json"), JSON.stringify(onTheLine, null, 2));

  const shell = viaShell(p);
  const driver = await viaDriver(p);

  assert.equal(
    driver.answers.effort.ok === true && driver.answers.effort.confidence,
    0.94,
    "the stub stopped producing the confidence this case is built on",
  );
  assert.equal(driver.bands.effort, "act", "an answer AT the bar must clear it (>=, not >)");
  assert.equal(shell.bands.effort, "act", "an answer AT the bar must clear it (>=, not >)");
  assert.deepEqual(shell.bands, driver.bands);
});
