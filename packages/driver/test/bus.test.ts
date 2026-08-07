// The state channel (.leopold/bus.json): contract enforcement, durability across a
// process boundary and a crash, tolerance of a corrupt file, and concurrent writers.
// Every test runs in its own temp .leopold dir — nothing touches a real project.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import {
  busPath, readBus, readSignals, getSignal, emitSignal, emitSignals, recordDecision,
  clearSignal, resetBus, assertValidKey, normalizeValue, BusContractError,
  BUS_VERSION, MAX_VALUE_LEN, MAX_SIGNALS, MAX_NOTE_LEN, MAX_BUS_BYTES,
} from "../src/bus.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const busModule = path.join(here, "..", "src", "bus.ts");
const tmpLeo = () => fs.mkdtempSync(path.join(os.tmpdir(), "leo-bus-"));

/** Run `fn`, assert it threw, and hand the error back for inspection. */
function thrown(fn: () => unknown): BusContractError {
  try {
    fn();
  } catch (e) {
    return e as BusContractError;
  }
  throw new assert.AssertionError({ message: "expected a BusContractError, nothing was thrown" });
}

/** Run a snippet against the real module in a FRESH node process — the only honest way
 *  to prove a signal outlived the process that emitted it. */
function inFreshProcess(code: string): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `import * as bus from ${JSON.stringify(busModule)};\n${code}`],
    { encoding: "utf8", cwd: path.join(here, ".."), stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

test("a missing channel reads as empty, and never throws", () => {
  const leo = tmpLeo();
  assert.deepEqual(readBus(leo), { version: BUS_VERSION, signals: {}, decisions: [] });
  assert.deepEqual(readSignals(leo), {});
  assert.equal(getSignal(leo, "migrated"), undefined);
});

test("a signal emitted in one process is read by a fresh one", () => {
  const leo = tmpLeo();
  emitSignal(leo, "migrated", true, { by: 3 });
  const seen = inFreshProcess(
    `const s = bus.readBus(${JSON.stringify(leo)}).signals.migrated; process.stdout.write(s.value + "|" + s.by);`,
  );
  assert.equal(seen, "true|3", "a fresh process must see what the previous one decided");
  // and it is still there for this process too
  assert.equal(getSignal(leo, "migrated"), "true");
});

test("values are normalized to single-line strings, and the reader gets a flat map", () => {
  const leo = tmpLeo();
  emitSignal(leo, "migrated", false);
  emitSignal(leo, "retries", 2);
  emitSignal(leo, "owner", "ops");
  assert.deepEqual(readSignals(leo), { migrated: "false", retries: "2", owner: "ops" });
});

test("emitSignals writes several signals in one shot, and re-emitting overwrites", () => {
  const leo = tmpLeo();
  emitSignals(leo, { migrated: true, verified: false }, { by: 7 });
  assert.deepEqual(readSignals(leo), { migrated: "true", verified: "false" });
  emitSignal(leo, "verified", true);
  assert.deepEqual(readSignals(leo), { migrated: "true", verified: "true" });
  assert.equal(readBus(leo).signals.migrated.by, 7);
});

test("clearSignal drops a decision that no longer holds; resetBus empties the channel", () => {
  const leo = tmpLeo();
  emitSignals(leo, { migrated: true, verified: true });
  assert.equal(clearSignal(leo, "verified"), true);
  assert.equal(clearSignal(leo, "verified"), false);
  assert.deepEqual(readSignals(leo), { migrated: "true" });
  resetBus(leo);
  assert.deepEqual(readSignals(leo), {});
});

test("decisions are appended to the trail, notes are bounded", () => {
  const leo = tmpLeo();
  recordDecision(leo, "took @on fail -> 7", { by: 3 });
  recordDecision(leo, "skipped item 8: verified=true");
  const trail = readBus(leo).decisions;
  assert.equal(trail.length, 2);
  assert.equal(trail[0].note, "took @on fail -> 7");
  assert.equal(trail[0].by, 3);
  assert.throws(() => recordDecision(leo, "x".repeat(MAX_NOTE_LEN + 1)), (e: Error) => e.name === "BusContractError");
  assert.throws(() => recordDecision(leo, "  "), BusContractError);
  assert.equal(readBus(leo).decisions.length, 2, "a rejected decision must not land");
});

// ---- the contract, enforced in code ----------------------------------------------

test("a value over the ceiling is rejected with a named error, and nothing is written", () => {
  const leo = tmpLeo();
  emitSignal(leo, "migrated", true);
  const payload = "x".repeat(MAX_VALUE_LEN + 1);
  const err = thrown(() => emitSignal(leo, "diff", payload));
  assert.equal(err.name, "BusContractError");
  assert.ok(err instanceof BusContractError);
  assert.equal(err.key, "diff", "the error must name the offending key");
  assert.match(err.message, /value ceiling/);
  assert.deepEqual(readSignals(leo), { migrated: "true" }, "work product must not reach the channel");
  assert.ok(!fs.readFileSync(busPath(leo), "utf8").includes(payload));
});

test("a structure, a multi-line string and a missing value are all rejected", () => {
  const leo = tmpLeo();
  for (const bad of [{ patch: "…" }, ["a"], null, undefined]) {
    assert.throws(() => emitSignal(leo, "work", bad), BusContractError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => emitSignal(leo, "work", "line one\nline two"), (e: BusContractError) => {
    assert.equal(e.key, "work");
    assert.match(e.message, /newline or control character/);
    return true;
  });
  assert.deepEqual(readSignals(leo), {});
});

test("a key that is a payload rather than a name is rejected, naming it", () => {
  const leo = tmpLeo();
  for (const bad of ["", "9lives", "has space", "a".repeat(65), "sig/nal!"]) {
    assert.throws(() => emitSignal(leo, bad, "true"), BusContractError, `should reject key ${JSON.stringify(bad)}`);
  }
  for (const ok of ["migrated", "db.migrated", "roll-back_ok", "A1"]) assertValidKey(ok);
  assert.equal(normalizeValue("k", 42), "42");
});

test("the signal-count ceiling holds, and an all-or-nothing batch does not half-land", () => {
  const leo = tmpLeo();
  const many: Record<string, unknown> = {};
  for (let i = 0; i < MAX_SIGNALS; i++) many[`k${i}`] = true;
  emitSignals(leo, many);
  assert.equal(Object.keys(readSignals(leo)).length, MAX_SIGNALS);
  const err = thrown(() => emitSignal(leo, "overflow", true));
  assert.equal(err.key, "overflow");
  assert.equal(Object.keys(readSignals(leo)).length, MAX_SIGNALS);
  // one bad member rejects the whole batch
  assert.throws(() => emitSignals(tmpLeo(), { good: true, bad: { nested: 1 } }), BusContractError);
});

// ---- tolerance --------------------------------------------------------------------

test("a corrupt channel reads empty, logs the corruption, and the run continues", () => {
  const leo = tmpLeo();
  fs.writeFileSync(busPath(leo), '{"signals": {"migrated": {"value": "tr');
  assert.deepEqual(readSignals(leo), {}, "a corrupt file must not throw");
  const events = fs.readFileSync(path.join(leo, "events.jsonl"), "utf8");
  assert.match(events, /"event":"bus_corrupt"/);
  // ...and the next write quarantines it instead of pretending it never existed
  emitSignal(leo, "migrated", true);
  assert.deepEqual(readSignals(leo), { migrated: "true" });
  const aside = fs.readdirSync(leo).filter((f) => f.startsWith("bus.json.corrupt-"));
  assert.equal(aside.length, 1, "the unreadable file is kept for inspection");
});

test("entries on disk that break the contract are dropped, not trusted", () => {
  const leo = tmpLeo();
  fs.writeFileSync(busPath(leo), JSON.stringify({
    version: 1,
    signals: {
      migrated: { value: "true", by: 3, at: "2026-01-01T00:00:00.000Z" },
      shorthand: "yes",                              // hand-edited flat form: tolerated
      "bad key": { value: "true" },                  // not a name
      smuggled: { value: "x".repeat(5000) },         // work product
      structured: { value: { patch: "…" } },         // a structure
    },
    decisions: [{ at: "2026-01-01T00:00:00.000Z", note: "kept" }, { note: "" }, 42],
  }));
  const bus = readBus(leo);
  assert.deepEqual(Object.keys(bus.signals).sort(), ["migrated", "shorthand"]);
  assert.equal(bus.signals.shorthand.value, "yes");
  assert.deepEqual(bus.decisions.map((d) => d.note), ["kept"]);
  assert.match(fs.readFileSync(path.join(leo, "events.jsonl"), "utf8"), /bus_corrupt/);
});

test("a non-object channel file reads empty rather than crashing", () => {
  for (const junk of ["[1,2,3]", '"a string"', "null", ""]) {
    const leo = tmpLeo();
    fs.writeFileSync(busPath(leo), junk);
    assert.deepEqual(readSignals(leo), {}, `junk: ${junk}`);
  }
});

// ---- durability -------------------------------------------------------------------

test("two concurrent processes each emitting a signal both survive", () => {
  const leo = tmpLeo();
  emitSignal(leo, "start", true);
  const writers = ["a", "b", "c", "d"].map((tag) =>
    spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `import * as bus from ${JSON.stringify(busModule)};
       for (let i = 0; i < 5; i++) bus.emitSignal(${JSON.stringify(leo)}, "${tag}" + i, "true", { by: 1 });`,
    ], { cwd: path.join(here, ".."), stdio: "ignore" }),
  );
  return Promise.all(writers.map((c) => new Promise<void>((res, rej) => {
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`writer exited ${code}`))));
  }))).then(() => {
    const signals = readSignals(leo);
    assert.equal(signals.start, "true", "the pre-existing signal survived");
    for (const tag of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 5; i++) assert.equal(signals[`${tag}${i}`], "true", `${tag}${i} was clobbered`);
    }
  });
});

test("a writer killed mid-run leaves the channel whole (atomic rename)", async () => {
  const leo = tmpLeo();
  emitSignal(leo, "before", true);
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import * as bus from ${JSON.stringify(busModule)};
     process.stdout.write("go\\n");
     for (let i = 0; i < 10000; i++) bus.emitSignal(${JSON.stringify(leo)}, "k" + (i % 20), String(i));`,
  ], { cwd: path.join(here, ".."), stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((res) => child.stdout.once("data", () => res()));
  await new Promise((res) => setTimeout(res, 120));
  child.kill("SIGKILL");
  await new Promise<void>((res) => child.once("exit", () => res()));
  // The file on disk is either the last complete write or the one before it — never half.
  JSON.parse(fs.readFileSync(busPath(leo), "utf8"));
  const bus = readBus(leo);
  assert.equal(bus.signals.before.value, "true", "a signal written before the crash survived it");
  // ...and a later writer is not blocked by the lock the dead process left behind: the
  // pid inside it answers for its holder, so the lock is broken at once, not waited on.
  const started = Date.now();
  emitSignal(leo, "after", true);
  assert.equal(getSignal(leo, "after"), "true");
  assert.ok(Date.now() - started < 1_000, "a dead holder's lock must be broken immediately");
  assert.ok(!fs.existsSync(path.join(leo, "bus.json.lock")), "the lock is released after the write");
});

test("a lock naming a dead pid is broken at once", () => {
  const leo = tmpLeo();
  // A pid that cannot be running: the lock's owner is gone, so no waiting is warranted.
  fs.writeFileSync(path.join(leo, "bus.json.lock"), "2147483646");
  const started = Date.now();
  emitSignal(leo, "migrated", true);
  assert.equal(getSignal(leo, "migrated"), "true");
  assert.ok(Date.now() - started < 1_000, "a dead pid must not be waited on");
});

test("a stale lock of an unrecognised shape is broken on age, never spun on", () => {
  const leo = tmpLeo();
  // The mkdir-based lock an older writer would have left: a DIRECTORY, with no pid to
  // read. It must be broken on age — and above all must not spin the acquire loop.
  const lock = path.join(leo, "bus.json.lock");
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const started = Date.now();
  emitSignal(leo, "migrated", true);
  assert.equal(getSignal(leo, "migrated"), "true");
  assert.ok(Date.now() - started < 2_000, `breaking a stale lock took ${Date.now() - started}ms`);
});

test("a lock held by a live process is waited on, then given up on with a named error", () => {
  const leo = tmpLeo();
  // This very process is alive, so the lock is honored — and the wait is bounded.
  fs.writeFileSync(path.join(leo, "bus.json.lock"), String(process.pid));
  process.env.LEOPOLD_BUS_LOCK_WAIT_MS = "600";
  const started = Date.now();
  try {
    assert.throws(() => emitSignal(leo, "migrated", true), /could not take .*bus\.json\.lock/);
    assert.ok(Date.now() - started >= 500, "it must actually have waited for the holder");
  } finally {
    delete process.env.LEOPOLD_BUS_LOCK_WAIT_MS;
  }
  fs.rmSync(path.join(leo, "bus.json.lock"));
});

// ---- the trail must never starve the signals -------------------------------------

test("a long decision trail is evicted oldest-first and never blocks a signal", () => {
  const leo = tmpLeo();
  emitSignal(leo, "migrated", "false");
  // Every one of these is fully in contract; enough of them used to push the file past
  // the byte ceiling with no eviction path, and from then on EVERY write threw forever.
  for (let i = 0; i < 400; i++) {
    recordDecision(leo, `d${i} ` + "x".repeat(MAX_NOTE_LEN - 8), { by: i });
  }
  const size = fs.statSync(busPath(leo)).size;
  assert.ok(size <= MAX_BUS_BYTES, `the channel must stay under the ceiling, got ${size} bytes`);

  // The channel's actual job still works, over and over.
  for (let i = 0; i < 25; i++) emitSignal(leo, `sig${i}`, i);
  emitSignal(leo, "migrated", "true", { by: 3 });
  assert.equal(getSignal(leo, "migrated"), "true");
  assert.equal(getSignal(leo, "sig24"), "24");

  const bus = readBus(leo);
  assert.ok(bus.decisions.length > 0, "the newest decisions must still be there");
  assert.equal(bus.decisions.at(-1)!.by, 399, "eviction drops the OLDEST, keeps the newest");
  assert.ok(bus.decisions.every((d) => d.by! > 0), "the oldest decisions are the ones evicted");

  // Lossy by design, but never silently: the eviction is on the event stream.
  const events = fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const trimmed = events.filter((e) => e.event === "bus_trimmed");
  assert.ok(trimmed.length > 0, "an eviction must be logged");
  assert.ok(trimmed[0].dropped > 0 && trimmed[0].kept >= 0);

  // And it survives the turn boundary, which is the whole point.
  assert.equal(
    inFreshProcess(`process.stdout.write(String(bus.getSignal(${JSON.stringify(leo)}, "migrated")));`),
    "true",
  );
});

test("a decision written into a channel already at the ceiling still lands", () => {
  const leo = tmpLeo();
  for (let i = 0; i < 300; i++) recordDecision(leo, `d${i} ` + "x".repeat(MAX_NOTE_LEN - 8), { by: i });
  const before = readBus(leo).decisions.length;
  recordDecision(leo, "took @on migrated=false -> 7", { by: 42 });
  const after = readBus(leo).decisions;
  assert.equal(after.at(-1)!.note, "took @on migrated=false -> 7");
  assert.ok(after.length >= before - 1, "one append must not cost more than it has to");
  assert.ok(fs.statSync(busPath(leo)).size <= MAX_BUS_BYTES);
});

test("no temp file is left behind by a successful write", () => {
  const leo = tmpLeo();
  emitSignal(leo, "migrated", true);
  recordDecision(leo, "routed to 7");
  assert.deepEqual(fs.readdirSync(leo).filter((f) => f.includes(".tmp-")), []);
});
