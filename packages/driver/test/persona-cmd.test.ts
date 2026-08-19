// Unit tests for the `leopold persona` CLI shell: subcommand dispatch, the
// exit-code contract, the loud "nothing to run" answer, list's status lines,
// report's byte-stable re-synthesis, and the provider seam — the run reaches a
// harness ONLY through src/sdk.ts, so a stubbed seam proves conduction routes
// through whatever --provider resolved (same style as run's provider tests).
// Hermetic: every project lives in a temp dir; zero model calls.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { resolveProvider } from "../src/provider.ts";
import { runPersonaCommand, NOTHING_TO_RUN, existingSummaryOf, resolveAppVersion } from "../src/persona-testing/persona-cmd.ts";
import { JOURNEY_FILE, JOURNEY_SCHEMA, headerLine } from "../src/persona-testing/journey.ts";
import { SUMMARY_PLACEHOLDER } from "../src/persona-testing/report.ts";
import { OUTCOME_FENCE } from "../src/persona-testing/conduct.ts";

afterEach(() => resetQuery());

// -- Fixtures -----------------------------------------------------------------

const FLOW_TEXT = `# Flow — checkout

## Entry point
https://shop.example.com/

## Goal
Buy the starter plan as a first-time visitor.

## Success criteria
- reaches the order confirmation screen

## Domain allowlist (hard boundary)
- shop.example.com

## Out of bounds
- submitting a real payment

## App version pin
build-42

## Step budget
max_turns: 10
`;

function contractText(id: string, status = "ready"): string {
  return `schema_version: "persona-contract/1.0"\npersona_id: "${id}"\ncontract_status: "${status}"\n`;
}

/** A hermetic project. A decoy .leopold at the outer root pins findLeoDir's
 *  up-tree walk (same trick as recall-cmd.test.ts) for the no-module cases. */
function project(opts: { withModule?: boolean; personas?: Array<{ id: string; status?: string }>; withFlow?: boolean } = {}): string {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "leo-persona-cmd-"));
  fs.mkdirSync(path.join(outer, ".leopold"));
  const root = path.join(outer, "proj");
  fs.mkdirSync(path.join(root, ".leopold"), { recursive: true });
  if (opts.withModule || opts.personas || opts.withFlow) {
    const personaDir = path.join(root, ".leopold", "persona");
    fs.mkdirSync(path.join(personaDir, "flows"), { recursive: true });
    fs.mkdirSync(path.join(personaDir, "personas"), { recursive: true });
    if (opts.withFlow !== false) fs.writeFileSync(path.join(personaDir, "flows", "checkout.md"), FLOW_TEXT);
    for (const p of opts.personas ?? []) {
      const dir = path.join(personaDir, "personas", p.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "contract.yaml"), contractText(p.id, p.status ?? "ready"));
    }
  }
  return root;
}

/** Run the command with stdout/stderr captured. */
async function run(cwd: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const log = console.log, error = console.error, write = process.stdout.write;
  let out = "", err = "";
  console.log = (...a: unknown[]) => { out += `${a.join(" ")}\n`; };
  console.error = (...a: unknown[]) => { err += `${a.join(" ")}\n`; };
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try {
    return { code: await runPersonaCommand(cwd, argv), out, err };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}

type Msg = { type: string; message?: { content: Array<{ type: string; text: string }> }; result?: string };
const A = (text: string): Msg => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

/** A seam stub: every worker declares "blocked" immediately; the summary turn
 *  answers a fixed line. Records how many times the seam was reached. */
function stubSeam(): { calls: () => number } {
  let n = 0;
  setQuery(((input: { prompt: unknown }) =>
    (async function* (): AsyncGenerator<Msg> {
      n += 1;
      if (typeof input.prompt === "string") {
        yield A("Summary line.");
        yield { type: "result", result: "Summary line." };
        return;
      }
      for await (const _ of input.prompt as AsyncIterable<unknown>) break;
      yield A("```" + OUTCOME_FENCE + '\n{"outcome": "blocked", "detail": "cannot perceive the surface"}\n```');
      yield { type: "result" };
    })()) as never);
  return { calls: () => n };
}

// -- list ---------------------------------------------------------------------

test("list: 2 ready + 1 draft → three status lines, exit 0", async () => {
  const root = project({ personas: [{ id: "ana" }, { id: "bob" }, { id: "cat", status: "draft" }] });
  const r = await run(root, ["list"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /persona ana: ready/);
  assert.match(r.out, /persona bob: ready/);
  assert.match(r.out, /persona cat: draft — skipped when conducting/);
  assert.match(r.out, /flow checkout: ok \(max 10 turns\)/);
});

test("list: a broken contract and a missing one are said loudly, still exit 0", async () => {
  const root = project({ personas: [{ id: "ana", status: "wat" }] });
  fs.mkdirSync(path.join(root, ".leopold", "persona", "personas", "ghost"));
  const r = await run(root, ["list"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /persona ana: ERROR — unknown contract_status "wat"/);
  assert.match(r.out, /persona ghost: no contract/);
});

test("list: no persona module → the nothing-to-run answer with the init pointer, exit 0", async () => {
  const r = await run(project(), ["list"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes(NOTHING_TO_RUN));
  assert.match(r.out, /leopold-persona/);
});

// -- run ----------------------------------------------------------------------

test("run: a flow that does not exist errors NAMING the path, non-zero", async () => {
  const root = project({ withModule: true, withFlow: false, personas: [{ id: "ana" }] });
  const r = await run(root, ["run", "checkout"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes(path.join(root, ".leopold", "persona", "flows", "checkout.md")));
});

test("run: no persona module → nothing-to-run on stderr, non-zero", async () => {
  const r = await run(project(), ["run", "checkout"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes(NOTHING_TO_RUN));
});

test("run: no flow argument is a usage error (2)", async () => {
  const r = await run(project({ withModule: true }), ["run"]);
  assert.equal(r.code, 2);
});

test("run: conducts through the stubbed seam end to end and prints the report path", async () => {
  const root = project({ personas: [{ id: "ana" }, { id: "cat", status: "draft" }] });
  const seam = stubSeam();
  const r = await run(root, ["run", "checkout"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(seam.calls() > 0, "conduction must reach the sdk.ts seam");
  assert.match(r.out, /Report: .*REPORT\.md/);
  assert.match(r.out, /- ana: blocked/);
  assert.match(r.out, /- cat: skipped/);
  const reportPath = /Report: (\S+)/.exec(r.out)![1];
  assert.ok(fs.existsSync(reportPath));
  // The journal header pins the flow's own App version pin (no env override).
  const journal = fs.readFileSync(path.join(path.dirname(reportPath), "ana", JOURNEY_FILE), "utf8");
  assert.match(journal, /"app_version":"build-42"/);
});

test("run: --provider codex resolves the codex harness, and conduction still goes through the one seam", async () => {
  // Provider resolution is index.ts-global; assert it the same way run's provider
  // tests do — the flag wins — then prove the persona run reaches the sdk.ts seam,
  // which is the ONLY place a harness (claude or codex) is chosen at call time.
  const env = { PATH: "/nonexistent", CLAUDE_HOME: "/tmp/leo-pcmd/.claude", CODEX_HOME: "/tmp/leo-pcmd/.codex" };
  fs.mkdirSync(env.CLAUDE_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  assert.equal(resolveProvider(["persona", "run", "checkout", "--provider", "codex"], env), "codex");

  const root = project({ personas: [{ id: "ana" }] });
  const seam = stubSeam();
  const r = await run(root, ["run", "checkout", "--provider", "codex"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(seam.calls() > 0);
});

test("run: unknown flag is a usage error, --persona/--parallel parse", async () => {
  assert.equal((await run(project({ withModule: true }), ["run", "checkout", "--wat"])).code, 2);
  assert.equal((await run(project({ withModule: true }), ["run", "checkout", "--parallel", "0"])).code, 2);
  const root = project({ personas: [{ id: "ana" }, { id: "bob" }] });
  stubSeam();
  const r = await run(root, ["run", "checkout", "--persona", "bob", "--parallel", "2"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /- bob: blocked/);
  assert.ok(!r.out.includes("- ana:"), "only the selected persona runs");
});

// -- report -------------------------------------------------------------------

function writeRunDir(root: string): string {
  const runDir = path.join(root, ".leopold", "persona", "runs", "20260818T120000Z-checkout");
  const ana = path.join(runDir, "ana");
  fs.mkdirSync(ana, { recursive: true });
  const turn = {
    schema_version: JOURNEY_SCHEMA,
    turn_id: "turn-1",
    persona_id: "ana",
    persona_response: "hm",
    observed_behavior: {
      intended_action: "read the pricing page",
      continuation_intent: "I give up, this makes no sense",
      friction_points: ["price is hidden"],
      comprehension: "confusing",
    },
    state_delta: { next_action: "none" },
  };
  fs.writeFileSync(
    path.join(ana, JOURNEY_FILE),
    `${headerLine({ journey_schema: JOURNEY_SCHEMA, flow: "checkout", persona: "ana", app_version: "build-42", started_at: "2026-08-18T12:00:00.000Z" })}\n${JSON.stringify(turn)}\n`,
  );
  return runDir;
}

test("report: re-synthesizes byte-identical outside the summary marker (summary preserved)", async () => {
  const root = project({ withModule: true });
  const runDir = writeRunDir(root);
  const first = await run(root, ["report", runDir]);
  assert.equal(first.code, 0);
  const reportPath = path.join(runDir, "REPORT.md");
  const fresh = fs.readFileSync(reportPath, "utf8");
  assert.ok(fresh.includes(SUMMARY_PLACEHOLDER));
  assert.match(fresh, /abandonment/);

  // A conductor spliced a real summary in; report must keep it and change nothing else.
  const withSummary = fresh.replace(SUMMARY_PLACEHOLDER, "Ana abandoned at turn 1. Fix the pricing page.");
  fs.writeFileSync(reportPath, withSummary);
  const second = await run(root, ["report", runDir]);
  assert.equal(second.code, 0);
  assert.equal(fs.readFileSync(reportPath, "utf8"), withSummary, "same journals, same bytes — summary preserved");
});

test("report: a missing run dir is a loud non-zero, a missing arg is usage", async () => {
  const root = project({ withModule: true });
  const r = await run(root, ["report", path.join(root, "no-such-run")]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no run directory/);
  assert.equal((await run(root, ["report"])).code, 2);
});

// -- dispatch and helpers -----------------------------------------------------

test("unknown subcommand and empty invocation are usage errors", async () => {
  assert.equal((await run(project(), ["wat"])).code, 2);
  assert.equal((await run(project(), [])).code, 2);
});

test("existingSummaryOf: placeholder and missing markers read as no summary", () => {
  assert.equal(existingSummaryOf("no markers here"), undefined);
  assert.equal(existingSummaryOf(`<!-- summary -->\n${SUMMARY_PLACEHOLDER}\n<!-- /summary -->`), undefined);
  assert.equal(existingSummaryOf("<!-- summary -->\nReal words.\n<!-- /summary -->"), "Real words.");
});

test("resolveAppVersion: env pin wins, flow pin is the fallback, unpinned is stated", () => {
  assert.equal(resolveAppVersion({ LEOPOLD_APP_VERSION: "sha-9" }, FLOW_TEXT), "sha-9");
  assert.equal(resolveAppVersion({}, FLOW_TEXT), "build-42");
  assert.equal(resolveAppVersion({}, undefined), "unpinned");
});
