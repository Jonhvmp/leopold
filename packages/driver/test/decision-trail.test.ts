// THE TRAIL: every persona decision lands in DECISIONS.md, through ONE writer.
//
// Autonomy without a record is an unaudited machine. Four stop paths now decide instead
// of halting — a `@human` node, an escalation, a graph/deadlock repair, a third failure —
// and the thing that keeps that on the right side of the line is that none of them can
// decide without leaving an entry an auditor can read: WHO decided, at WHICH fork, on
// WHAT charter basis, WHAT the call was, WHY, and HOW TO UNDO IT.
//
// So this suite asserts three things the feature is worthless without:
//   1. every persona path produces a whole entry — six fields, none blank, from a
//      synthesized persona AND from the fallback where synthesis produced no role;
//   2. there is exactly ONE writer for the file, and every call site tells it the fork;
//   3. a run with no persona path does not touch DECISIONS.md at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { logPersonaDecision } from "../src/log.ts";
import { parsePersona, FORK_SITUATION, NO_PERSONA, DEFAULT_REVERSAL, DEFAULT_WHY } from "../src/persona.ts";
import type { Persona, PersonaFork } from "../src/persona.ts";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { processItem } from "../src/loop.ts";
import type { Brief, DriverConfig, RunState } from "../src/types.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const CHARTER = `# Charter

## Never
- Run git push, git tag or npm publish.

## Always
- Stage the work and report.
`;

function tmpLeo(): string {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-trail-"));
  fs.writeFileSync(path.join(leo, "events.jsonl"), "");
  return leo;
}

function persona(fork: PersonaFork, item: string): Persona {
  const p = parsePersona(
    JSON.stringify({
      name: "Mara Vance",
      role: "Release Engineer",
      expertise: ["staged rollouts", "database cutovers"],
      optimizesFor: ["a reversible step"],
      rationale: "the item is a cutover",
    }),
    { fork, item },
    CHARTER,
  );
  assert.ok(p, "the fixture persona parses");
  return p;
}

// --- the documented format ------------------------------------------------------------

interface Entry { n: number; title: string; fields: Record<string, string>; order: string[] }

/** Parse DECISIONS.md the way docs/decision-protocol.md documents it: `## D<N> — <title>
 *  (turn <n>, <ts>)` followed by `Key:` lines. Deliberately strict — the point of the
 *  file is that a human (or the next release's tooling) can read it. */
function parseTrail(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    const h = line.match(/^## D(\d+) — (.+?)\s+\(turn (\d+), (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\)$/);
    if (h) { out.push({ n: Number(h[1]), title: h[2], fields: {}, order: [] }); continue; }
    const f = line.match(/^([A-Z][A-Za-z]+):\s+(.+)$/);
    if (f && out.length) {
      out[out.length - 1].fields[f[1]] = f[2].trim();
      out[out.length - 1].order.push(f[1]);
    }
  }
  return out;
}

const SIX = ["Persona", "Fork", "Charter", "Decision", "Why", "Reversal"];

function assertWhole(e: Entry, label: string): void {
  for (const k of SIX) {
    assert.ok(e.fields[k] !== undefined, `${label}: the entry has a ${k} field`);
    assert.ok(e.fields[k].trim().length > 0, `${label}: ${k} is not blank`);
  }
  assert.ok(e.fields.Reversal.length > 10, `${label}: the Reversal is a real way back, not a token`);
}

// --- 1. every path, with and without a synthesized role --------------------------------

test("each of the four persona paths writes an entry with all six fields", () => {
  const forks: PersonaFork[] = ["human", "escalation", "repair", "deadlock", "repeated-failure"];
  for (const fork of forks) {
    const leo = tmpLeo();
    const item = `decide the ${fork} case`;
    logPersonaDecision(leo, 3, persona(fork, item), {
      decision: "ship the cutover behind a flag",
      why: "the charter says reversible first",
      reversal: "flip LEOPOLD_CUTOVER=0 in .env and redeploy",
    }, { fork, item });

    const [e] = parseTrail(fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8"));
    assertWhole(e, fork);
    assert.match(e.fields.Persona, /^Mara Vance — Release Engineer \(/, `${fork}: the role that decided is named`);
    assert.ok(e.fields.Fork.startsWith(FORK_SITUATION[fork]), `${fork}: the entry says which stop path it came from`);
    assert.match(e.fields.Fork, new RegExp(item), `${fork}: and what was being decided`);
    assert.match(e.fields.Charter, /charter rule\(s\) bind Release Engineer/, `${fork}: what bound the role`);
    assert.equal(e.fields.Decision, "ship the cutover behind a flag");
    assert.equal(e.fields.Reversal, "flip LEOPOLD_CUTOVER=0 in .env and redeploy");
  }
});

test("synthesis failing does not cost the trail an entry — six fields either way", () => {
  // Persona synthesis is best-effort by design: an unparseable answer runs the item under
  // the default worker prompt. The DECISION still happened, so it is still recorded — the
  // fork and the work come from the caller's context instead of from a role.
  for (const fork of ["human", "escalation", "repair", "deadlock", "repeated-failure"] as PersonaFork[]) {
    const leo = tmpLeo();
    logPersonaDecision(leo, 1, undefined, { decision: "keep the existing route", why: "", reversal: "" },
      { fork, item: "the stranded item" });
    const [e] = parseTrail(fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8"));
    assertWhole(e, `${fork} without a persona`);
    assert.equal(e.fields.Persona, NO_PERSONA, "the entry says plainly that nobody was synthesized");
    assert.ok(e.fields.Fork.startsWith(FORK_SITUATION[fork]), "the fork is still on the record");
    assert.equal(e.fields.Why, DEFAULT_WHY, "a stated-nothing Why falls back, never blank");
    assert.equal(e.fields.Reversal, DEFAULT_REVERSAL, "and there is always a way back");
  }
});

// --- 2. two decisions in one run -------------------------------------------------------

test("two decisions in one run: both appended, newest last, the file still parses", () => {
  const leo = tmpLeo();
  const header = "# Decisions\n\n> Append-only audit trail, newest last.\n";
  fs.writeFileSync(path.join(leo, "DECISIONS.md"), header);

  logPersonaDecision(leo, 2, persona("human", "approve the cutover"),
    { decision: "approve it", why: "reversible", reversal: "revert the flag commit" },
    { fork: "human", item: "approve the cutover" });
  logPersonaDecision(leo, 5, persona("escalation", "postgres or sqlite"),
    { decision: "sqlite", why: "no new infrastructure", reversal: "swap the adapter" },
    { fork: "escalation", item: "postgres or sqlite" });

  const text = fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8");
  assert.ok(text.startsWith(header), "the file is APPENDED to; the header the brief wrote survives");

  const entries = parseTrail(text);
  assert.equal(entries.length, 2, "both calls are on the record");
  assertWhole(entries[0], "first");
  assertWhole(entries[1], "second");
  assert.equal(entries[1].n, entries[0].n + 1, "numbering increments");
  assert.ok(text.indexOf("approve it") < text.indexOf("sqlite"), "newest LAST, in the order decided");
  assert.deepEqual(entries[0].order, entries[1].order, "both entries have the same shape — one writer, one format");
  assert.deepEqual(entries[0].order, ["Persona", "Fork", "Class", "Charter", "Decision", "Why", "Reversal"]);
});

// --- 3. no persona path, no entry ------------------------------------------------------

test("a run with no persona path leaves DECISIONS.md untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-trail-run-"));
  const git = (a: string[]): void => { execFileSync("git", a, { cwd: root, stdio: "ignore" }); };
  git(["init", "-q"]); git(["config", "user.email", "t@t.com"]); git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  git(["add", "-A"]); git(["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "events.jsonl"), "");
  const decisions = path.join(leo, "DECISIONS.md");
  const before = "# Decisions\n\n> Append-only audit trail, newest last.\n";
  fs.writeFileSync(decisions, before);

  const item = "Tidy the header spacing";
  const block = "```leopold-status\nSTATUS: done\nITEM: " + item +
    "\nSUMMARY: implemented and verified\nNEXT: none\nEVIDENCE: build+test ok\n```";
  const stream = (text: string) => (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    yield { type: "result", result: text, total_cost_usd: 0 };
  })();

  setQuery(((input: { options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") return stream(block);
    const sys = typeof sp === "string" ? sp : "";
    if (sys.includes("the conductor")) return stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    return stream('{"ok":true,"blocking":[],"summary":"clean"}');
  }) as never);

  const cfg = {
    maxTurnsPerItem: 10, review: false, maxReviewRounds: 1, conformance: false,
    hypotheses: false, smartRouting: false, learnOnFinish: false, parallel: 1,
    literalReset: false, bestOfK: 1, sliceScope: false, worktree: false, dryRun: false,
  } as DriverConfig;
  const state: RunState = {
    active: true, iteration: 1, max_iterations: 10, consecutive_failures: 0, max_failures: 3, started_at: "",
  };
  const brief = { mission: "", charter: CHARTER, guardrails: "", planPath: "", root, leoDir: leo } as Brief;

  try {
    const out = await processItem(brief, cfg, state, [], item, [], root);
    assert.equal(out.done, true, "the plain item closes");
  } finally {
    resetQuery();
  }
  assert.equal(fs.readFileSync(decisions, "utf8"), before, "no persona path ran, so nothing was written");
});

// --- 4. one writer, and every call site tells it the fork ------------------------------

test("DECISIONS.md has exactly one writer, and it is log.ts", () => {
  const offenders: string[] = [];
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(SRC, f), "utf8");
    // A write to the trail is an fs write whose path names the file. Comments mention it
    // constantly, so match the CODE: a join/path expression carrying "DECISIONS.md".
    if (/(?:appendFileSync|writeFileSync)\([^)]*DECISIONS\.md/s.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, ["log.ts"],
    "only log.ts writes DECISIONS.md — a second writer is how two shapes end up in one file");
});

test("every persona path hands the writer its fork", () => {
  // The fallback fields (fork, work) only exist if the call site passes them, so a new
  // persona path that forgets is a half-blank entry nobody notices until an audit.
  const seen: string[] = [];
  // log.ts DECLARES it; everyone else CALLS it.
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith(".ts") && n !== "log.ts")) {
    const text = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const m of text.matchAll(/[^a-z]logPersonaDecision\(([\s\S]*?)\n\s*\);/g)) {
      assert.match(m[1], /fork:\s*"(human|escalation|repair|deadlock|repeated-failure)"/,
        `${f}: this logPersonaDecision call must pass its fork`);
      seen.push(`${f}:${m[1].match(/fork:\s*"([a-z-]+)"/)![1]}`);
    }
  }
  const forks = new Set(seen.map((s) => s.split(":")[1]));
  assert.deepEqual([...forks].sort(), ["deadlock", "escalation", "human", "repair", "repeated-failure"],
    "all four stop paths (five forks) are wired to the trail");
});
