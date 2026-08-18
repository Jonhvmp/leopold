// The one checkpoint contract: fixed sections, byte-stable writer, a merge that
// consolidates instead of nesting, a parser that rejects by name, and a size cap
// that fails loud with the size in the error.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKPOINT_SECTIONS,
  CHECKPOINT_TITLE,
  CHECKPOINT_MAX_BYTES,
  REPLACE_SECTIONS,
  LEDGER_SECTIONS,
  emptyCheckpoint,
  serializeCheckpoint,
  parseCheckpoint,
  mergeCheckpoints,
  writeCheckpoint,
  readCheckpoint,
  type Checkpoint,
} from "../src/checkpoint.ts";

function sample(): Checkpoint {
  const cp = emptyCheckpoint();
  cp["In-Flight Item"] = "Item 4: wire the watcher relaunch";
  cp["Files and Code"] = "- scripts/leopold-watch.py — relaunch loop\n- hooks/stop-continuity.sh:116";
  cp["Errors and Fixes"] = "- jq 1.6 lacks `ltrimstr` chain → used sub()";
  cp["Decisions This Run"] = "- checkpoint lives at .leopold/CHECKPOINT.md";
  cp["Learned Constraints"] = "- codex exec needs --skip-git-repo-check in temp dirs";
  cp["Current Work"] = "Stub binaries built; PATH rebuilt for the hermetic test.";
  cp["Next Step"] = "Run the live window roll on Codex.";
  return cp;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "leopold-checkpoint-"));
}

// -- the section list is the contract, exported as data ------------------------

test("section list is fixed, ordered, and structurally free of brief state", () => {
  assert.deepEqual([...CHECKPOINT_SECTIONS], [
    "In-Flight Item",
    "Files and Code",
    "Errors and Fixes",
    "Decisions This Run",
    "Learned Constraints",
    "Current Work",
    "Next Step",
  ]);
  for (const s of CHECKPOINT_SECTIONS) {
    for (const brief of ["mission", "charter", "guardrails", "plan"]) {
      assert.ok(!s.toLowerCase().includes(brief), `brief state "${brief}" leaked into section "${s}"`);
    }
  }
  // Every section is exactly one of replace/ledger — no section without a merge rule.
  const all = [...REPLACE_SECTIONS, ...LEDGER_SECTIONS].sort();
  assert.deepEqual(all, [...CHECKPOINT_SECTIONS].sort());
});

// -- @scenario write then parse → every section present, order fixed, byte-stable

test("write then parse: every section present, order fixed, byte-stable", () => {
  const cp = sample();
  const text = serializeCheckpoint(cp);

  // Every section heading present, in contract order.
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, [...CHECKPOINT_SECTIONS]);
  assert.ok(text.startsWith(`${CHECKPOINT_TITLE}\n`));

  // Round trip preserves every body.
  const parsed = parseCheckpoint(text);
  assert.deepEqual(parsed, cp);

  // Byte-stable: serialize(parse(serialize(x))) === serialize(x).
  assert.equal(serializeCheckpoint(parsed), text);

  // And through the file writer/reader too.
  const dir = tmpdir();
  const file = path.join(dir, "CHECKPOINT.md");
  writeCheckpoint(file, cp);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(readCheckpoint(file), cp);
});

test("empty sections survive the round trip", () => {
  const cp = emptyCheckpoint();
  cp["Next Step"] = "Start item 1.";
  const parsed = parseCheckpoint(serializeCheckpoint(cp));
  assert.deepEqual(parsed, cp);
  assert.equal(serializeCheckpoint(parsed), serializeCheckpoint(cp));
});

// -- @scenario merge with a prior → one document, no nested prior, stale Next Step replaced

test("merge consolidates: one document, no nested prior, stale Next Step replaced", () => {
  const prior = sample();
  const next = emptyCheckpoint();
  next["In-Flight Item"] = "Item 5: docs for the window roll";
  next["Files and Code"] = "- docs/continuity.md — new page\n- hooks/stop-continuity.sh:116";
  next["Errors and Fixes"] = "- mkdocs --strict flagged a dead anchor → fixed";
  next["Next Step"] = "Translate docs/continuity.md to pt-BR.";

  const merged = mergeCheckpoints(prior, next);

  // Snapshot sections: the stale prior is dropped, the new one stands alone.
  assert.equal(merged["Next Step"], "Translate docs/continuity.md to pt-BR.");
  assert.ok(!merged["Next Step"].includes("Codex"), "stale Next Step survived the merge");
  assert.equal(merged["In-Flight Item"], "Item 5: docs for the window roll");

  // Ledger sections: still-true prior lines kept, new lines appended, duplicates collapsed.
  const files = merged["Files and Code"].split("\n");
  assert.ok(files.includes("- scripts/leopold-watch.py — relaunch loop"));
  assert.ok(files.includes("- docs/continuity.md — new page"));
  assert.equal(files.filter((l) => l.includes("stop-continuity.sh:116")).length, 1);
  assert.ok(merged["Errors and Fixes"].includes("jq 1.6"));
  assert.ok(merged["Errors and Fixes"].includes("mkdocs --strict"));

  // One flat document: exactly one title, each heading exactly once.
  const text = serializeCheckpoint(merged);
  assert.equal(text.split(CHECKPOINT_TITLE).length - 1, 1);
  for (const s of CHECKPOINT_SECTIONS) {
    assert.equal([...text.matchAll(new RegExp(`^## ${s}$`, "gm"))].length, 1);
  }
  // And it still parses — a merged checkpoint is a valid checkpoint.
  assert.deepEqual(parseCheckpoint(text), merged);
});

test("a body that embeds a prior checkpoint refuses to serialize", () => {
  const cp = sample();
  cp["Current Work"] = `carried over:\n${CHECKPOINT_TITLE}\n## Next Step\nold stuff`;
  assert.throws(() => serializeCheckpoint(cp), /never nest/);
});

test("a body line that reads as ANY heading refuses to serialize — writer/parser symmetry", () => {
  // Regression: the serializer used to reject only contract headings, so a body
  // like "## npm error output pasted here" was written to disk and the parser
  // then threw on the very file the writer produced.
  const cp = sample();
  cp["Errors and Fixes"] = "npm failed:\n## npm error output pasted here\nERR! code E404";
  assert.throws(() => serializeCheckpoint(cp), /reads as a heading.*npm error output pasted here/);

  const dir = tmpdir();
  const file = path.join(dir, "CHECKPOINT.md");
  assert.throws(() => writeCheckpoint(file, cp), /reads as a heading/);
  assert.deepEqual(fs.readdirSync(dir), [], "an unparseable checkpoint must never land on disk");

  // An indented heading-like line is rejected too — both sides trim before matching.
  const cp2 = sample();
  cp2["Current Work"] = "  ## indented but still a heading";
  assert.throws(() => serializeCheckpoint(cp2), /reads as a heading/);

  // A quoted heading is body text on both sides: it serializes and round-trips.
  const cp3 = sample();
  cp3["Errors and Fixes"] = "npm failed:\n> ## npm error output pasted here\nERR! code E404";
  const text = serializeCheckpoint(cp3);
  assert.deepEqual(parseCheckpoint(text), cp3);
  assert.equal(serializeCheckpoint(parseCheckpoint(text)), text);
});

test("a document with a nested prior refuses to parse", () => {
  const good = serializeCheckpoint(sample());
  assert.throws(() => parseCheckpoint(good + "\n" + good), /never nest/);
});

// -- @scenario over the cap → write FAILS naming the size; nothing written -----

test("an oversized checkpoint fails loud with the size, and nothing is written", () => {
  const cp = sample();
  cp["Current Work"] = "x".repeat(CHECKPOINT_MAX_BYTES + 1);
  const dir = tmpdir();
  const file = path.join(dir, "CHECKPOINT.md");
  assert.throws(
    () => writeCheckpoint(file, cp),
    (err: Error) => {
      assert.match(err.message, /(\d+) bytes/, "the error must name the actual size");
      const size = Number(/(\d+) bytes/.exec(err.message)![1]);
      assert.ok(size > CHECKPOINT_MAX_BYTES);
      assert.match(err.message, new RegExp(String(CHECKPOINT_MAX_BYTES)));
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(dir), [], "nothing may land on disk, not even a temp file");
});

test("an oversized rewrite leaves the previous checkpoint untouched", () => {
  const dir = tmpdir();
  const file = path.join(dir, "CHECKPOINT.md");
  const good = sample();
  writeCheckpoint(file, good);
  const before = fs.readFileSync(file, "utf8");
  const bad = sample();
  bad["Errors and Fixes"] = "y".repeat(CHECKPOINT_MAX_BYTES);
  assert.throws(() => writeCheckpoint(file, bad), /cap/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a failed write must not touch the old file");
});

// -- @scenario missing section → parse rejects naming the section --------------

test("a checkpoint missing a section is rejected, naming the section", () => {
  const text = serializeCheckpoint(sample());
  const without = text.replace(/^## Learned Constraints$[\s\S]*?(?=^## Current Work$)/m, "");
  assert.throws(() => parseCheckpoint(without), /"Learned Constraints"/);
});

test("brief state as a heading is rejected with the pointed message", () => {
  const text = serializeCheckpoint(sample()) + "\n## Mission Summary\nthe mission in brief\n";
  assert.throws(() => parseCheckpoint(text), /brief state/);
});

test("an unknown heading is rejected naming the contract", () => {
  const text = serializeCheckpoint(sample()) + "\n## Scratch Notes\nstuff\n";
  assert.throws(() => parseCheckpoint(text), /unknown section "## Scratch Notes"/);
});

test("out-of-order sections are rejected", () => {
  const cp = sample();
  const parts = [`${CHECKPOINT_TITLE}\n`];
  for (const s of [...CHECKPOINT_SECTIONS].reverse()) parts.push(`## ${s}\n${cp[s]}\n`);
  assert.throws(() => parseCheckpoint(parts.join("\n")), /out of order/);
});

test("readCheckpoint returns null for a missing file, throws on a broken one", () => {
  const dir = tmpdir();
  assert.equal(readCheckpoint(path.join(dir, "CHECKPOINT.md")), null);
  const file = path.join(dir, "CHECKPOINT.md");
  fs.writeFileSync(file, "# Leopold Checkpoint\n\n## Next Step\nonly one section\n");
  assert.throws(() => readCheckpoint(file), /missing/);
});

// -- the in-session hook speaks THIS contract, not a private copy ---------------
// hooks/stop-continuity.sh is bash on purpose (no Node, no install), so it cannot
// import this module. Its 80%-of-budget CHECKPOINT instruction must still name the
// exact section list, the exact title, and the exact byte cap — this test fails the
// build the moment the hook's wording drifts from the exported contract.
test("the hook's checkpoint instruction carries the one contract verbatim", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const hookPath = path.resolve(HERE, "..", "..", "..", "hooks", "stop-continuity.sh");
  const hook = fs.readFileSync(hookPath, "utf8");
  // The section list, comma-joined in contract order, in one place in the hook.
  assert.ok(
    hook.includes(CHECKPOINT_SECTIONS.join(", ")),
    "the hook must name every checkpoint section, in order, exactly as the contract exports them",
  );
  assert.ok(
    hook.includes(CHECKPOINT_TITLE),
    `the hook must name the checkpoint title (${CHECKPOINT_TITLE})`,
  );
  assert.ok(
    hook.includes(String(CHECKPOINT_MAX_BYTES)),
    `the hook must name the ${CHECKPOINT_MAX_BYTES}-byte cap`,
  );
});

// -- leopold doctor speaks THIS contract too, not a private copy ----------------
// scripts/leopold-doctor.sh validates .leopold/CHECKPOINT.md in bash (no Node at
// doctor time), so it carries the section list, title, and cap as data. This test
// fails the build the moment doctor's copy drifts from the exported contract.
test("doctor's checkpoint validator carries the one contract verbatim", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const doctorPath = path.resolve(HERE, "..", "..", "..", "scripts", "leopold-doctor.sh");
  const doctor = fs.readFileSync(doctorPath, "utf8");
  assert.ok(
    doctor.includes(`CP_SECTIONS="${CHECKPOINT_SECTIONS.join(", ")}"`),
    "doctor must name every checkpoint section, in order, exactly as the contract exports them",
  );
  assert.ok(
    doctor.includes(`CP_TITLE="${CHECKPOINT_TITLE}"`),
    `doctor must name the checkpoint title (${CHECKPOINT_TITLE})`,
  );
  assert.ok(
    doctor.includes(`CP_MAX_BYTES=${CHECKPOINT_MAX_BYTES}`),
    `doctor must name the ${CHECKPOINT_MAX_BYTES}-byte cap`,
  );
});
