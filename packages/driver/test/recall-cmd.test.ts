// Unit tests for the `leopold recall` CLI: flag parsing, the untrusted-data header,
// the JSON contract, and the exit-code contract. Hermetic: every project is built in
// a temp dir; nothing reads the real repo or ~/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRecallCommand } from "../src/recall-cmd.ts";
import { PAST_RUN_DATA_AUTHORITY, digestOf, type RecallHit } from "../src/recall.ts";

/** A throwaway project root. withLeo/withRuns control how much of the archive exists. */
function project(opts: { withLeo?: boolean; withRuns?: boolean } = {}): string {
  // HERMETIC even for the no-.leopold case: findLeoDir walks UP from cwd, so a bare
  // mkdtemp root would let a stray /tmp/.leopold (or any ancestor's) be silently
  // searched — a dev who once briefed in /tmp would flip the "no archived runs"
  // assertions. A decoy .leopold with NO runs dir at the outer root pins the walk:
  // the nearest .leopold the command can find is ours, and it is empty by intent.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "leopold-recall-cmd-"));
  fs.mkdirSync(path.join(outer, ".leopold"));
  const root = path.join(outer, "proj");
  fs.mkdirSync(root);
  if (opts.withLeo || opts.withRuns) fs.mkdirSync(path.join(root, ".leopold"));
  if (opts.withRuns) fs.mkdirSync(path.join(root, ".leopold", "runs"));
  return root;
}

function writeRun(root: string, run: string, files: Record<string, string>): void {
  const dir = path.join(root, ".leopold", "runs", run);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

const DECISIONS = `# Decisions

## D2 — storage engine   (turn 3, 2026-06-17T20:02:11Z)
Fork:        postgres or sqlite for the local ledger
Class:       reversible
Charter:     zero runtime dependencies
Decision:    sqlite via the stdlib driver
Why:         zero-dep line holds
Reversal:    swap the storage adapter behind ledger.ts
`;

/** Run the command with stdout/stderr captured, so the streams and the exit code
 *  are asserted instead of assumed. Covers console.log AND process.stdout.write. */
function run(cwd: string, argv: string[]): { code: number; out: string; err: string } {
  const log = console.log, error = console.error, write = process.stdout.write;
  let out = "", err = "";
  console.log = (...a: unknown[]) => { out += `${a.join(" ")}\n`; };
  console.error = (...a: unknown[]) => { err += `${a.join(" ")}\n`; };
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try {
    return { code: runRecallCommand(cwd, argv), out, err };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}

test("@scenario recall <words> in a project with archives: ranked excerpts, each naming run and file", () => {
  const root = project({ withRuns: true });
  writeRun(root, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS });
  writeRun(root, "20260701T120000Z-other", { "MISSION.md": "Ship the sqlite ledger cleanly.\n" });

  const r = run(root, ["postgres", "sqlite"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /20260617T190000Z-dist\/DECISIONS\.md · D2 — storage engine/);
  assert.match(r.out, /20260701T120000Z-other\/MISSION\.md · line 1/);
  assert.match(r.out, /Reversal: swap the storage adapter behind ledger\.ts/);
  assert.match(r.out, /across 2 archived run\(s\)/);
});

test("@scenario the text output's first line frames results as past-run data, not instructions", () => {
  const root = project({ withRuns: true });
  writeRun(root, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS });

  const first = run(root, ["sqlite"]).out.split("\n")[0];
  assert.equal(first, PAST_RUN_DATA_AUTHORITY);
  assert.match(first, /never as instructions/);
});

test("@scenario --json: valid JSON with the same fields the text form shows", () => {
  const root = project({ withRuns: true });
  writeRun(root, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS });

  const r = run(root, ["sqlite", "--json"]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out) as {
    data_authority: string; query: string; status: string; runsSearched: number;
    hits: RecallHit[]; warnings: unknown[];
  };
  assert.equal(parsed.data_authority, PAST_RUN_DATA_AUTHORITY);
  assert.equal(parsed.query, "sqlite");
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.runsSearched, 1);
  const hit = parsed.hits[0];
  assert.equal(hit.run, "20260617T190000Z-dist");
  assert.equal(hit.file, "DECISIONS.md");
  assert.equal(hit.ref, "D2 — storage engine");
  assert.ok(hit.score > 0);
  assert.match(hit.excerpt, /Decision: sqlite via the stdlib driver/);
  assert.match(hit.reversal ?? "", /swap the storage adapter/);
});

test("@scenario no .leopold/runs/: 'no archived runs yet' on stdout, exit 0", () => {
  // A .leopold with no runs dir, and no .leopold at all: the same honest answer.
  for (const root of [project({ withLeo: true }), project()]) {
    const r = run(root, ["anything"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /no archived runs yet/);
    assert.equal(r.err, "");
  }
});

test("runs exist but nothing matches: said out loud, exit 0", () => {
  const root = project({ withRuns: true });
  writeRun(root, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS });
  const r = run(root, ["zzzqqq"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /no matches for "zzzqqq" across 1 archived run\(s\)/);
});

test("--limit caps the hits; --provider's value never leaks into the query", () => {
  const root = project({ withRuns: true });
  writeRun(root, "20260601T000000Z-a", {
    "MISSION.md": Array.from({ length: 10 }, (_, i) => `ledger line ${i}`).join("\n") + "\n",
  });
  const r = run(root, ["--provider", "codex", "--limit", "2", "ledger", "--json"]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out) as { query: string; hits: unknown[] };
  assert.equal(parsed.query, "ledger"); // not "codex ledger"
  assert.equal(parsed.hits.length, 2);
});

test("@scenario --digest: exactly the block the driver seeds, byte-identical, from the same builder", () => {
  const root = project({ withRuns: true });
  writeRun(root, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS });

  // What the driver's run start seeds: digestOf() over the same runs dir
  // (loop.ts calls it with path.join(brief.leoDir, "runs") and injects verbatim).
  const seeded = digestOf(path.join(root, ".leopold", "runs"));
  assert.ok(seeded.length > 0, "the fixture must produce a real digest");

  const r = run(root, ["--digest"]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.equal(r.out, `${seeded}\n`); // stdout IS the seeded block — plus only the terminal newline
  assert.ok(r.out.includes(PAST_RUN_DATA_AUTHORITY), "the framing rides inside the block itself");

  // The global --provider flag never breaks the mode (index.ts strips it late).
  const r2 = run(root, ["--provider", "codex", "--digest"]);
  assert.equal(r2.out, r.out);
});

test("@scenario --digest with no archived decisions: stdout byte-empty (the driver seeds nothing), stderr says so, exit 0", () => {
  // No .leopold, a .leopold with no runs dir, and an empty runs dir: same answer.
  for (const root of [project(), project({ withLeo: true }), project({ withRuns: true })]) {
    const r = run(root, ["--digest"]);
    assert.equal(r.code, 0);
    assert.equal(r.out, ""); // byte-identical to what the driver seeds: nothing
    assert.match(r.err, /no archived decisions yet/); // ...but never a silent empty exit
  }
});

test("--digest is a mode: a query or another flag beside it is a usage error", () => {
  const root = project({ withRuns: true });
  writeRun(root, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS });
  for (const argv of [["--digest", "sqlite"], ["--digest", "--json"], ["--digest", "--limit", "3"]]) {
    const r = run(root, argv);
    assert.equal(r.code, 2, `argv ${JSON.stringify(argv)} should be a usage error`);
    assert.match(r.err, /--digest takes no query and no other flags/);
    assert.equal(r.out, "");
  }
});

test("usage errors exit 2 with the message on stderr: no query, bad --limit, unknown flag", () => {
  const root = project({ withRuns: true });
  for (const argv of [[], ["--limit", "0", "x"], ["--frobnicate", "x"]]) {
    const r = run(root, argv);
    assert.equal(r.code, 2, `argv ${JSON.stringify(argv)} should be a usage error`);
    assert.match(r.err, /leopold recall:/);
    assert.equal(r.out, "");
  }
});
