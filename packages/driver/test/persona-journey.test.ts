// Unit tests for the persona journey journal core (persona-testing/journey.ts).
// Hermetic: every journal lives in a temp dir; nothing reads the real repo or ~/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JOURNEY_SCHEMA,
  RESEED_TAIL_TURNS,
  createJourney,
  appendTurn,
  readJourney,
  parseJourney,
  headerLine,
  lastState,
  reseedBlock,
  type JourneyHeader,
  type JourneyTurn,
} from "../src/persona-testing/journey.ts";
import { PAST_RUN_DATA_AUTHORITY } from "../src/recall.ts";

const HEADER: JourneyHeader = {
  journey_schema: JOURNEY_SCHEMA,
  flow: "checkout",
  persona: "ana-first-buy",
  app_version: "1.4.2",
  started_at: "2026-08-18T12:00:00Z",
};

function tmpJournal(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leopold-journey-"));
  return path.join(dir, "JOURNEY.jsonl");
}

function turn(n: number, extra: Record<string, unknown> = {}): JourneyTurn {
  return {
    schema_version: JOURNEY_SCHEMA,
    turn_id: `t${n}`,
    persona_id: "ana-first-buy",
    persona_response: `turn ${n} response`,
    state_delta: { newly_perceived: [`fact-${n}`], turn: n },
    ...extra,
  };
}

// @scenario append then read → the same turns back, byte-identical, header first
test("append then read returns the same turns back, header first", () => {
  const file = tmpJournal();
  assert.deepEqual(createJourney(file, HEADER), { status: "created" });
  const written = [turn(1), turn(2), turn(3)];
  for (const t of written) assert.deepEqual(appendTurn(file, t), { status: "appended" });

  const read = readJourney(file);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  assert.deepEqual(read.journey.header, HEADER);
  assert.deepEqual(read.journey.turns, written);
  assert.deepEqual(read.journey.warnings, []);
  // Header first, byte-identical to the one serializer's output.
  assert.equal(fs.readFileSync(file, "utf8").split("\n")[0], headerLine(HEADER));
});

test("createJourney refuses to overwrite an existing journal (append-only history)", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  appendTurn(file, turn(1));
  const before = fs.readFileSync(file, "utf8");
  const again = createJourney(file, HEADER);
  assert.equal(again.status, "exists");
  assert.equal(fs.readFileSync(file, "utf8"), before); // not a byte touched
});

test("appendTurn rejects an invalid turn loudly, before any bytes land", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  const before = fs.readFileSync(file, "utf8");
  const noDelta = { schema_version: JOURNEY_SCHEMA, turn_id: "t1", persona_id: "p" } as unknown as JourneyTurn;
  const res = appendTurn(file, noDelta);
  assert.equal(res.status, "rejected");
  if (res.status === "rejected") assert.match(res.reason, /state_delta/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  // And it never invents the file: appending to a headerless path is rejected too.
  const orphan = tmpJournal();
  assert.equal(appendTurn(orphan, turn(1)).status, "rejected");
  assert.equal(fs.existsSync(orphan), false);
});

// @scenario a malformed middle line → typed warning, every other turn still parsed
test("a malformed middle line becomes a typed warning; every other turn still parses", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  appendTurn(file, turn(1));
  fs.appendFileSync(file, "{ this is not JSON\n");
  appendTurn(file, turn(2));
  fs.appendFileSync(file, JSON.stringify({ schema_version: "other/9.9", turn_id: "x", persona_id: "p", state_delta: {} }) + "\n");
  appendTurn(file, turn(3));

  const read = readJourney(file);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  assert.deepEqual(read.journey.turns.map((t) => t.turn_id), ["t1", "t2", "t3"]);
  assert.deepEqual(read.journey.warnings, [
    { line: 3, reason: "not valid JSON" },
    { line: 5, reason: `turn schema_version is not "${JOURNEY_SCHEMA}"` },
  ]);
});

test("a missing file and a bad header are typed statuses, never throws", () => {
  assert.equal(readJourney(path.join(os.tmpdir(), "leopold-journey-nope", "JOURNEY.jsonl")).status, "missing");
  assert.equal(parseJourney("").status, "empty");
  assert.equal(parseJourney("not json\n").status, "bad_header");
  const wrongSchema = parseJourney(JSON.stringify({ ...HEADER, journey_schema: "v2" }) + "\n");
  assert.equal(wrongSchema.status, "bad_header");
});

// @scenario reseedBlock() on a 30-turn journey → header + bounded tail + last
// state_delta, framing sentence exactly once, verbatim from its constant
test("reseedBlock on a 30-turn journey: bounded tail, chained state, framing exactly once", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  for (let n = 1; n <= 30; n++) appendTurn(file, turn(n));
  const read = readJourney(file);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;

  const block = reseedBlock(read.journey);
  // The framing sentence: verbatim from its one home, exactly once.
  assert.equal(block.split(PAST_RUN_DATA_AUTHORITY).length - 1, 1);
  assert.ok(block.startsWith(PAST_RUN_DATA_AUTHORITY));
  // Header present, canonical bytes.
  assert.ok(block.includes(headerLine(HEADER)));
  // Bounded tail: the last RESEED_TAIL_TURNS turns and none before them.
  assert.ok(block.includes(`turns ${31 - RESEED_TAIL_TURNS}..30 of 30:`));
  assert.ok(block.includes('"turn_id":"t30"'));
  assert.ok(block.includes(`"turn_id":"t${31 - RESEED_TAIL_TURNS}"`));
  assert.ok(!block.includes(`"turn_id":"t${30 - RESEED_TAIL_TURNS}"`));
  // The last state_delta, chained as the next PRIOR_STATE.
  assert.ok(block.includes("PRIOR_STATE (from turn t30):"));
  assert.ok(block.includes(JSON.stringify({ newly_perceived: ["fact-30"], turn: 30 })));
});

test("reseedBlock on a header-only journey names the absence instead of inventing state", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  const read = readJourney(file);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  const block = reseedBlock(read.journey);
  assert.equal(block.split(PAST_RUN_DATA_AUTHORITY).length - 1, 1);
  assert.ok(block.includes("turns: none enacted yet"));
  assert.ok(block.includes("PRIOR_STATE: none"));
});

// @scenario lastState() on an empty journey (header only) → typed "no turns yet"
test("lastState on a header-only journey is a typed no_turns, never undefined", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  const read = readJourney(file);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  const state = lastState(read.journey);
  assert.equal(state.status, "no_turns");
  if (state.status === "no_turns") assert.match(state.reason, /no enacted turns/);
});

test("lastState returns the tail turn's state_delta, chained as the next PRIOR_STATE", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  appendTurn(file, turn(1));
  appendTurn(file, turn(2));
  const read = readJourney(file);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  const state = lastState(read.journey);
  assert.deepEqual(state, { status: "ok", turn_id: "t2", state: { newly_perceived: ["fact-2"], turn: 2 } });
});

// @scenario two reads of the same file → byte-identical results (no wall-clock)
test("two reads of the same file are byte-identical — parse and reseed carry no wall-clock", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  for (let n = 1; n <= 7; n++) appendTurn(file, turn(n));
  const a = readJourney(file);
  const b = readJourney(file);
  assert.deepEqual(a, b);
  assert.equal(a.status, "ok");
  if (a.status !== "ok" || b.status !== "ok") return;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(reseedBlock(a.journey), reseedBlock(b.journey));
});

// Write → read → reseed with zero loss: the round trip the plan item names done on.
test("a journey survives write → read → reseed with zero loss", () => {
  const file = tmpJournal();
  createJourney(file, HEADER);
  const written = Array.from({ length: 12 }, (_, i) => turn(i + 1));
  for (const t of written) appendTurn(file, t);
  const read = readJourney(file);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  assert.deepEqual(read.journey.turns, written); // nothing lost, nothing repeated
  const state = lastState(read.journey);
  assert.equal(state.status, "ok");
  if (state.status !== "ok") return;
  // The reseed block carries exactly the state the next turn chains from.
  assert.ok(reseedBlock(read.journey).includes(JSON.stringify(state.state)));
});
