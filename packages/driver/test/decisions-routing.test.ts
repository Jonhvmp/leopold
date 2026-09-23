// The keystone consumer: item routing refined by a provider, with the regex as the floor.
//
// The last two cases are the reason the module exists. They are not invented: item 1's spike ran
// `classifyItem()` over this project's own 17 archived plan items and found three misreads, all
// of the same kind — a word appearing where it did not mean what it looked like. Those exact items
// are the fixtures here, and the test asserts the provider fixes what the regex got wrong WITHOUT
// the regex's correct verdicts moving.
//
// MUTATION-VERIFIED: return the provider's effort without checking the band and the below-floor
// case fails; use `act` instead of `act_lower` for a downgrade and the asymmetry case fails; let
// `cosmetic` fire while `critical` is true and the last case fails.
//
// HERMETIC: a mkdtemp project holding the shipped catalog template, and a stub provider. No
// network, no key, no repo probing (the probe is injected).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyItem } from "../src/classify.ts";
import {
  gatherEvidence,
  namedPaths,
  proposeThresholds,
  readLedger,
  recordOutcome,
  routeWithDecisions,
  type Provider,
  type ProviderDescriptor,
  type Result,
} from "../src/decisions/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMPLATE = path.join(REPO, "templates", "decisions", "routing.json");

const descriptor: ProviderDescriptor = {
  name: "stub",
  endpoint: "http://127.0.0.1:1/v1/systemone",
  model: "stub-1.0.0",
  calibrated: true,
  calibration_source: "trained",
  auth_env: "STUB_KEY",
  timeout_ms: 1000,
  max_options: 255,
  max_state_tokens: 32000,
};

/** A provider that answers exactly what a case needs, so the composition is what is under test. */
function stub(answers: {
  effort?: [string, number];
  irreversible?: number;
  cosmetic?: number;
}): Provider {
  return {
    descriptor,
    async ask(req) {
      const out: Record<string, Result> = {};
      for (const q of req.questions) {
        if (q === "effort" && answers.effort) {
          const [choice, confidence] = answers.effort;
          out[q] = {
            ok: true,
            type: "choice",
            choice,
            probabilities: { [choice]: confidence },
            confidence,
            provider: "stub",
            model: "stub-1.0.0",
          };
        } else if (q === "irreversible" && answers.irreversible !== undefined) {
          out[q] = { ok: true, type: "noul", noul: answers.irreversible, confidence: null, provider: "stub", model: "stub-1.0.0" };
        } else if (q === "cosmetic" && answers.cosmetic !== undefined) {
          out[q] = { ok: true, type: "noul", noul: answers.cosmetic, confidence: null, provider: "stub", model: "stub-1.0.0" };
        } else {
          out[q] = { ok: false, reason: "no_provider", provider: "stub" };
        }
      }
      return out;
    },
  };
}

function project(t: TestContext, withCatalog = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-routing-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(path.join(leoDir, "decisions"), { recursive: true });
  if (withCatalog) fs.copyFileSync(TEMPLATE, path.join(leoDir, "decisions", "routing.json"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return leoDir;
}

const route = (leoDir: string, item: string, provider?: Provider, charter = "") =>
  routeWithDecisions({ item, charter, repoRoot: REPO, leoDir, provider, files: [] });

// ---- scenario 1 --------------------------------------------------------------------------

test("scenario: with no provider the verdict is classifyItem's, field for field", async (t) => {
  const leoDir = project(t);
  for (const item of [
    "add a retry helper to the worker",
    "run the schema migration for the billing table",
    "fix a typo in the README",
  ]) {
    assert.deepEqual(await route(leoDir, item), classifyItem(item, ""), `"${item}" diverged without a provider`);
  }
});

test("a missing catalog is also exactly the deterministic verdict", async (t) => {
  const leoDir = project(t, false);
  const item = "rework the auth session store";
  assert.deepEqual(await route(leoDir, item, stub({ effort: ["low", 1] })), classifyItem(item, ""));
});

// ---- scenario 2 --------------------------------------------------------------------------

test("scenario: an answer below the floor leaves the regex verdict standing", async (t) => {
  const leoDir = project(t);
  const item = "update the retry helper";
  const base = classifyItem(item, "");
  const got = await route(leoDir, item, stub({ effort: ["max", 0.2], irreversible: 0.52, cosmetic: 0.51 }));
  assert.deepEqual(got, base, "a low-confidence provider moved the verdict");
  assert.equal(got.reason, base.reason, "the reason must still name the deterministic path");
});

// ---- scenario 3 --------------------------------------------------------------------------

test("scenario: a confident answer sets effort and criticality, and says who decided", async (t) => {
  const leoDir = project(t);
  const item = "update the retry helper";
  const base = classifyItem(item, "");
  assert.equal(base.effort, "medium");
  assert.equal(base.critical, false);

  const got = await routeWithDecisions({
    item,
    repoRoot: REPO,
    leoDir,
    provider: stub({ effort: ["high", 0.95], irreversible: 0.97 }),
    files: ["packages/driver/src/loop.ts"],
    probe: { references: () => 42 },
  });
  assert.equal(got.effort, "high");
  assert.equal(got.critical, true);
  assert.match(got.reason, /stub\/stub-1\.0\.0/);
  assert.match(got.reason, /effort medium->high/);
  assert.match(got.reason, /was: default: ordinary change/);
  assert.deepEqual(got.files, ["packages/driver/src/loop.ts"], "the evidence code gathered travels with the verdict");
});

test("the bars are asymmetric: the same confidence raises but does not lower", async (t) => {
  const leoDir = project(t);
  const item = "update the retry helper"; // medium by keyword
  // 0.70 clears act_raise (0.65) and misses act_lower (0.85).
  const up = await route(leoDir, item, stub({ effort: ["high", 0.7] }));
  const down = await route(leoDir, item, stub({ effort: ["low", 0.7] }));
  assert.equal(up.effort, "high", "0.70 should clear the raise bar");
  assert.equal(down.effort, "medium", "0.70 must NOT clear the lower bar");
  assert.equal(down.reason, classifyItem(item, "").reason);
});

// ---- scenario 4: the failures item 1 measured on this project's own history ----------------

test("scenario: an item the regex calls critical by wording alone is routed down when the provider is sure", async (t) => {
  const leoDir = project(t);
  const item = "explain how the auth module works in the architecture doc";
  const base = classifyItem(item, "");
  assert.equal(base.critical, true, "the regex still reads this as critical (the premise of the case)");

  const got = await route(leoDir, item, stub({ effort: ["low", 0.95], irreversible: 0.02, cosmetic: 0.97 }));
  assert.equal(got.critical, false, "a confident provider cleared a keyword-only criticality");
  assert.equal(got.effort, "low");
  assert.match(got.reason, /critical true->false/);
  assert.match(got.reason, /was: critical: matches risk keyword/, "both verdicts are on the record");
});

test("a `docs/` path cited by a behavioural item no longer makes it cosmetic", async (t) => {
  const leoDir = project(t);
  // Item 4 of the previous mission, verbatim in shape: it builds the doctor's capability matrix
  // and a test suite, and merely CITES a docs path. The regex called it "trivial: cosmetic".
  const item =
    "`leopold doctor` prints the capability matrix joined with the live wiring, citing docs/reference/hook-events.md, and a new scripts/test-doctor-matrix.sh asserts all four statuses";
  const base = classifyItem(item, "");
  assert.equal(base.effort, "low");
  assert.equal(base.reason, "trivial: cosmetic / low blast radius", "the measured misread is still the premise");

  const got = await route(leoDir, item, stub({ effort: ["high", 0.93], irreversible: 0.05, cosmetic: 0.03 }));
  assert.equal(got.effort, "high", "the provider should have overridden a false cosmetic");
  assert.match(got.reason, /effort low->high/);
});

test("cosmetic can never talk its way past a criticality signal", async (t) => {
  const leoDir = project(t);
  const item = "run the schema migration for the billing table";
  // A provider that is very sure this is cosmetic AND very sure it is irreversible. The
  // irreversible answer wins: `cosmetic` may only lower, and only when nothing is critical.
  const got = await route(leoDir, item, stub({ cosmetic: 0.99, irreversible: 0.99 }));
  assert.equal(got.critical, true);
  assert.notEqual(got.effort, "low", "a cosmetic claim must not downgrade a critical item");
});

// ---- evidence is gathered, never guessed ---------------------------------------------------

test("only paths that exist on disk enter the evidence", () => {
  const item = "edit `packages/driver/src/classify.ts` and also src/does-not-exist.ts and /etc/passwd";
  const found = namedPaths(item, REPO);
  assert.deepEqual(found, ["packages/driver/src/classify.ts"]);
});

test("the evidence carries counts from code and a bounded charter", () => {
  const ev = gatherEvidence("touch `packages/driver/src/classify.ts`", {
    repoRoot: REPO,
    charter: "x".repeat(5000),
    probe: { references: () => 7 },
  });
  assert.deepEqual(ev.files, ["packages/driver/src/classify.ts"]);
  assert.equal(ev.references["packages/driver/src/classify.ts"], 7);
  assert.equal(ev.charter_excerpt.length, 2000, "a large state costs accuracy; the charter is bounded");
});

test("a usable answer leaves a decision row in the ledger — a ledger with no writer is a format", async (t) => {
  const leoDir = project(t);
  await routeWithDecisions({
    item: "update the retry helper",
    repoRoot: REPO,
    leoDir,
    provider: stub({ effort: ["high", 0.95], irreversible: 0.97, cosmetic: 0.02 }),
    files: [],
    now: () => new Date("2026-09-21T12:00:00Z"),
    idFor: (q) => `fixed-${q}`,
  });
  const rows = readLedger(leoDir).filter((r) => r.kind === "decision");
  assert.equal(rows.length, 3, "one row per usable answer");
  const effort = rows.find((r) => r.question === "effort")!;
  assert.equal(effort.consumer, "routing");
  assert.equal(effort.model, "stub-1.0.0");
  assert.equal(effort.band, "act");
  assert.equal(effort.acted, true);
  assert.equal(effort.certainty, 0.95);
  assert.equal(effort.id, "fixed-effort");
  // The outcome is a SECOND row, and until something writes it the corpus proposes nothing.
  assert.deepEqual(
    proposeThresholds(readLedger(leoDir)),
    [],
    "decisions with no outcomes must yield no proposals at all",
  );
  recordOutcome(leoDir, "fixed-effort", false, "review blocked");
  const outcomes = readLedger(leoDir).filter((r) => r.kind === "outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(readLedger(leoDir).filter((r) => r.kind === "decision").length, 3, "the decision rows were rewritten");
});

test("a ledger that cannot be written never costs a routing decision", async (t) => {
  const leoDir = project(t);
  // A file where the ledger's directory must go: every write will throw.
  fs.rmSync(path.join(leoDir, "decisions"), { recursive: true, force: true });
  fs.writeFileSync(path.join(leoDir, "decisions"), "not a directory");
  const got = await routeWithDecisions({
    item: "update the retry helper",
    repoRoot: REPO,
    leoDir,
    provider: stub({ effort: ["high", 0.95] }),
    files: [],
  });
  // No catalog can be loaded either, so this is the deterministic verdict — the point is that it
  // RETURNED one instead of throwing.
  assert.equal(got.effort, classifyItem("update the retry helper", "").effort);
});

test("ledger writing can be turned off for a caller that must not touch disk", async (t) => {
  const leoDir = project(t);
  await routeWithDecisions({
    item: "update the retry helper",
    repoRoot: REPO,
    leoDir,
    provider: stub({ effort: ["high", 0.95] }),
    files: [],
    ledger: false,
  });
  assert.equal(readLedger(leoDir).length, 0);
});
