// The state channel: `.leopold/bus.json`.
//
// THE REPOSITORY IS THE TRUTH OF WHAT WAS BUILT. THE CHANNEL IS THE TRUTH OF WHAT WAS
// DECIDED. A node emits a signal (`@emit migrated=false`), the channel carries it, an
// edge routes on it (`@on migrated=false -> 7`). Work product never enters the channel;
// routing signals never enter the repo.
//
// THE CONTRACT — enforced here, in code, not only in prose. Every rule below throws a
// `BusContractError` naming the offending key on write, and is re-applied when reading
// so a hand-edited file cannot smuggle anything past the ceilings either:
//
//   key      matches /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/ — a name, not a payload
//   value    a scalar (string | number | boolean), serialized to a single-line string
//   value    <= 256 characters, no newline and no control character
//   signals  <= 128 keys on the channel at once
//   note     a decision note <= 500 characters, single-line
//   file     <= 64 KiB serialized; a write that would exceed it is rejected
//
// THE TRAIL NEVER BLOCKS A SIGNAL. `decisions` is append-only from the caller's side, so
// left alone it would eventually eat the whole byte ceiling and every later write — even
// a tiny, fully in-contract `emitSignal` — would be rejected forever. It is therefore a
// RING: the oldest decisions are evicted (and the eviction logged as `bus_trimmed`) until
// the snapshot fits. Only the signals are load-bearing, and they are bounded by their own
// ceilings (128 x 256 characters), so a write in contract can always land.
//
// A value big enough to hold a diff, a file, a patch or a log is a value this module
// refuses. That ceiling is the whole reason the channel cannot quietly become a second
// repository nobody reviews.
//
// ON-DISK SHAPE — plain JSON, readable by `jq` from the bash harness:
//
//   { "version": 1,
//     "signals":   { "migrated": { "value": "true", "by": 3, "at": "2026-…Z" } },
//     "decisions": [ { "at": "2026-…Z", "by": 3, "note": "took @on fail -> 7" } ] }
//
// DURABILITY — every write is read-modify-write under a cross-process lock, then
// written to a temp file, fsynced, and renamed over the target. A crash therefore
// leaves either the previous file or the new one, never a half-written one, and two
// parallel items each emitting a signal both survive.
//
// TOLERANCE — a missing file reads as an empty channel. A corrupt file reads as an
// empty channel too: the corruption is logged to events.jsonl (once per process) and
// quarantined on the next write, so a bad byte stalls no run.

import fs from "node:fs";
import path from "node:path";
import { logEvent } from "./log.js";

/** One signal on the channel: what was decided, by whom, when. */
export interface BusSignal {
  /** The decided value, always a single-line string (`"true"`, `"false"`, `"42"`). */
  value: string;
  /** 1-based PLAN.md item index that emitted it, when the writer knew it. */
  by?: number;
  /** ISO timestamp of the write. */
  at: string;
}

/** A routing decision worth reading back — which edge was taken and why. Never work
 *  product: a note is a sentence, not an artifact. */
export interface BusDecision {
  at: string;
  by?: number;
  note: string;
}

/** The whole channel. `signals` is what routing reads; `decisions` is the trail. */
export interface BusSnapshot {
  version: number;
  signals: Record<string, BusSignal>;
  decisions: BusDecision[];
}

/** Thrown when a write would break the channel contract. Named on purpose: a caller
 *  can tell a contract violation from an I/O failure without parsing a message. */
export class BusContractError extends Error {
  /** The signal key (or `"note"` / `"bus"`) the violation is about. */
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = "BusContractError";
    this.key = key;
  }
}

export const BUS_VERSION = 1;
/** Ceilings — the enforced half of the contract above. */
export const MAX_KEY_LEN = 64;
export const MAX_VALUE_LEN = 256;
export const MAX_SIGNALS = 128;
export const MAX_NOTE_LEN = 500;
/** Hard cap on trail length. The byte ceiling may evict below it — see `fitToCeiling`. */
export const MAX_DECISIONS = 200;
export const MAX_BUS_BYTES = 64 * 1024;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
// Anything outside printable text: a value carrying newlines or control bytes is work
// product wearing a signal's clothes.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function busPath(leoDir: string): string {
  return path.join(leoDir, "bus.json");
}

function lockPath(leoDir: string): string {
  return path.join(leoDir, "bus.json.lock");
}

function emptyBus(): BusSnapshot {
  return { version: BUS_VERSION, signals: {}, decisions: [] };
}

/** Validate a signal key. Throws `BusContractError` naming the key. */
export function assertValidKey(key: string): void {
  if (typeof key !== "string" || !key) throw new BusContractError(String(key), "bus: a signal key must be a non-empty string");
  if (key.length > MAX_KEY_LEN) {
    throw new BusContractError(key, `bus: signal key "${key.slice(0, 24)}…" is ${key.length} characters, over the ${MAX_KEY_LEN}-character ceiling`);
  }
  if (!KEY_RE.test(key)) {
    throw new BusContractError(key, `bus: signal key "${key}" is not a name — use letters, digits, "_", "." or "-", starting with a letter`);
  }
}

/** Normalize a scalar to the single-line string the channel stores, enforcing the
 *  value ceiling. Throws `BusContractError` naming the key. */
export function normalizeValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    throw new BusContractError(key, `bus: signal "${key}" has no value — the channel carries decisions, so say what was decided`);
  }
  if (typeof value === "object") {
    throw new BusContractError(key, `bus: signal "${key}" must be a string, number or boolean — the channel carries decisions, not structures (work product belongs in git)`);
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new BusContractError(key, `bus: signal "${key}" must be a string, number or boolean, got ${typeof value}`);
  }
  const text = String(value);
  if (text.length > MAX_VALUE_LEN) {
    throw new BusContractError(key, `bus: signal "${key}" is ${text.length} characters, over the ${MAX_VALUE_LEN}-character value ceiling — the channel carries decisions, not work product (put it in the repo)`);
  }
  if (CONTROL_RE.test(text)) {
    throw new BusContractError(key, `bus: signal "${key}" contains a newline or control character — a signal is one line, not a document`);
  }
  return text;
}

function normalizeNote(note: unknown): string {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) throw new BusContractError("note", "bus: a decision needs a note saying what was decided");
  if (text.length > MAX_NOTE_LEN) {
    throw new BusContractError("note", `bus: decision note is ${text.length} characters, over the ${MAX_NOTE_LEN}-character ceiling — the channel records the decision, not the work`);
  }
  if (CONTROL_RE.test(text)) throw new BusContractError("note", "bus: a decision note is one line — no newlines or control characters");
  return text;
}

/** Keep the same corruption out of events.jsonl on every read of the same file. */
const loggedCorrupt = new Set<string>();

function noteCorruption(leoDir: string, reason: string): void {
  const p = busPath(leoDir);
  if (loggedCorrupt.has(p)) return;
  loggedCorrupt.add(p);
  try {
    logEvent(leoDir, { event: "bus_corrupt", file: p, reason });
  } catch { /* observability must never take the run down */ }
}

/** Drop anything on disk that breaks the contract instead of trusting it — a
 *  hand-edited or half-written file must not widen what the channel may carry. */
function sanitize(raw: unknown, leoDir: string): { bus: BusSnapshot; dropped: number } {
  const bus = emptyBus();
  let dropped = 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    noteCorruption(leoDir, `the channel file is ${Array.isArray(raw) ? "an array" : typeof raw}, not an object`);
    return { bus, dropped: 1 };
  }
  const obj = raw as Record<string, unknown>;
  const signals = obj.signals;
  if (signals && typeof signals === "object" && !Array.isArray(signals)) {
    for (const [key, entry] of Object.entries(signals as Record<string, unknown>)) {
      if (Object.keys(bus.signals).length >= MAX_SIGNALS) { dropped += 1; continue; }
      const e = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
      // Tolerate the flat shorthand `{"migrated": "true"}` a hand-edit or `jq` may leave.
      const value = e ? e.value : entry;
      try {
        assertValidKey(key);
        const at = e && typeof e.at === "string" ? e.at : new Date(0).toISOString();
        const by = e && typeof e.by === "number" && Number.isFinite(e.by) ? e.by : undefined;
        bus.signals[key] = { value: normalizeValue(key, value), ...(by !== undefined ? { by } : {}), at };
      } catch { dropped += 1; }
    }
  } else if (signals !== undefined) dropped += 1;
  if (Array.isArray(obj.decisions)) {
    for (const d of obj.decisions.slice(-MAX_DECISIONS)) {
      const o = d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
      if (!o) { dropped += 1; continue; }
      try {
        bus.decisions.push({
          at: typeof o.at === "string" ? o.at : new Date(0).toISOString(),
          ...(typeof o.by === "number" && Number.isFinite(o.by) ? { by: o.by } : {}),
          note: normalizeNote(o.note),
        });
      } catch { dropped += 1; }
    }
  } else if (obj.decisions !== undefined) dropped += 1;
  if (dropped) noteCorruption(leoDir, `${dropped} malformed entr${dropped === 1 ? "y" : "ies"} dropped`);
  return { bus, dropped };
}

/** Read the whole channel. Never throws: a missing file is an empty channel, and a
 *  corrupt one is an empty channel plus a logged `bus_corrupt` event. */
export function readBus(leoDir: string): BusSnapshot {
  let text: string;
  try {
    text = fs.readFileSync(busPath(leoDir), "utf8");
  } catch {
    return emptyBus(); // absent — the channel simply has nothing on it yet
  }
  if (text.length > MAX_BUS_BYTES * 4) {
    noteCorruption(leoDir, `file is ${text.length} characters, far over the ${MAX_BUS_BYTES}-byte ceiling`);
    return emptyBus();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    noteCorruption(leoDir, `unparseable JSON: ${(err as Error).message}`);
    return emptyBus();
  }
  return sanitize(raw, leoDir).bus;
}

/** The flat `key -> value` view routing reads. */
export function readSignals(leoDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(readBus(leoDir).signals)) out[k] = s.value;
  return out;
}

/** One signal's value, or undefined when the channel does not carry it. */
export function getSignal(leoDir: string, key: string): string | undefined {
  return readBus(leoDir).signals[key]?.value;
}

function sleep(ms: number): void {
  // A blocking sleep with no dependency and no busy spin: the driver's file helpers
  // are synchronous, so the lock wait has to be too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A write takes milliseconds. A lock whose holder is gone is broken at once (the pid
// inside it answers that); one whose holder cannot be identified is broken on age.
const LOCK_STALE_MS = 3_000;
const LOCK_WAIT_DEFAULT_MS = 15_000;

/** How long to wait for a live holder before giving up. Read at call time so a test —
 *  or an operator on a very slow filesystem — can move it: LEOPOLD_BUS_LOCK_WAIT_MS. */
function lockWaitMs(): number {
  const n = parseInt(process.env.LEOPOLD_BUS_LOCK_WAIT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : LOCK_WAIT_DEFAULT_MS;
}

/** True when nothing is running under `pid` any more — signal 0 only checks. */
function holderGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Delete the lock-candidate file a dead writer left behind, so a crashed run does not
 *  litter .leopold/ with one file per crash. */
function sweepLockTemps(leoDir: string, pid: number): void {
  const prefix = `${path.basename(lockPath(leoDir))}.${pid}.`;
  try {
    for (const f of fs.readdirSync(leoDir)) {
      if (f.startsWith(prefix)) fs.rmSync(path.join(leoDir, f), { force: true });
    }
  } catch { /* best effort */ }
}

/** Take the cross-process lock. The lock file is created by LINKING a file that already
 *  holds the holder's pid, so it is atomic AND never observed empty: a writer killed the
 *  instant after taking the lock still leaves a lock that names its dead owner, and the
 *  next writer breaks it immediately instead of waiting out a timeout. */
function withLock<T>(leoDir: string, fn: () => T): T {
  const lock = lockPath(leoDir);
  const mine = `${lock}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const waitMs = lockWaitMs();
  const deadline = Date.now() + waitMs;
  fs.writeFileSync(mine, String(process.pid));
  try {
    for (;;) {
      // Checked on EVERY iteration, including the break-and-retry paths: no state on
      // disk may turn this into a spin that never ends.
      if (Date.now() > deadline) throw new Error(`bus: could not take ${lock} within ${waitMs}ms`);
      try {
        fs.linkSync(mine, lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // The holder died mid-write? Its temp file was never renamed, so the channel on
        // disk is still whole; break the lock and carry on.
        let dead = false;
        let holder = 0;
        try {
          holder = parseInt(fs.readFileSync(lock, "utf8").trim(), 10);
          dead = Number.isFinite(holder) && holder > 0 && holderGone(holder);
        } catch { /* unreadable: fall through to the age check */ }
        if (dead) sweepLockTemps(leoDir, holder);
        if (!dead) {
          try { dead = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { continue; }
        }
        if (dead) {
          // `recursive` matters: a lock left by an older mkdir-based writer is a
          // DIRECTORY, and removing it non-recursively would fail on every pass.
          try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
          continue;
        }
        sleep(15);
      }
    }
    try {
      return fn();
    } finally {
      try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
    }
  } finally {
    try { fs.rmSync(mine, { force: true }); } catch { /* ignore */ }
  }
}

/** Move a file the parser could not read aside instead of overwriting it silently:
 *  whatever went wrong stays inspectable. */
function quarantine(leoDir: string): void {
  const p = busPath(leoDir);
  try {
    if (!fs.existsSync(p)) return;
    JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    const aside = `${p}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(p, aside);
      noteCorruption(leoDir, `quarantined to ${path.basename(aside)}`);
    } catch { /* best effort — the write below replaces it anyway */ }
  }
}

function serialize(bus: BusSnapshot): string {
  return JSON.stringify(bus, null, 2) + "\n";
}

function sizeOf(bus: BusSnapshot): number {
  return Buffer.byteLength(serialize(bus));
}

/** Make the snapshot fit the byte ceiling by evicting the OLDEST decisions, so the
 *  append-only trail can never starve the signals — the channel's actual job. Mutates
 *  `bus` in place and returns how many decisions were dropped for space.
 *
 *  Keeping a suffix is monotone in size (a shorter suffix is never larger), so the
 *  longest suffix that fits is found by bisection: log(n) serializations, not n. If even
 *  an empty trail is over the ceiling, the trail is left empty and `writeAtomic` throws
 *  with the honest signals-only byte count. */
function fitToCeiling(bus: BusSnapshot): number {
  if (bus.decisions.length > MAX_DECISIONS) bus.decisions = bus.decisions.slice(-MAX_DECISIONS);
  if (sizeOf(bus) <= MAX_BUS_BYTES) return 0;
  const all = bus.decisions;
  bus.decisions = [];
  if (sizeOf(bus) > MAX_BUS_BYTES) return all.length; // signals alone are over: let the write fail
  let lo = 0;            // known to fit
  let hi = all.length;   // known not to fit
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    bus.decisions = all.slice(all.length - mid);
    if (sizeOf(bus) <= MAX_BUS_BYTES) lo = mid; else hi = mid;
  }
  bus.decisions = lo ? all.slice(all.length - lo) : [];
  return all.length - lo;
}

/** Serialize + fsync + rename. Either the old file or the new one survives a crash. */
function writeAtomic(leoDir: string, bus: BusSnapshot): void {
  const target = busPath(leoDir);
  const text = serialize(bus);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BUS_BYTES) {
    throw new BusContractError("bus", `bus: the channel would be ${bytes} bytes, over the ${MAX_BUS_BYTES}-byte ceiling — it carries decisions, not work product`);
  }
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd); // the bytes are on the platter BEFORE anything points at them
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    const dir = fs.openSync(leoDir, "r");
    try { fs.fsyncSync(dir); } catch { /* directories are not fsyncable everywhere */ }
    fs.closeSync(dir);
  } catch { /* best effort */ }
}

/** Read-modify-write the channel under the lock. Every mutation goes through here, so
 *  two parallel items never clobber each other's signals. */
function mutate<T>(leoDir: string, fn: (bus: BusSnapshot) => T): T {
  return withLock(leoDir, () => {
    quarantine(leoDir);
    const bus = readBus(leoDir);
    const out = fn(bus);
    bus.version = BUS_VERSION;
    const evicted = fitToCeiling(bus);
    if (evicted) {
      // Never silent: the trail is lossy by design, and the run must be able to see it.
      try { logEvent(leoDir, { event: "bus_trimmed", file: busPath(leoDir), dropped: evicted, kept: bus.decisions.length }); } catch { /* observability must never take the run down */ }
    }
    writeAtomic(leoDir, bus);
    return out;
  });
}

export interface EmitOptions {
  /** 1-based PLAN.md item index of the emitting node. */
  by?: number;
}

/** Put one signal on the channel. Throws `BusContractError` — naming the key — when the
 *  key, the value or the resulting file breaks the contract; nothing is written then. */
export function emitSignal(leoDir: string, key: string, value: unknown, opts: EmitOptions = {}): BusSignal {
  assertValidKey(key);
  const entry: BusSignal = {
    value: normalizeValue(key, value),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
    at: new Date().toISOString(),
  };
  return mutate(leoDir, (bus) => {
    if (!(key in bus.signals) && Object.keys(bus.signals).length >= MAX_SIGNALS) {
      throw new BusContractError(key, `bus: the channel already carries ${MAX_SIGNALS} signals — "${key}" would be one too many`);
    }
    bus.signals[key] = entry;
    return entry;
  });
}

/** Put several signals on the channel in ONE locked write. All-or-nothing: if any of
 *  them breaks the contract, none is written. */
export function emitSignals(leoDir: string, entries: Record<string, unknown>, opts: EmitOptions = {}): void {
  const at = new Date().toISOString();
  const validated: Array<[string, BusSignal]> = [];
  for (const [key, value] of Object.entries(entries)) {
    assertValidKey(key);
    validated.push([key, { value: normalizeValue(key, value), ...(opts.by !== undefined ? { by: opts.by } : {}), at }]);
  }
  if (!validated.length) return;
  mutate(leoDir, (bus) => {
    for (const [key, entry] of validated) {
      if (!(key in bus.signals) && Object.keys(bus.signals).length >= MAX_SIGNALS) {
        throw new BusContractError(key, `bus: the channel already carries ${MAX_SIGNALS} signals — "${key}" would be one too many`);
      }
      bus.signals[key] = entry;
    }
  });
}

/** Append one routing decision to the trail. */
export function recordDecision(leoDir: string, note: string, opts: EmitOptions = {}): BusDecision {
  const entry: BusDecision = {
    at: new Date().toISOString(),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
    note: normalizeNote(note),
  };
  return mutate(leoDir, (bus) => {
    bus.decisions.push(entry);
    return entry;
  });
}

/** Drop one signal (the decision it carried no longer holds). True when it was there. */
export function clearSignal(leoDir: string, key: string): boolean {
  return mutate(leoDir, (bus) => {
    if (!(key in bus.signals)) return false;
    delete bus.signals[key];
    return true;
  });
}

/** Empty the channel — a fresh run starts with nothing decided. */
export function resetBus(leoDir: string): void {
  withLock(leoDir, () => {
    quarantine(leoDir);
    writeAtomic(leoDir, emptyBus());
  });
}
