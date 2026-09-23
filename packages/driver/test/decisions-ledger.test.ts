// The calibration ledger, and the pass that reads it.
//
// The bars in `.leopold/decisions/*.json` are PRIORS: item 1 could not fit them, because this
// project had one archived run and no event log. This is how they stop being priors — and the
// property that matters most is the one that keeps it honest: below a real sample the pass says
// the sample is too small instead of producing a number, and it NEVER writes a catalog.
//
// MUTATION-VERIFIED: drop the MIN_SAMPLE guard and the small-sample case fails; make
// proposeThresholds pick the lowest certainty rather than the lowest SAFE one and the fitting case
// fails; have appendRow rewrite instead of append and the append-only case fails.
//
// HERMETIC: a mkdtemp project. No network, no key.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendRow, ledgerPath, MIN_SAMPLE, proposeThresholds, readLedger,
  type DecisionRow, type LedgerRow,
} from "../src/decisions/index.ts";

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-ledger-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(leoDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return leoDir;
}

const decision = (id: string, certainty: number): DecisionRow => ({
  kind: "decision", id, ts: "2026-09-21T00:00:00Z", consumer: "routing", question: "effort",
  provider: "jev", model: "jev-1.13.0", confidence: certainty, certainty,
  band: certainty >= 0.85 ? "act" : "escalate", acted: certainty >= 0.85,
});

test("a project that never used the module has no ledger", (t) => {
  const leoDir = project(t);
  assert.deepEqual(readLedger(leoDir), []);
  assert.equal(fs.existsSync(ledgerPath(leoDir)), false, "reading must not create the file");
});

test("the ledger is append-only, and a decision keeps its original row when the outcome lands", (t) => {
  const leoDir = project(t);
  appendRow(leoDir, decision("d1", 0.9));
  appendRow(leoDir, { kind: "outcome", id: "d1", ts: "2026-09-21T01:00:00Z", correct: false, note: "review blocked" });
  const rows = readLedger(leoDir);
  assert.equal(rows.length, 2, "the outcome must be a SECOND row, not an edit of the first");
  assert.equal(rows[0].kind, "decision");
  assert.equal((rows[0] as DecisionRow).certainty, 0.9, "the decision row was rewritten");
  assert.equal(rows[1].kind, "outcome");
});

test("a torn final line does not make the corpus unreadable", (t) => {
  const leoDir = project(t);
  appendRow(leoDir, decision("d1", 0.9));
  fs.appendFileSync(ledgerPath(leoDir), '{"kind":"outcome","id":"d1"');
  assert.equal(readLedger(leoDir).length, 1, "a crash mid-append must cost one row, not the corpus");
});

test("below the sample floor the pass says so instead of fitting a number", () => {
  const rows: LedgerRow[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push(decision(`d${i}`, 0.9));
    rows.push({ kind: "outcome", id: `d${i}`, ts: "t", correct: true });
  }
  const [p] = proposeThresholds(rows);
  assert.equal(p.act, null, "a bar was fitted on 5 samples");
  assert.match(p.reason, new RegExp(`only 5 .*${MIN_SAMPLE} is the floor`));
});

test("with a real sample it proposes the WEAKEST bar the evidence supports", () => {
  const rows: LedgerRow[] = [];
  // Everything at or above 0.80 was correct; below it, mixed. The honest bar is 0.80 — not 0.99
  // (too strong for the evidence) and not the lowest certainty seen (contradicted by outcomes).
  let n = 0;
  const add = (certainty: number, correct: boolean) => {
    const id = `d${n++}`;
    rows.push(decision(id, certainty));
    rows.push({ kind: "outcome", id, ts: "t", correct });
  };
  for (let i = 0; i < 12; i++) add(0.95, true);
  for (let i = 0; i < 10; i++) add(0.8, true);
  for (let i = 0; i < 6; i++) add(0.7, false);
  for (let i = 0; i < 6; i++) add(0.6, true);
  const [p] = proposeThresholds(rows);
  assert.equal(p.samples, 34);
  assert.equal(p.act, 0.8, `expected the lowest safe bar, got ${p.act}`);
  assert.match(p.reason, /every one of the 22 decisions at or above 0.8 was correct/);
});

test("a question no certainty can save is reported as such, not given a bar", () => {
  const rows: LedgerRow[] = [];
  for (let i = 0; i < MIN_SAMPLE + 2; i++) {
    rows.push(decision(`d${i}`, 0.99));
    rows.push({ kind: "outcome", id: `d${i}`, ts: "t", correct: i % 3 !== 0 });
  }
  const [p] = proposeThresholds(rows);
  assert.equal(p.act, null);
  assert.match(p.reason, /may not be answerable by this provider/);
});

test("proposals are per provider per question — bars never pool across them", () => {
  const rows: LedgerRow[] = [];
  let n = 0;
  const add = (provider: string, question: string) => {
    const id = `d${n++}`;
    rows.push({ ...decision(id, 0.9), provider, question });
    rows.push({ kind: "outcome", id, ts: "t", correct: true });
  };
  for (let i = 0; i < 3; i++) { add("jev", "effort"); add("openrouter", "effort"); add("jev", "critical"); }
  const keys = proposeThresholds(rows).map((p) => `${p.provider}/${p.question}`).sort();
  assert.deepEqual(keys, ["jev/critical", "jev/effort", "openrouter/effort"]);
});

test("the pass writes nothing at all", (t) => {
  const leoDir = project(t);
  const cat = path.join(leoDir, "decisions", "routing.json");
  fs.mkdirSync(path.dirname(cat), { recursive: true });
  const before = '{"version":"decisions/1.0","questions":{},"thresholds":{}}';
  fs.writeFileSync(cat, before);
  appendRow(leoDir, decision("d1", 0.9));
  appendRow(leoDir, { kind: "outcome", id: "d1", ts: "t", correct: true });
  proposeThresholds(readLedger(leoDir));
  assert.equal(fs.readFileSync(cat, "utf8"), before, "proposeThresholds edited a catalog");
});
