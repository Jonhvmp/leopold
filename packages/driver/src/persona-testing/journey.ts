// The journey journal core, pure. A persona run's ONLY continuity state is its
// `JOURNEY.jsonl`: one header line (`journey_schema`, `flow`, `persona`,
// `app_version`, `started_at`) followed by one `persona-runtime-result/1.0`
// object per enacted turn, appended BEFORE the action it describes is taken —
// if it is not in the journal, it did not happen.
//
// The vendored contract skills own persona semantics; this module never parses
// them. A turn is checked LEXICALLY — it is an object, it names the schema, it
// carries `turn_id`, `persona_id` and a `state_delta` object — and everything
// else in it is opaque model-written text: untrusted for later readers, framed
// on re-entry with the imported PAST_RUN_DATA_AUTHORITY sentence (one home per
// surface, recall.ts — never a respelled copy).
//
// Everything here is byte-deterministic: parsing is pure over the file's text
// (same bytes in, same result out — stable order, no wall-clock anywhere), a
// malformed line becomes a typed warning that names its line number and never
// a throw, and the writers are append-only (`O_APPEND`, one whole line per
// call) so a crashed window can never rewrite history it already journaled.

import fs from "node:fs";
import { PAST_RUN_DATA_AUTHORITY } from "../recall.js";

/** The one schema this journal carries. Owned by the vendored runtime skill —
 *  the driver checks the name lexically and never forks or extends it. */
export const JOURNEY_SCHEMA = "persona-runtime-result/1.0";

/** Journal filename inside a run's per-persona directory. */
export const JOURNEY_FILE = "JOURNEY.jsonl";

/** How many tail turns a reseed block carries. Enough to re-ground a relaunched
 *  window on where the persona just was; the chained state carries the rest. */
export const RESEED_TAIL_TURNS = 5;

// -- Shapes -----------------------------------------------------------------

/** The journal's first line. Field order here is the serialized byte order —
 *  the in-session skill writes the same line, and parity is asserted by test. */
export interface JourneyHeader {
  journey_schema: string; // JOURNEY_SCHEMA
  flow: string;
  persona: string;
  app_version: string;
  started_at: string; // UTC, written once at run start — never re-stamped
}

/** One enacted turn: the runtime skill's result object, held lexically. The
 *  four named fields are what the conductor needs; the rest is opaque. */
export interface JourneyTurn {
  schema_version: string; // JOURNEY_SCHEMA
  turn_id: string;
  persona_id: string;
  state_delta: Record<string, unknown>; // chained as the next turn's PRIOR_STATE
  [key: string]: unknown;
}

/** A line the journal could not use. Reported loudly, never thrown, and never
 *  silently repaired — the surrounding turns still parse. */
export interface JourneyWarning {
  line: number; // 1-based line number in the file
  reason: string;
}

/** A CONDUCTOR-written stop record: why the driver ended this persona's run —
 *  a bound violation, a stall, a spent step budget. Driver-owned and additive:
 *  it is not a runtime-result turn and never pretends to be one, so the
 *  vendored schema stays unforked. `reason` is a short machine word
 *  ("allowlist", "irreversible", "stall", "budget"); `detail` is the sentence
 *  a human reads. */
export interface JourneyStop {
  line: number; // 1-based line number in the file
  reason: string;
  detail: string;
}

export interface Journey {
  header: JourneyHeader;
  turns: JourneyTurn[];
  warnings: JourneyWarning[];
  /** Conductor stop records, in file order. Optional so pre-existing literal
   *  constructions stay valid; parseJourney always sets it. */
  stops?: JourneyStop[];
}

export type JourneyReadResult =
  | { status: "ok"; journey: Journey }
  | { status: "missing"; reason: string } // no file at that path
  | { status: "empty"; reason: string } // a file with no header line
  | { status: "bad_header"; reason: string }; // first line is not a journey header

/** lastState() answer: typed, never undefined. Header-only journals say so. */
export type LastState =
  | { status: "ok"; turn_id: string; state: Record<string, unknown> }
  | { status: "no_turns"; reason: string };

// -- Lexical checks (presence, never semantics) -----------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Check one parsed value as a journey header. Returns the reason it is not. */
export function checkHeader(v: unknown): { ok: true; header: JourneyHeader } | { ok: false; reason: string } {
  if (!isRecord(v)) return { ok: false, reason: "header line is not a JSON object" };
  if (v.journey_schema !== JOURNEY_SCHEMA)
    return { ok: false, reason: `header journey_schema is not "${JOURNEY_SCHEMA}"` };
  for (const field of ["flow", "persona", "app_version", "started_at"] as const) {
    if (!nonEmptyString(v[field])) return { ok: false, reason: `header field "${field}" missing or empty` };
  }
  return { ok: true, header: v as unknown as JourneyHeader };
}

/** Check one parsed value as an enacted turn. Lexical only: the schema name,
 *  the two ids, and a state_delta object. Everything else is the skill's. */
export function checkTurn(v: unknown): { ok: true; turn: JourneyTurn } | { ok: false; reason: string } {
  if (!isRecord(v)) return { ok: false, reason: "turn line is not a JSON object" };
  if (v.schema_version !== JOURNEY_SCHEMA)
    return { ok: false, reason: `turn schema_version is not "${JOURNEY_SCHEMA}"` };
  if (!nonEmptyString(v.turn_id)) return { ok: false, reason: 'turn field "turn_id" missing or empty' };
  if (!nonEmptyString(v.persona_id)) return { ok: false, reason: 'turn field "persona_id" missing or empty' };
  if (!isRecord(v.state_delta)) return { ok: false, reason: 'turn field "state_delta" missing or not an object' };
  return { ok: true, turn: v as unknown as JourneyTurn };
}

// -- Serialization (canonical bytes, one writer) ----------------------------

/** The header's canonical bytes: fixed field order, no re-stamping. This is
 *  the ONE serializer for the header line on the driver surface. */
export function headerLine(header: JourneyHeader): string {
  return JSON.stringify({
    journey_schema: header.journey_schema,
    flow: header.flow,
    persona: header.persona,
    app_version: header.app_version,
    started_at: header.started_at,
  });
}

/** A turn's canonical bytes: the object as given (the runtime skill's own
 *  field order), one line, no reformatting. */
export function turnLine(turn: JourneyTurn): string {
  return JSON.stringify(turn);
}

/** A stop record's canonical bytes: `{"journey_stop":{"reason":…,"detail":…}}`,
 *  one line. The ONE serializer for conductor stop lines. */
export function stopLine(reason: string, detail: string): string {
  return JSON.stringify({ journey_stop: { reason, detail } });
}

/** Check one parsed value as a conductor stop record. */
export function checkStop(v: unknown): { ok: true; reason: string; detail: string } | { ok: false } {
  if (!isRecord(v) || !isRecord(v.journey_stop)) return { ok: false };
  const s = v.journey_stop;
  if (!nonEmptyString(s.reason) || typeof s.detail !== "string") return { ok: false };
  return { ok: true, reason: s.reason, detail: s.detail };
}

// -- Parse (pure) -----------------------------------------------------------

/** Parse a journal's full text. Pure and deterministic: the same text always
 *  yields the same result. A malformed turn line is a typed warning naming its
 *  line number; every other turn still parses. Never throws. */
export function parseJourney(text: string): JourneyReadResult {
  const lines = text.split("\n");
  // Trailing newline yields one empty final element; blank lines anywhere else
  // are malformed content and warn like any other unusable line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { status: "empty", reason: "journal has no header line" };

  let headerValue: unknown;
  try {
    headerValue = JSON.parse(lines[0]);
  } catch {
    return { status: "bad_header", reason: "line 1 is not valid JSON" };
  }
  const head = checkHeader(headerValue);
  if (!head.ok) return { status: "bad_header", reason: head.reason };

  const turns: JourneyTurn[] = [];
  const warnings: JourneyWarning[] = [];
  const stops: JourneyStop[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      warnings.push({ line: lineNo, reason: "not valid JSON" });
      continue;
    }
    const stop = checkStop(value);
    if (stop.ok) {
      stops.push({ line: lineNo, reason: stop.reason, detail: stop.detail });
      continue;
    }
    const turn = checkTurn(value);
    if (!turn.ok) {
      warnings.push({ line: lineNo, reason: turn.reason });
      continue;
    }
    turns.push(turn.turn);
  }
  return { status: "ok", journey: { header: head.header, turns, warnings, stops } };
}

/** Read a journal file. The thin IO shell over parseJourney: a missing file is
 *  a typed status, never a throw. */
export function readJourney(filePath: string): JourneyReadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { status: "missing", reason: `no journal at ${filePath}` };
  }
  return parseJourney(text);
}

// -- Append (atomic, append-only) -------------------------------------------

/** Start a journal: write the header line. Refuses to touch an existing file —
 *  the journal is append-only history, never recreated over itself. */
export function createJourney(
  filePath: string,
  header: JourneyHeader,
): { status: "created" } | { status: "exists"; reason: string } {
  const check = checkHeader(header);
  if (!check.ok) throw new Error(`refusing to create an invalid journal: ${check.reason}`);
  try {
    // wx: create exclusively — an existing journal is never overwritten.
    fs.writeFileSync(filePath, headerLine(header) + "\n", { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      return { status: "exists", reason: `journal already exists at ${filePath}` };
    throw err;
  }
  return { status: "created" };
}

/** Append one enacted turn: one whole line in a single O_APPEND write, so a
 *  concurrent reader sees either the full turn or nothing. An invalid turn is
 *  rejected loudly BEFORE any bytes land — never silently repaired. */
export function appendTurn(
  filePath: string,
  turn: JourneyTurn,
): { status: "appended" } | { status: "rejected"; reason: string } {
  const check = checkTurn(turn);
  if (!check.ok) return { status: "rejected", reason: check.reason };
  return appendLine(filePath, turnLine(turn));
}

/** One O_APPEND write to an EXISTING journal. The open itself rejects a missing
 *  file (no O_CREAT) — never a check-then-write, so no window in which a moved
 *  or archived journal could be recreated headerless. */
function appendLine(
  filePath: string,
  line: string,
): { status: "appended" } | { status: "rejected"; reason: string } {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  } catch {
    return { status: "rejected", reason: `no journal at ${filePath} — create it with its header first` };
  }
  try {
    fs.writeSync(fd, line + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return { status: "appended" };
}

/** Append one conductor stop record: why the driver ended this persona's run.
 *  Same append-only discipline as a turn — one whole line, never a rewrite —
 *  so the journal's last line names how the run ended, reproducibly. */
export function appendStop(
  filePath: string,
  reason: string,
  detail: string,
): { status: "appended" } | { status: "rejected"; reason: string } {
  if (reason.length === 0) return { status: "rejected", reason: "a stop record needs a non-empty reason" };
  return appendLine(filePath, stopLine(reason, detail));
}

// -- Continuity (pure over a parsed journey) --------------------------------

/** The tail turn's state_delta — chained as the next turn's PRIOR_STATE. A
 *  header-only journal answers with a typed "no turns yet", never undefined. */
export function lastState(journey: Journey): LastState {
  const tail = journey.turns[journey.turns.length - 1];
  if (tail === undefined) return { status: "no_turns", reason: "journal has a header but no enacted turns yet" };
  return { status: "ok", turn_id: tail.turn_id, state: tail.state_delta };
}

/** The re-seed block a relaunched window resumes from: the framing sentence
 *  (imported, exactly once), the header, a bounded tail of turns, and the last
 *  state_delta as the next PRIOR_STATE. Pure and byte-deterministic — the same
 *  journey always yields the same block, so a roll-and-resume is provable. */
export function reseedBlock(journey: Journey, tailTurns: number = RESEED_TAIL_TURNS): string {
  const lines: string[] = [PAST_RUN_DATA_AUTHORITY, ""];
  lines.push(`journey header: ${headerLine(journey.header)}`);
  const total = journey.turns.length;
  const tail = journey.turns.slice(Math.max(0, total - tailTurns));
  if (tail.length === 0) {
    lines.push("turns: none enacted yet");
  } else {
    lines.push(`turns ${total - tail.length + 1}..${total} of ${total}:`);
    for (const turn of tail) lines.push(turnLine(turn));
  }
  const state = lastState(journey);
  if (state.status === "ok") {
    lines.push(`PRIOR_STATE (from turn ${state.turn_id}):`);
    lines.push(JSON.stringify(state.state));
  } else {
    lines.push("PRIOR_STATE: none — no turns enacted yet; begin at the flow's first step.");
  }
  return lines.join("\n") + "\n";
}
