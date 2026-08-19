// Findings distillation + report synthesis, pure and reproducible. From a run
// dir's journals ALONE: distill each persona's findings (friction points,
// comprehension failures, abandonment, integrity flags — every finding carries
// the journey turns behind it; no turn, no finding), then render `REPORT.md`.
//
// Everything outside the marked `<!-- summary -->` section is deterministic:
// the same journals always produce the same report bytes. No wall-clock (the
// report's date comes from the journals' own headers), stable sorts everywhere,
// and the credential mask governs every line of model-written text that lands
// in the report — journals are untrusted, model-written input.
//
// Detection is LEXICAL, never semantic: a comprehension failure is a
// `comprehension` string matching a fixed signal set, an abandonment is a
// `continuation_intent` matching one, an integrity flag is a boolean `true` in
// the runtime result's own `integrity` block. The persona's own words are
// quoted verbatim (masked) — never summarized into something nicer, and an
// abandonment leads the persona's summary line, exactly as journaled.
//
// Two optional annotations are read beyond the vendored schema's fields, both
// sibling metadata the CONDUCTOR may stamp on a journaled line — additive
// around the runtime result, never a change to it:
//   * `flow_step` — the flow step the turn happened on. When absent, the
//     finding is "unlocated" and never merges into a cross-persona wall.
//   * `bound_violation` — `{rule, detail}`: the turn declared an action the
//     conductor's bounds refused to execute (off-allowlist navigation, an
//     irreversible product action). It distills into a finding, because "the
//     persona would have paid here" is exactly the data the run exists for.
// Conductor stop records (journey.ts `journey_stop` lines) surface in the
// journey summaries: how a run ended — stall, violation, spent budget — is
// stated, never dropped.

import fs from "node:fs";
import path from "node:path";
import { maskCredentials } from "../secrets.js";
import { JOURNEY_FILE, readJourney, type Journey, type JourneyTurn } from "./journey.js";

// -- The summary marker (the ONE non-deterministic region) ------------------

export const SUMMARY_OPEN = "<!-- summary -->";
export const SUMMARY_CLOSE = "<!-- /summary -->";
export const SUMMARY_PLACEHOLDER = "_Executive summary pending — spliced in by the conductor, never counted as deterministic bytes._";

/** Replace the summary section's body. The ONLY sanctioned mutation of a
 *  rendered report; the summary text is masked like everything else. */
export function spliceSummary(
  reportText: string,
  summaryText: string,
): { status: "ok"; text: string } | { status: "no_marker"; reason: string } {
  const open = reportText.indexOf(SUMMARY_OPEN);
  const close = reportText.indexOf(SUMMARY_CLOSE);
  if (open === -1 || close === -1 || close < open)
    return { status: "no_marker", reason: `report has no ${SUMMARY_OPEN} … ${SUMMARY_CLOSE} section` };
  const before = reportText.slice(0, open + SUMMARY_OPEN.length);
  const after = reportText.slice(close);
  return { status: "ok", text: `${before}\n${maskCredentials(summaryText.trim())}\n${after}` };
}

// -- Findings (a turnless finding cannot be built) --------------------------

export type FindingKind = "abandonment" | "bound" | "comprehension" | "friction" | "integrity";
export type Severity = "blocker" | "major" | "minor";

/** Deterministic severity per kind — derived, never caller-supplied, so the
 *  same journals always rank the same way. An abandonment is a blocker (the
 *  persona could not finish), a comprehension failure or a withheld bound
 *  violation is major, friction and integrity flags are minor. */
export const SEVERITY_OF: Record<FindingKind, Severity> = {
  abandonment: "blocker",
  bound: "major",
  comprehension: "major",
  friction: "minor",
  integrity: "minor",
};

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };

declare const FINDING_BRAND: unique symbol;

/** One distilled finding. The brand means the ONLY constructor is
 *  makeFinding(), whose signature requires a non-empty turns tuple — a finding
 *  with no journey turn behind it is refused at compile time, not filtered
 *  out later. */
export interface Finding {
  readonly [FINDING_BRAND]: true;
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly personaId: string;
  /** The flow step the finding anchors to ("" = unlocated: never merges into
   *  a cross-persona wall). */
  readonly step: string;
  /** Journey turn ids — the evidence trail. Never empty. */
  readonly turns: readonly string[];
  /** The persona's own words from the journal, verbatim (masked). */
  readonly detail: string;
  /** Evidence paths relative to the run dir. */
  readonly evidence: readonly string[];
}

/** The one way to build a Finding. `turns` is a non-empty tuple type: a
 *  distiller that has no journey turn to point at cannot even call this. The
 *  runtime guard backs the type for untyped callers. */
export function makeFinding(input: {
  kind: FindingKind;
  personaId: string;
  step: string;
  turns: readonly [string, ...string[]];
  detail: string;
  evidence?: readonly string[];
}): Finding {
  if (input.turns.length === 0) throw new Error("refusing a finding with no journey turn behind it");
  return {
    kind: input.kind,
    severity: SEVERITY_OF[input.kind],
    personaId: input.personaId,
    step: input.step,
    turns: [...input.turns],
    detail: maskCredentials(input.detail),
    evidence: [...(input.evidence ?? [])],
  } as unknown as Finding;
}

// -- Lexical signals (fixed sets — deterministic, documented, never tuned
//    per run) ---------------------------------------------------------------

const ABANDON_SIGNAL = /\b(abandon\w*|giv(?:e|ing)\s+up|gave\s+up|quit\w*|won'?t\s+continue|will\s+not\s+continue|not\s+going\s+to\s+continue|stop\s+trying|done\s+trying)\b/i;

const COMPREHENSION_FAIL_SIGNAL = /\b(fail\w*|confus\w*|lost|unclear|misunderst\w*|no\s+idea|(?:do(?:es)?|did|can|could)\s*n[o']t\s+(?:understand|follow|make\s+sense)|makes\s+no\s+sense)\b/i;

const INTEGRITY_FLAGS = [
  "knowledge_leakage_detected",
  "voice_drift_detected",
  "stimulus_boundary_breach_detected",
] as const;

// -- Turn readers (lexical over the runtime result's own shape) -------------

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function stringOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return v.length > 0 ? [v] : [];
  if (Array.isArray(v)) return v.filter((e): e is string => typeof e === "string" && e.length > 0);
  return [];
}

/** The optional conductor-stamped step annotation. "" when absent. */
export function stepOf(turn: JourneyTurn): string {
  return stringOf(turn.flow_step).trim();
}

/** The optional conductor-stamped bound-violation annotation, or undefined. */
export function boundViolationOf(turn: JourneyTurn): { rule: string; detail: string } | undefined {
  const v = record(turn.bound_violation);
  const rule = stringOf(v.rule).trim();
  if (rule === "") return undefined;
  return { rule, detail: stringOf(v.detail).trim() };
}

function frictionPointsOf(turn: JourneyTurn): string[] {
  return stringsOf(record(turn.observed_behavior).friction_points);
}

function continuationIntentOf(turn: JourneyTurn): string {
  return stringOf(record(turn.observed_behavior).continuation_intent);
}

/** Evidence paths a turn carries, made relative to the run dir by prefixing
 *  the persona's directory (evidence lives under `<persona-id>/evidence/`). */
function evidenceOf(personaId: string, turn: JourneyTurn): string[] {
  return stringsOf(turn.evidence).map((e) => (e.startsWith(personaId + "/") ? e : `${personaId}/${e}`));
}

/** The first abandonment in a journey, or undefined. `turnNumber` is the
 *  1-based position among enacted turns — the "turn N" the report states. */
export function abandonmentOf(
  journey: Journey,
): { turnNumber: number; turn: JourneyTurn; intent: string } | undefined {
  for (let i = 0; i < journey.turns.length; i++) {
    const intent = continuationIntentOf(journey.turns[i]);
    if (ABANDON_SIGNAL.test(intent)) return { turnNumber: i + 1, turn: journey.turns[i], intent };
  }
  return undefined;
}

// -- Distillation (pure over one parsed journey) ----------------------------

/** Distill one persona's findings from its journal alone. Every finding
 *  points at the turn(s) it came from; a signal with no turn cannot exist
 *  here by construction. Deterministic: journal order, no wall-clock. */
export function distillFindings(personaId: string, journey: Journey): Finding[] {
  const findings: Finding[] = [];
  for (const turn of journey.turns) {
    const step = stepOf(turn);
    const evidence = evidenceOf(personaId, turn);
    const friction = frictionPointsOf(turn);
    if (friction.length > 0)
      findings.push(
        makeFinding({ kind: "friction", personaId, step, turns: [turn.turn_id], detail: friction.join("; "), evidence }),
      );
    const comprehension = stringOf(record(turn.observed_behavior).comprehension);
    if (COMPREHENSION_FAIL_SIGNAL.test(comprehension))
      findings.push(
        makeFinding({ kind: "comprehension", personaId, step, turns: [turn.turn_id], detail: comprehension, evidence }),
      );
    const violation = boundViolationOf(turn);
    if (violation !== undefined)
      findings.push(
        makeFinding({
          kind: "bound",
          personaId,
          step,
          turns: [turn.turn_id],
          detail: `bound "${violation.rule}" — the declared action was NOT executed${violation.detail === "" ? "" : `: ${violation.detail}`}`,
          evidence,
        }),
      );
    const integrity = record(turn.integrity);
    const flags = INTEGRITY_FLAGS.filter((f) => integrity[f] === true);
    if (flags.length > 0)
      findings.push(
        makeFinding({
          kind: "integrity",
          personaId,
          step,
          turns: [turn.turn_id],
          detail: `runtime integrity flag(s): ${flags.join(", ")} — this persona's feedback is suspect`,
          evidence,
        }),
      );
  }
  const abandoned = abandonmentOf(journey);
  if (abandoned !== undefined)
    findings.push(
      makeFinding({
        kind: "abandonment",
        personaId,
        step: stepOf(abandoned.turn),
        turns: [abandoned.turn.turn_id],
        detail: `abandoned at turn ${abandoned.turnNumber}: ${abandoned.intent}`,
        evidence: evidenceOf(personaId, abandoned.turn),
      }),
    );
  return findings;
}

// -- Walls (cross-persona grouping + ranking) -------------------------------

/** Findings from different personas that hit the SAME wall: same kind, same
 *  non-empty flow step. Unlocated findings (step "") never merge. */
export interface Wall {
  kind: FindingKind;
  severity: Severity;
  step: string; // "" = unlocated solo finding
  personaIds: string[]; // sorted, unique
  findings: Finding[]; // sorted by personaId then first turn id
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => a.personaId.localeCompare(b.personaId) || a.turns[0].localeCompare(b.turns[0]),
  );
}

/** Group findings into walls and rank them: severity first (a solo blocker
 *  outranks any major), then how many personas hit the same wall, then a
 *  stable lexicographic tiebreak — same journals, same order, always. */
export function rankWalls(findings: readonly Finding[]): Wall[] {
  const groups = new Map<string, Finding[]>();
  let solo = 0;
  for (const f of findings) {
    // Unlocated findings get a unique key: no step reference, no shared wall.
    const key = f.step === "" ? `solo ${solo++}` : `wall ${f.kind} ${f.step}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [f]);
    else group.push(f);
  }
  const walls: Wall[] = [];
  for (const group of groups.values()) {
    const sorted = sortFindings(group);
    walls.push({
      kind: sorted[0].kind,
      severity: sorted[0].severity,
      step: sorted[0].step,
      personaIds: [...new Set(sorted.map((f) => f.personaId))].sort(),
      findings: sorted,
    });
  }
  walls.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.personaIds.length - a.personaIds.length ||
      a.step.localeCompare(b.step) ||
      a.kind.localeCompare(b.kind) ||
      a.personaIds[0].localeCompare(b.personaIds[0]) ||
      a.findings[0].turns[0].localeCompare(b.findings[0].turns[0]),
  );
  return walls;
}

// -- Journey summaries ------------------------------------------------------

/** One persona's summary line data: how far, where friction peaked, how it
 *  ended. The ending is the persona's own words — an abandonment is stated as
 *  "abandoned at turn N", never softened; anything else is quoted verbatim,
 *  never classified into an outcome the journal did not state. */
export function summarizeJourney(personaId: string, journey: Journey): string[] {
  const lines: string[] = [];
  const total = journey.turns.length;
  lines.push(`- turns enacted: ${total}`);
  if (journey.warnings.length > 0)
    lines.push(
      `- journal warnings: ${journey.warnings.length} unusable line(s) (${journey.warnings
        .map((w) => `line ${w.line}: ${w.reason}`)
        .join("; ")})`,
    );
  // How the CONDUCTOR ended the run — a stall, a bound violation, a spent
  // budget — is stated exactly as journaled, in both paths, never dropped.
  const stops = journey.stops ?? [];
  const stopLines = stops.map((s) => `- conductor stop: ${s.reason}${s.detail === "" ? "" : ` — ${s.detail}`}`);
  if (total === 0) {
    lines.push("- ended: no turns enacted");
    lines.push(...stopLines);
    return lines.map((l) => maskCredentials(l));
  }
  let peak: { turnNumber: number; turn: JourneyTurn; count: number } | undefined;
  for (let i = 0; i < journey.turns.length; i++) {
    const count = frictionPointsOf(journey.turns[i]).length;
    if (count > 0 && (peak === undefined || count > peak.count))
      peak = { turnNumber: i + 1, turn: journey.turns[i], count };
  }
  if (peak === undefined) lines.push("- friction: none journaled");
  else lines.push(`- friction peaked at turn ${peak.turnNumber}${locate(peak.turn)}: ${peak.count} point(s)`);
  const abandoned = abandonmentOf(journey);
  if (abandoned !== undefined) {
    lines.push(`- ended: abandoned at turn ${abandoned.turnNumber}${locate(abandoned.turn)} — "${abandoned.intent}"`);
  } else {
    const last = journey.turns[total - 1];
    const intent = continuationIntentOf(last);
    lines.push(
      intent === ""
        ? `- ended: at turn ${total}${locate(last)} (no continuation intent journaled)`
        : `- ended: at turn ${total}${locate(last)} — "${intent}"`,
    );
  }
  lines.push(...stopLines);
  return lines.map((l) => maskCredentials(l));
}

function locate(turn: JourneyTurn): string {
  const step = stepOf(turn);
  return step === "" ? ` (${turn.turn_id})` : ` (step "${step}", ${turn.turn_id})`;
}

// -- Report (pure render) ---------------------------------------------------

export interface PersonaJournal {
  personaId: string;
  journey: Journey;
}

export interface UnreadablePersona {
  personaId: string;
  reason: string;
}

export interface RunReportInput {
  personas: PersonaJournal[];
  unreadable: UnreadablePersona[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Render REPORT.md from parsed journals. Pure and byte-deterministic outside
 *  the summary marker: stable sorts, the date from the journals' own headers,
 *  the credential mask over the whole rendered text. */
export function renderReport(input: RunReportInput): string {
  const personas = [...input.personas].sort((a, b) => a.personaId.localeCompare(b.personaId));
  const unreadable = [...input.unreadable].sort((a, b) => a.personaId.localeCompare(b.personaId));

  const flows = unique(personas.map((p) => p.journey.header.flow));
  const versions = unique(personas.map((p) => p.journey.header.app_version));
  const dates = unique(personas.map((p) => p.journey.header.started_at));

  const lines: string[] = [];
  lines.push(`# Persona run report — ${flows.length > 0 ? flows.join(" | ") : "(no readable journal)"}`);
  lines.push("");
  lines.push(`- flow: ${flows.length > 0 ? flows.join(" | ") : "unknown — no readable journal"}`);
  lines.push(`- date: ${dates.length > 0 ? dates[0] : "unknown — no readable journal"}`);
  lines.push(`- app version: ${versions.length > 0 ? versions.join(" | ") : "unknown — no readable journal"}`);
  lines.push(
    `- personas enacted: ${personas.length > 0 ? personas.map((p) => p.personaId).join(", ") : "none"}`,
  );
  if (unreadable.length > 0)
    for (const u of unreadable) lines.push(`- persona UNREADABLE: ${u.personaId} — ${u.reason}`);
  lines.push("");
  lines.push("## Executive summary");
  lines.push("");
  lines.push(SUMMARY_OPEN);
  lines.push(SUMMARY_PLACEHOLDER);
  lines.push(SUMMARY_CLOSE);
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  const all: Finding[] = [];
  for (const p of personas) all.push(...distillFindings(p.personaId, p.journey));
  const walls = rankWalls(all);
  if (walls.length === 0) {
    lines.push("No findings distilled from the journals.");
    lines.push("");
  }
  walls.forEach((wall, i) => {
    const where = wall.step === "" ? "unlocated" : `step "${wall.step}"`;
    lines.push(`### F${i + 1} — [${wall.severity}] ${wall.kind} at ${where}`);
    lines.push(`- personas hit: ${wall.personaIds.length} (${wall.personaIds.join(", ")})`);
    for (const f of wall.findings) {
      lines.push(`- ${f.personaId} — journey: ${f.turns.map((t) => `${f.personaId}/${JOURNEY_FILE} ${t}`).join(", ")}`);
      lines.push(`  - what happened: ${f.detail}`);
      for (const e of f.evidence) lines.push(`  - evidence: ${e}`);
    }
    lines.push("");
  });

  lines.push("## Journeys");
  lines.push("");
  for (const p of personas) {
    lines.push(`### ${p.personaId}`);
    lines.push(...summarizeJourney(p.personaId, p.journey));
    lines.push("");
  }
  for (const u of unreadable) {
    lines.push(`### ${u.personaId}`);
    lines.push(`- UNREADABLE: ${u.reason} — this persona's journey is missing from this report, not fine.`);
    lines.push("");
  }
  return maskCredentials(lines.join("\n"));
}

// -- Run-dir shell (the only IO here) ---------------------------------------

/** Read a run dir's journals: every subdirectory is a persona; a missing or
 *  corrupt journal makes that persona UNREADABLE — named loudly, never
 *  silently dropped — and every other persona still renders. */
export function readRunDir(
  runDir: string,
): { status: "ok"; input: RunReportInput } | { status: "missing"; reason: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runDir, { withFileTypes: true });
  } catch {
    return { status: "missing", reason: `no run directory at ${runDir}` };
  }
  const input: RunReportInput = { personas: [], unreadable: [] };
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const result = readJourney(path.join(runDir, entry.name, JOURNEY_FILE));
    if (result.status === "ok") input.personas.push({ personaId: entry.name, journey: result.journey });
    else input.unreadable.push({ personaId: entry.name, reason: result.reason });
  }
  return { status: "ok", input };
}

/** `leopold persona report <run-dir>`'s core: re-synthesize REPORT.md from the
 *  journals alone. Same journals, same bytes — always. */
export function reportFromRunDir(
  runDir: string,
): { status: "ok"; text: string } | { status: "missing"; reason: string } {
  const read = readRunDir(runDir);
  if (read.status !== "ok") return read;
  return { status: "ok", text: renderReport(read.input) };
}
