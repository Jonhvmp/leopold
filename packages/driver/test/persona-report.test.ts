// Unit tests for persona-testing/report.ts: findings distillation + report
// synthesis. Pure core over constructed journeys; the run-dir shell is proven
// against a temp dir (never a real home); the compile-time "no turn, no
// finding" refusal is proven by actually running tsc over a negative snippet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JOURNEY_SCHEMA, JOURNEY_FILE, type Journey, type JourneyTurn } from "../src/persona-testing/journey.ts";
import {
  SUMMARY_OPEN,
  SUMMARY_CLOSE,
  makeFinding,
  distillFindings,
  rankWalls,
  summarizeJourney,
  renderReport,
  reportFromRunDir,
  spliceSummary,
} from "../src/persona-testing/report.ts";

function turn(personaId: string, id: string, extra: Record<string, unknown> = {}): JourneyTurn {
  return { schema_version: JOURNEY_SCHEMA, turn_id: id, persona_id: personaId, state_delta: {}, ...extra };
}

function journey(persona: string, turns: JourneyTurn[]): Journey {
  return {
    header: {
      journey_schema: JOURNEY_SCHEMA,
      flow: "checkout",
      persona,
      app_version: "v1.4.2",
      started_at: "2026-08-18T00:00:00Z",
    },
    turns,
    warnings: [],
  };
}

const confused = (step: string) => ({
  flow_step: step,
  observed_behavior: { comprehension: "completely confused by the plan names" },
});

/** The scenario cast: one solo blocker (carol abandons), one major three
 *  personas hit at the same step ("checkout"), one solo major ("signup"). */
function scenarioCast(): { personaId: string; journey: Journey }[] {
  return [
    {
      personaId: "alice",
      journey: journey("alice", [turn("alice", "a1", confused("checkout")), turn("alice", "a2", confused("billing"))]),
    },
    { personaId: "bob", journey: journey("bob", [turn("bob", "b1", confused("checkout"))]) },
    {
      personaId: "carol",
      journey: journey("carol", [
        turn("carol", "c1", confused("checkout")),
        turn("carol", "c2", {
          flow_step: "pricing",
          observed_behavior: { continuation_intent: "I give up, this is too much" },
        }),
      ]),
    },
  ];
}

test("ranking: severity wins, then cross-persona count breaks ties", () => {
  const all = scenarioCast().flatMap((p) => distillFindings(p.personaId, p.journey));
  const walls = rankWalls(all);
  assert.equal(walls.length, 3);
  // The solo blocker outranks the major three personas share…
  assert.equal(walls[0].severity, "blocker");
  assert.equal(walls[0].kind, "abandonment");
  assert.deepEqual(walls[0].personaIds, ["carol"]);
  // …the shared major outranks every solo major…
  assert.equal(walls[1].severity, "major");
  assert.equal(walls[1].step, "checkout");
  assert.deepEqual(walls[1].personaIds, ["alice", "bob", "carol"]);
  // …and the solo major comes last.
  assert.equal(walls[2].step, "billing");
  assert.deepEqual(walls[2].personaIds, ["alice"]);
});

test("the rendered findings section keeps the ranked order and the evidence trail", () => {
  const report = renderReport({ personas: scenarioCast(), unreadable: [] });
  const f1 = report.indexOf('### F1 — [blocker] abandonment at step "pricing"');
  const f2 = report.indexOf('### F2 — [major] comprehension at step "checkout"');
  const f3 = report.indexOf('### F3 — [major] comprehension at step "billing"');
  assert.ok(f1 !== -1 && f2 !== -1 && f3 !== -1, report);
  assert.ok(f1 < f2 && f2 < f3, "walls rendered out of rank order");
  assert.match(report, /personas hit: 3 \(alice, bob, carol\)/);
  // Every finding names its journey turns — the evidence trail.
  assert.match(report, new RegExp(`carol/${JOURNEY_FILE} c2`));
});

test("an abandonment leads the persona's summary as 'abandoned at turn N' with the step", () => {
  const carol = scenarioCast()[2];
  const lines = summarizeJourney(carol.personaId, carol.journey);
  const ended = lines.find((l) => l.startsWith("- ended:"));
  assert.ok(ended !== undefined);
  assert.match(ended, /abandoned at turn 2/);
  assert.match(ended, /step "pricing"/);
  assert.match(ended, /I give up, this is too much/); // the persona's own words, not a paraphrase
});

test("a signal-less journey distills no findings, and makeFinding refuses empty turns at runtime", () => {
  const quiet = journey("dana", [turn("dana", "d1", { observed_behavior: { comprehension: "all clear" } })]);
  assert.deepEqual(distillFindings("dana", quiet), []);
  assert.throws(
    () =>
      makeFinding({
        kind: "friction",
        personaId: "dana",
        step: "",
        turns: [] as unknown as [string],
        detail: "x",
      }),
    /no journey turn/,
  );
});

test("a turnless finding is refused at COMPILE time — tsc rejects the call", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leopold-report-tsc-"));
  try {
    const mod = path.join(import.meta.dirname, "..", "src", "persona-testing", "report.ts");
    const tsc = path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
    const flags = [
      "--ignoreConfig", "--noEmit", "--strict", "--target", "es2022",
      "--module", "nodenext", "--moduleResolution", "nodenext",
      "--allowImportingTsExtensions", "--skipLibCheck", "--types", "node",
    ];
    const opts = { stdio: "pipe" as const, cwd: path.join(import.meta.dirname, "..") };
    const snippet = (turns: string) =>
      `import { makeFinding } from ${JSON.stringify(mod)};\n` +
      `makeFinding({ kind: "friction", personaId: "p", step: "", turns: ${turns}, detail: "x" });\n`;
    // The positive twin compiles — so the negative failure below is the tuple
    // type doing its job, not a broken harness.
    const good = path.join(dir, "good.ts");
    fs.writeFileSync(good, snippet('["t1"]'));
    execFileSync(tsc, [...flags, good], opts);
    // The distiller cannot even write the call with no turns behind it.
    const bad = path.join(dir, "bad.ts");
    fs.writeFileSync(bad, snippet("[]"));
    assert.throws(() => execFileSync(tsc, [...flags, bad], opts));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the run-dir shell: same journals, same bytes; a corrupt journal is named, the rest render", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leopold-report-run-"));
  try {
    const header = JSON.stringify({
      journey_schema: JOURNEY_SCHEMA,
      flow: "checkout",
      persona: "alice",
      // A credential in a HEADER field is masked only by the final render-time
      // mask — this pins the whole-report mask, not just the per-finding one.
      app_version: "v1.4.2 sk-abcdefghijklmnopqrstuvwx",
      started_at: "2026-08-18T00:00:00Z",
    });
    const aliceTurn = JSON.stringify(
      turn("alice", "a1", { observed_behavior: { friction_points: ["the coupon field rejects my code with api_key=supersecret123 in the error"] } }),
    );
    fs.mkdirSync(path.join(dir, "alice"));
    fs.writeFileSync(path.join(dir, "alice", JOURNEY_FILE), header + "\n" + aliceTurn + "\n");
    fs.mkdirSync(path.join(dir, "bob"));
    fs.writeFileSync(path.join(dir, "bob", JOURNEY_FILE), "this is not a journal\n");
    fs.mkdirSync(path.join(dir, "carol")); // no journal at all

    const first = reportFromRunDir(dir);
    const second = reportFromRunDir(dir);
    assert.equal(first.status, "ok");
    assert.equal(second.status, "ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    // Byte-identical on a re-run — the report is reproducible from journals alone.
    assert.equal(first.text, second.text);
    // The unreadable personas are NAMED, with the reason; alice still renders.
    assert.match(first.text, /persona UNREADABLE: bob — line 1 is not valid JSON/);
    assert.match(first.text, /persona UNREADABLE: carol — no journal at /);
    assert.match(first.text, /### alice\n- turns enacted: 1/);
    // The credential mask governs recorded text: the journaled secret never lands.
    assert.ok(!first.text.includes("supersecret123"), "a journaled credential reached the report");
    assert.ok(!first.text.includes("sk-abcdefghijklmnopqrstuvwx"), "a header credential reached the report");
    assert.match(first.text, /\[redacted\]/);
    // No wall-clock in the body: the date is the journal's own started_at.
    assert.match(first.text, /- date: 2026-08-18T00:00:00Z/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spliceSummary changes ONLY the marked section; everything outside stays byte-identical", () => {
  const report = renderReport({ personas: scenarioCast(), unreadable: [] });
  const spliced = spliceSummary(report, "Three of three personas stalled at checkout; carol walked away.");
  assert.equal(spliced.status, "ok");
  if (spliced.status !== "ok") return;
  const outside = (text: string) =>
    text.slice(0, text.indexOf(SUMMARY_OPEN) + SUMMARY_OPEN.length) + text.slice(text.indexOf(SUMMARY_CLOSE));
  assert.equal(outside(spliced.text), outside(report));
  assert.match(spliced.text, /carol walked away/);
  assert.equal(spliceSummary("no markers here", "x").status, "no_marker");
});
