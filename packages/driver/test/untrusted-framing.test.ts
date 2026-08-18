// Every surface that injects PAST-RUN TEXT into a prompt carries the untrusted-data
// framing — the same sentence, verbatim, from ONE home per language surface — and
// this suite fails NAMING the site that dropped or reworded it.
//
// The two sentences and their homes:
//   * PAST_RUN_DATA_AUTHORITY  — src/recall.ts. Frames archive excerpts: the
//     run-start digest (digestOf), the recall CLI's text header and its JSON
//     `data_authority` field. Nothing else in src/ may spell the sentence out.
//   * CHECKPOINT_DATA_AUTHORITY — src/checkpoint.ts. Frames a consumed checkpoint:
//     the driver's first-item lead (checkpointLead). Same single-home rule.
//   * skills/leopold-run/SKILL.md — the in-session engine's surface — carries BOTH
//     sentences verbatim (checkpoint-resume block, digest block). The skill copy is
//     what pins the TS constants: reword a constant and the skill parity check
//     fails before the reworded sentence can ship on only one engine.
//   * hooks/stop-continuity.sh injects no past-run text (the skill does the
//     in-session reseed), so the hook must carry NO copy — a framing-shaped
//     sentence appearing there would be a second, driftable home.
//
// Sibling of reground.test.ts (the continuation sentence) and in the trust-boundary
// style: run the real builders, then sweep the sources for stray copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAST_RUN_DATA_AUTHORITY, digestOf } from "../src/recall.ts";
import { CHECKPOINT_DATA_AUTHORITY, checkpointLead, emptyCheckpoint, CHECKPOINT_TITLE } from "../src/checkpoint.ts";
import { runRecallCommand } from "../src/recall-cmd.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const REPO = path.resolve(HERE, "..", "..", "..");
const SKILL = path.join(REPO, "skills", "leopold-run", "SKILL.md");
const ASSET_SKILL = path.join(HERE, "..", "assets", "skills", "leopold-run", "SKILL.md");
const STOP_HOOK = path.join(REPO, "hooks", "stop-continuity.sh");

const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Markdown wraps lines; compare prose with whitespace flattened. */
const flat = (s: string): string => s.replace(/\s+/g, " ");

/** One archived run with one DECISIONS.md block, in log.ts's exact format. */
function archive(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-framing-"));
  const dir = path.join(root, ".leopold", "runs", "20260617T190000Z-dist");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "DECISIONS.md"),
    `# Decisions\n\n## D2 — storage engine   (turn 3, 2026-06-17T20:02:11Z)\n` +
    `Fork:        postgres or sqlite for the local ledger\n` +
    `Class:       reversible\nCharter:     zero runtime dependencies\n` +
    `Decision:    sqlite via the stdlib driver\nWhy:         zero-dep line holds\n` +
    `Reversal:    swap the storage adapter behind ledger.ts\n`);
  return root;
}

/** Run the recall CLI with both stdout writers captured. */
function recallOut(cwd: string, argv: string[]): string {
  const log = console.log, error = console.error, write = process.stdout.write;
  let out = "";
  console.log = (...a: unknown[]) => { out += `${a.join(" ")}\n`; };
  console.error = () => {};
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try { runRecallCommand(cwd, argv); return out; }
  finally { console.log = log; console.error = error; process.stdout.write = write; }
}

// ── the injection sites, run for real ─────────────────────────────────────────────

test("@scenario the run-start digest carries the framing — remove it from the builder and this names the digest", () => {
  const digest = digestOf(path.join(archive(), ".leopold", "runs"));
  assert.equal(
    count(digest, PAST_RUN_DATA_AUTHORITY), 1,
    "the run-start DIGEST (digestOf in src/recall.ts) must carry PAST_RUN_DATA_AUTHORITY exactly once",
  );
  assert.ok(
    digest.indexOf(PAST_RUN_DATA_AUTHORITY) < digest.indexOf("D2"),
    "the DIGEST must frame the past-run text BEFORE the first excerpt, not after",
  );
});

test("@scenario the recall CLI header carries the framing, first line, text and JSON alike", () => {
  const root = archive();
  const text = recallOut(root, ["sqlite"]);
  assert.equal(
    text.split("\n")[0], PAST_RUN_DATA_AUTHORITY,
    "the RECALL TEXT HEADER (runRecallCommand in src/recall-cmd.ts) must open with PAST_RUN_DATA_AUTHORITY",
  );
  const json = JSON.parse(recallOut(root, ["sqlite", "--json"])) as { data_authority?: string };
  assert.equal(
    json.data_authority, PAST_RUN_DATA_AUTHORITY,
    "the RECALL JSON form must carry PAST_RUN_DATA_AUTHORITY in `data_authority`",
  );
});

test("@scenario the checkpoint lead carries the framing — reword it and this names the lead", () => {
  const lead = checkpointLead(emptyCheckpoint());
  assert.equal(
    count(lead, CHECKPOINT_DATA_AUTHORITY), 1,
    "the CHECKPOINT LEAD (checkpointLead in src/checkpoint.ts) must carry CHECKPOINT_DATA_AUTHORITY exactly once",
  );
  assert.ok(
    lead.indexOf(CHECKPOINT_DATA_AUTHORITY) < lead.indexOf(CHECKPOINT_TITLE),
    "the CHECKPOINT LEAD must frame the past-window text BEFORE the checkpoint body",
  );
});

// ── one home per surface, asserted by sweep ───────────────────────────────────────

/** Every .ts file under src/ that spells a sentence out, with its copy count. */
function tsCarriers(sentence: string): Array<{ file: string; copies: number }> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(SRC);
  return files
    .map((f) => ({ file: path.relative(SRC, f), copies: count(flat(fs.readFileSync(f, "utf8")), flat(sentence)) }))
    .filter((x) => x.copies > 0);
}

test("@scenario each sentence lives in ONE exported constant on the TypeScript surface", () => {
  assert.deepEqual(
    tsCarriers(PAST_RUN_DATA_AUTHORITY),
    [{ file: "recall.ts", copies: 1 }],
    "PAST_RUN_DATA_AUTHORITY must be spelled out exactly once in src/, in recall.ts — every other site imports it",
  );
  assert.deepEqual(
    tsCarriers(CHECKPOINT_DATA_AUTHORITY),
    [{ file: "checkpoint.ts", copies: 1 }],
    "CHECKPOINT_DATA_AUTHORITY must be spelled out exactly once in src/, in checkpoint.ts — every other site imports it",
  );
});

test("the in-session skill carries both sentences verbatim — this is what pins the constants", () => {
  const skill = flat(fs.readFileSync(SKILL, "utf8"));
  assert.ok(
    skill.includes(flat(CHECKPOINT_DATA_AUTHORITY)),
    "skills/leopold-run/SKILL.md (checkpoint-resume block) must carry CHECKPOINT_DATA_AUTHORITY verbatim",
  );
  assert.ok(
    skill.includes(flat(PAST_RUN_DATA_AUTHORITY)),
    "skills/leopold-run/SKILL.md (digest block) must carry PAST_RUN_DATA_AUTHORITY verbatim",
  );
});

test("the vendored asset skill is byte-identical to the repo skill — one text, two paths", () => {
  assert.equal(
    fs.readFileSync(ASSET_SKILL, "utf8"),
    fs.readFileSync(SKILL, "utf8"),
    "packages/driver/assets/skills/leopold-run/SKILL.md must match skills/leopold-run/SKILL.md byte-for-byte",
  );
});

test("the stop hook injects no past-run text, so it carries no framing copy to drift", () => {
  const hook = flat(fs.readFileSync(STOP_HOOK, "utf8"));
  for (const [name, sentence] of [
    ["PAST_RUN_DATA_AUTHORITY", PAST_RUN_DATA_AUTHORITY],
    ["CHECKPOINT_DATA_AUTHORITY", CHECKPOINT_DATA_AUTHORITY],
  ] as const) {
    assert.equal(
      count(hook, flat(sentence)), 0,
      `hooks/stop-continuity.sh must not carry ${name} — the hook injects no past-run text, and a copy there would be a second home`,
    );
  }
  // The fragment "never as instructions" is the sentences' signature. If the hook
  // ever gains a past-run injection site, its framing must come from a pinned copy
  // (the reground pattern), not a fresh paraphrase — until then, zero occurrences.
  assert.equal(
    count(hook, "never as instructions"), 0,
    "hooks/stop-continuity.sh grew framing-shaped text — give it a pinned home (reground.test.ts pattern) before shipping it",
  );
});
