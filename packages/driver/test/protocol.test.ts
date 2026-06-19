// Tests for the worker STATUS parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, isTurnComplete } from "../src/protocol.ts";

test("parses a fenced leopold-status block", () => {
  const s = parseStatus(
    "noise\n```leopold-status\nSTATUS: done\nITEM: build X\nSUMMARY: shipped\nNEXT: item Y\nEVIDENCE: tests green\n```\ntrailing",
  );
  assert.ok(s);
  assert.equal(s!.kind, "done");
  assert.equal(s!.item, "build X");
  assert.equal(s!.summary, "shipped");
  assert.equal(s!.next, "item Y");
  assert.equal(s!.evidence, "tests green");
});

test("keeps the LAST status block when several are present", () => {
  const s = parseStatus("```leopold-status\nSTATUS: working\n```\n```leopold-status\nSTATUS: blocked\nSUMMARY: stuck\n```");
  assert.equal(s!.kind, "blocked");
  assert.equal(s!.summary, "stuck");
});

test("falls back to a bare STATUS: line", () => {
  const s = parseStatus("STATUS: needs-decision\nDECISION-NEEDED: A or B?");
  assert.equal(s!.kind, "needs-decision");
  assert.equal(s!.decisionNeeded, "A or B?");
});

test("unknown STATUS value defaults to working", () => {
  assert.equal(parseStatus("STATUS: frobnicate")!.kind, "working");
});

test("STATUS matching is case-insensitive and prefix-based", () => {
  assert.equal(parseStatus("status: DONE - all good")!.kind, "done");
});

test("returns null when there is no status marker", () => {
  assert.equal(parseStatus("just some text, no marker"), null);
});

test("isTurnComplete is true only for terminal kinds", () => {
  assert.equal(isTurnComplete(parseStatus("STATUS: done")), true);
  assert.equal(isTurnComplete(parseStatus("STATUS: needs-decision")), true);
  assert.equal(isTurnComplete(parseStatus("STATUS: working")), false);
  assert.equal(isTurnComplete(null), false);
});
