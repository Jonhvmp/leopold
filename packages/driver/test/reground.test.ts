// Every CONTINUATION re-grounds, and both engines re-ground with the same words.
//
// A continuation — the hook's re-injected turn, a serial retry, the one rescued
// attempt — follows narration from earlier in the run, and the workspace may have
// outrun that narration. So every continuation carries the re-grounding sentence:
// trust the tree, the tool results and durable state over the story so far. A FIRST
// attempt has no earlier narration to distrust, so it deliberately does not carry it.
//
// The sentence lives in exactly ONE place per language surface:
//   * TypeScript: src/worker.ts exports REGROUND_SENTENCE; loop.ts and rescue.ts
//     import it. This file fails the build if a second copy appears anywhere in src/.
//   * bash: hooks/stop-continuity.sh defines REGROUND_SENTENCE once and injects it
//     into every blocked turn, and hooks/compact-checkpoint.sh defines it once and
//     injects it into every PostCompact (scripts/test-hooks.sh asserts both
//     injections); this file holds each hook's copy byte-identical to the TS export,
//     so no surface can drift apart from the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REGROUND_SENTENCE } from "../src/worker.ts";
import { retryLead, buildWorkerPrompt } from "../src/loop.ts";
import { formatRescueLead, type Rescue } from "../src/rescue.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const HOOK = path.resolve(HERE, "..", "..", "..", "hooks", "stop-continuity.sh");
const COMPACT_HOOK = path.resolve(HERE, "..", "..", "..", "hooks", "compact-checkpoint.sh");

const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

test("a retry lead carries the re-grounding sentence, once, before the panel lead", () => {
  assert.equal(count(retryLead(undefined), REGROUND_SENTENCE), 1);
  const withPanel = retryLead("THEORY: the API moved. FIX: call the new endpoint.");
  assert.equal(count(withPanel, REGROUND_SENTENCE), 1);
  assert.ok(
    withPanel.indexOf(REGROUND_SENTENCE) < withPanel.indexOf("THEORY:"),
    "the attempt re-grounds before it reads the theory",
  );
});

test("a rescue lead carries the re-grounding sentence, once", () => {
  const rescue: Rescue = {
    approach: "walk the dependency graph instead of patching the parser",
    different: "the failed attempts all edited the parser in place",
    decision: { decision: "change of approach", why: "the parser is fine", reversal: "drop the lead" },
  };
  assert.equal(count(formatRescueLead(rescue), REGROUND_SENTENCE), 1);
  assert.equal(count(formatRescueLead(rescue, "THEORY: the loader is fine"), REGROUND_SENTENCE), 1);
});

test("a FIRST attempt does not re-ground — no earlier narration to distrust", () => {
  const first = buildWorkerPrompt("Build login", ["existing email + right password → 200"]);
  assert.equal(count(first, REGROUND_SENTENCE), 0);
});

test("the sentence has ONE definition on the TypeScript surface (src/worker.ts)", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(SRC);
  const carriers = files
    .map((f) => ({ file: path.relative(SRC, f), copies: count(fs.readFileSync(f, "utf8"), REGROUND_SENTENCE) }))
    .filter((x) => x.copies > 0);
  assert.deepEqual(
    carriers,
    [{ file: "worker.ts", copies: 1 }],
    "the sentence must appear exactly once in src/, in worker.ts — everywhere else imports it",
  );
});

// A compaction is the other continuation the run cannot refuse: the window wakes up
// behind a summary somebody else wrote. hooks/compact-checkpoint.sh answers PostCompact
// with the same sentence — a THIRD wording of "trust the tree, not the story" would be
// two sentences too many.
//
// MUTATION-VERIFIED: reword one clause of the hook's REGROUND_SENTENCE and this fails;
// paste a second copy of it into the hook and the count assertion fails.
test("the compaction hook re-grounds with the same words, defined once", () => {
  const hook = fs.readFileSync(COMPACT_HOOK, "utf8");
  assert.ok(
    hook.includes(`REGROUND_SENTENCE="${REGROUND_SENTENCE}"`),
    "hooks/compact-checkpoint.sh must define REGROUND_SENTENCE as exactly the TS sentence",
  );
  assert.equal(
    count(hook, REGROUND_SENTENCE), 1,
    "the hook must carry exactly one copy of the sentence (PostCompact goes through the variable)",
  );
});

test("the in-session hook re-grounds with the same words, defined once", () => {
  const hook = fs.readFileSync(HOOK, "utf8");
  assert.ok(
    hook.includes(`REGROUND_SENTENCE="${REGROUND_SENTENCE}"`),
    "hooks/stop-continuity.sh must define REGROUND_SENTENCE as exactly the TS sentence",
  );
  assert.equal(
    count(hook, REGROUND_SENTENCE), 1,
    "the hook must carry exactly one copy of the sentence (injection goes through the variable)",
  );
});
