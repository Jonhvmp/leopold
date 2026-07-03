// Unit tests for the root-cause panel's pure helpers (parsing + lead formatting).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHypothesis, parseRefutation, formatLead } from "../src/hypotheses.ts";

test("a well-formed hypothesis parses with its angle", () => {
  const h = parseHypothesis('{"theory":"the test imports the old path","evidence":"grep shows 3 stale imports","fix":"update the imports"}', "assumptions");
  assert.ok(h);
  assert.equal(h.angle, "assumptions");
  assert.equal(h.theory, "the test imports the old path");
});

test("fenced JSON and surrounding prose are tolerated", () => {
  const h = parseHypothesis('My verdict:\n```json\n{"theory":"race in setup","evidence":"log order","fix":"await the init"}\n```', "verify");
  assert.ok(h);
  assert.equal(h.fix, "await the init");
});

test("a hypothesis without a theory is rejected", () => {
  assert.equal(parseHypothesis('{"evidence":"stuff","fix":"stuff"}', "diff"), null);
  assert.equal(parseHypothesis("no json at all", "diff"), null);
  assert.equal(parseHypothesis('{"theory":"   "}', "diff"), null);
});

test("refutation parses and clamps confidence to 0-10", () => {
  const r = parseRefutation('{"refuted":false,"confidence":37,"why":"holds up"}');
  assert.equal(r.refuted, false);
  assert.equal(r.confidence, 10);
});

test("an ambiguous or unparseable refutation fails CLOSED (refuted)", () => {
  assert.equal(parseRefutation("the model rambled").refuted, true);
  assert.equal(parseRefutation('{"confidence":9,"why":"missing refuted field"}').refuted, true);
  assert.equal(parseRefutation('{"refuted":"maybe","confidence":5}').refuted, true);
});

test("formatLead renders the survivor and is absent when none survived", () => {
  assert.equal(formatLead({ considered: 3, survived: 0 }), undefined);
  const lead = formatLead({
    considered: 3, survived: 1,
    survivor: { angle: "verify", theory: "flag is off", evidence: "config read", fix: "enable it", confidence: 8 },
  });
  assert.ok(lead);
  assert.match(lead, /confidence 8\/10/);
  assert.match(lead, /THEORY: flag is off/);
  assert.match(lead, /START WITH THIS FIX: enable it/);
});
