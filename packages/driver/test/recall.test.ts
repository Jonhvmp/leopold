// Unit tests for the recall memory core (.leopold/runs archive → ranked excerpts).
// Hermetic: every archive is built in a temp dir, nothing reads the real repo or ~/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDecisions, searchRuns, renderRecall, tokenize, digestOf, DIGEST_MAX_BYTES, PAST_RUN_DATA_AUTHORITY, newestFirst } from "../src/recall.ts";

function tmpArchive(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "leopold-recall-"));
}

function writeRun(runsDir: string, run: string, files: Record<string, string>): void {
  const dir = path.join(runsDir, run);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

const DECISIONS_WITH_D2 = `# Decisions

Autonomous decisions, newest last.

## D1 — package naming   (turn 1, 2026-06-17T19:14:27Z)
Fork:        scoped vs unscoped npm name
Class:       reversible
Charter:     simplest for users
Decision:    name "leopold-driver"; unscoped
Why:         no org needed
Reversal:    rename in package.json

## D2 — storage engine   (turn 3, 2026-06-17T20:02:11Z)
Fork:        postgres or sqlite for the local ledger
Class:       reversible
Charter:     zero runtime dependencies
Decision:    sqlite via the stdlib driver — postgres needs a server the tool cannot
             assume; the ledger is single-writer local state
Why:         zero-dep line holds; one file beats one daemon
Reversal:    swap the storage adapter behind ledger.ts; schema is three tables
`;

test("parseDecisions reads the log.ts block format, continuations included", () => {
  const { blocks, malformed } = parseDecisions(DECISIONS_WITH_D2);
  assert.equal(malformed, false);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].id, "D2");
  assert.equal(blocks[1].title, "storage engine"); // "(turn 3, ...)" note stripped
  const decision = blocks[1].fields.find(([k]) => k === "Decision")?.[1];
  assert.match(decision ?? "", /single-writer local state$/); // wrapped line joined
});

test("parseDecisions: no headings at all is a valid empty trail, not malformed", () => {
  const { blocks, malformed } = parseDecisions("# Decisions\n\npreamble only\n");
  assert.equal(blocks.length, 0);
  assert.equal(malformed, false);
});

test("@scenario a query matching one run's D2 Decision ranks that block first, Reversal included", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260617T190000Z-dist", {
    "DECISIONS.md": DECISIONS_WITH_D2,
    "MISSION.md": "# Mission\n\nShip the driver package.\n",
  });
  writeRun(runs, "20260701T120000Z-other", {
    "DECISIONS.md": `# Decisions

## D1 — docs tone   (turn 2, 2026-07-01T12:30:00Z)
Fork:        formal vs plain docs voice
Class:       reversible
Charter:     honesty
Decision:    plain voice everywhere
Why:         reads faster
Reversal:    revert the docs commit
`,
  });

  const r = searchRuns(runs, "postgres sqlite");
  assert.equal(r.status, "ok");
  assert.equal(r.runsSearched, 2);
  assert.ok(r.hits.length >= 1);
  assert.equal(r.hits[0].run, "20260617T190000Z-dist");
  assert.equal(r.hits[0].file, "DECISIONS.md");
  assert.match(r.hits[0].ref, /^D2 — storage engine$/);
  assert.match(r.hits[0].reversal ?? "", /swap the storage adapter/);
  assert.match(r.hits[0].excerpt, /Decision: sqlite via the stdlib driver/);
});

test("@scenario the same tokens in prose vs in a Decision field: the Decision-field hit outranks", () => {
  const runs = tmpArchive();
  // NEWER run carries the tokens only in prose; the OLDER run carries them in a
  // Decision field. Field weighting must beat both prose weight and recency.
  writeRun(runs, "20260601T000000Z-decider", {
    "DECISIONS.md": `# Decisions

## D1 — cache layer   (turn 1, 2026-06-01T01:00:00Z)
Fork:        where to cache manifests
Class:       reversible
Charter:     simplicity
Decision:    memoize the manifest parse in process
Why:         avoids duplicate work
Reversal:    drop the memo map
`,
  });
  writeRun(runs, "20260801T000000Z-proser", {
    "MISSION.md": "We could memoize the manifest parse someday.\n",
    "PLAN.md": "- [ ] maybe memoize the manifest parse\n",
  });

  const r = searchRuns(runs, "memoize manifest parse");
  assert.equal(r.status, "ok");
  assert.equal(r.hits[0].run, "20260601T000000Z-decider");
  assert.equal(r.hits[0].file, "DECISIONS.md");
  const proseHit = r.hits.find((h) => h.run === "20260801T000000Z-proser");
  assert.ok(proseHit, "prose lines are still indexed");
  assert.ok(r.hits[0].score > (proseHit?.score ?? 0));
});

test("newer run outranks older when the match is equal", () => {
  const runs = tmpArchive();
  const block = (ts: string) => `# Decisions

## D1 — retry policy   (turn 1, ${ts})
Fork:        retry or fail fast
Class:       reversible
Charter:     never degrade silently
Decision:    retry once then surface the error
Why:         transient network blips
Reversal:    set retries to zero
`;
  writeRun(runs, "20260101T000000Z-old", { "DECISIONS.md": block("2026-01-01T00:00:00Z") });
  writeRun(runs, "20260801T000000Z-new", { "DECISIONS.md": block("2026-08-01T00:00:00Z") });

  const r = searchRuns(runs, "retry policy");
  assert.equal(r.hits[0].run, "20260801T000000Z-new");
  assert.equal(r.hits[1].run, "20260101T000000Z-old");
  assert.equal(r.hits[0].score, r.hits[1].score);
});

test("@scenario an empty or missing runs dir: a typed no-archive result, never a throw", () => {
  const missing = searchRuns(path.join(tmpArchive(), "does-not-exist"), "anything");
  assert.equal(missing.status, "no_archive");
  assert.equal(missing.runsSearched, 0);
  assert.deepEqual(missing.hits, []);

  const emptyDir = tmpArchive(); // exists, zero run subdirs
  const empty = searchRuns(emptyDir, "anything");
  assert.equal(empty.status, "no_archive");

  assert.match(renderRecall(missing, "anything"), /no archived runs/);
});

test("runs exist but nothing matches: no_matches, said out loud", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260601T000000Z-a", { "DECISIONS.md": DECISIONS_WITH_D2 });
  const r = searchRuns(runs, "zzzqqq nonexistent");
  assert.equal(r.status, "no_matches");
  assert.equal(r.runsSearched, 1);
  assert.match(renderRecall(r, "zzzqqq nonexistent"), /no matches .* 1 archived run/);
});

test("@scenario a malformed DECISIONS.md in one run is skipped with a warning; other runs still searched", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260501T000000Z-broken", {
    "DECISIONS.md": "# Decisions\n\n## not a decision heading\nsome retry text with no fields\n",
  });
  writeRun(runs, "20260601T000000Z-good", {
    "DECISIONS.md": `# Decisions

## D1 — retry policy   (turn 1, 2026-06-01T00:00:00Z)
Fork:        retry or fail fast
Class:       reversible
Charter:     never degrade silently
Decision:    retry once then surface the error
Why:         transient blips
Reversal:    set retries to zero
`,
  });

  const r = searchRuns(runs, "retry");
  assert.equal(r.status, "ok");
  assert.equal(r.hits[0].run, "20260601T000000Z-good");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].run, "20260501T000000Z-broken");
  assert.equal(r.warnings[0].file, "DECISIONS.md");
  assert.match(r.warnings[0].reason, /malformed/);
  assert.match(renderRecall(r, "retry"), /warning: 20260501T000000Z-broken\/DECISIONS\.md skipped/);
});

test("@scenario the same query twice is byte-identical (stable sort, no wall-clock in the body)", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260617T190000Z-dist", {
    "DECISIONS.md": DECISIONS_WITH_D2,
    "MISSION.md": "sqlite is mentioned here too\n",
    "events.jsonl": '{"ts":"2026-06-17T19:00:00Z","event":"item_start","item":"sqlite ledger"}\n',
  });
  writeRun(runs, "20260701T120000Z-other", {
    "PLAN.md": "- [x] wire the sqlite ledger\n",
  });

  const a = searchRuns(runs, "sqlite ledger");
  const b = searchRuns(runs, "sqlite ledger");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(renderRecall(a, "sqlite ledger"), renderRecall(b, "sqlite ledger"));
  // The rendered body carries no generation-time timestamp: rendering later must
  // not change a byte. (Archive-derived text is constant by definition.)
  const now = new Date().toISOString().slice(0, 13); // current hour, e.g. "2026-08-18T14"
  assert.ok(!renderRecall(a, "sqlite ledger").includes(now));
});

test("ranked output is capped by limit", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260601T000000Z-a", {
    "MISSION.md": Array.from({ length: 20 }, (_, i) => `ledger line ${i}`).join("\n") + "\n",
  });
  const r = searchRuns(runs, "ledger", 3);
  assert.equal(r.hits.length, 3);
});

test("tokenize lowercases, splits, dedupes and drops single-char noise", () => {
  assert.deepEqual(tokenize("SQLite, sqlite! a b12"), ["sqlite", "b12"]);
});

// -- The run-start digest ---------------------------------------------------------

function decisionsWith(...blocks: Array<{ id: string; title: string; persona?: string; decision: string; reversal?: string }>): string {
  const body = blocks
    .map((b) =>
      [
        `## ${b.id} — ${b.title}   (turn 1, 2026-01-01T00:00:00Z)`,
        `Fork:        a fork`,
        ...(b.persona ? [`Persona:     ${b.persona}`] : []),
        `Class:       reversible`,
        `Decision:    ${b.decision}`,
        `Why:         because`,
        ...(b.reversal ? [`Reversal:    ${b.reversal}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
  return `# Decisions\n\n${body}\n`;
}

test("@scenario a project with 3 archived runs → the digest lists their newest decisions with Reversals, newest first", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260601T000000Z-first", {
    "DECISIONS.md": decisionsWith({ id: "D1", title: "oldest call", persona: "pragmatist", decision: "keep it flat", reversal: "nest it back" }),
  });
  writeRun(runs, "20260701T000000Z-second", {
    "DECISIONS.md": decisionsWith(
      { id: "D1", title: "early call", decision: "use tabs", reversal: "spaces" },
      { id: "D2", title: "storage engine", persona: "minimalist", decision: "sqlite via stdlib", reversal: "swap the adapter" },
    ),
  });
  writeRun(runs, "20260801T000000Z-third", {
    "DECISIONS.md": decisionsWith({ id: "D1", title: "docs voice", decision: "plain voice", reversal: "revert the docs commit" }),
  });

  const d = digestOf(runs);
  // Newest run's decision first; inside a run the LAST block is the newest.
  const order = [
    d.indexOf("[20260801T000000Z-third] D1 — docs voice"),
    d.indexOf("[20260701T000000Z-second] D2 — storage engine (minimalist)"),
    d.indexOf("[20260701T000000Z-second] D1 — early call"),
    d.indexOf("[20260601T000000Z-first] D1 — oldest call (pragmatist)"),
  ];
  for (const i of order) assert.ok(i >= 0, `missing entry at expected position (digest:\n${d})`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(d, /Reversal: revert the docs commit/);
  assert.match(d, /Reversal: swap the adapter/);
  assert.ok(!d.includes("truncated"), "nothing over the cap, so no truncation line");
});

test("@scenario more decisions than the cap → oldest dropped and the digest says how many, naming leopold recall", () => {
  const runs = tmpArchive();
  const many = Array.from({ length: 11 }, (_, i) => ({
    id: `D${i + 1}`,
    title: `call ${i + 1}`,
    decision: `decision number ${i + 1}`,
    reversal: `undo ${i + 1}`,
  }));
  writeRun(runs, "20260601T000000Z-many", { "DECISIONS.md": decisionsWith(...many) });

  const d = digestOf(runs); // default cap: 8 decisions
  assert.match(d, /D11 — call 11/); // newest kept
  assert.ok(!d.includes("D1 — call 1\n") && !/\bD3 —/.test(d), "oldest dropped first");
  assert.match(d, /\(3 older decisions truncated — run `leopold recall <query>` for more\.\)/);
});

test("digest byte cap drops oldest first and stays under the cap, truncation line included", () => {
  const runs = tmpArchive();
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `D${i + 1}`,
    title: `call ${i + 1}`,
    decision: `decision ${"x".repeat(120)} number ${i + 1}`,
    reversal: `undo ${i + 1}`,
  }));
  writeRun(runs, "20260601T000000Z-many", { "DECISIONS.md": decisionsWith(...many) });

  const d = digestOf(runs, { maxBytes: 900 });
  assert.ok(Buffer.byteLength(d, "utf8") <= 900, `digest is ${Buffer.byteLength(d, "utf8")} bytes`);
  assert.match(d, /D6 — call 6/); // newest always kept
  assert.match(d, /older decisions? truncated — run `leopold recall <query>` for more\./);
});

test("one oversized Decision field cannot defeat the byte cap: the single entry is clamped", () => {
  // A trail is agent-written and a Decision field is unbounded — the cap must hold
  // even when the NEWEST decision alone is bigger than the whole budget.
  const runs = tmpArchive();
  writeRun(runs, "20260601T000000Z-huge", {
    "DECISIONS.md": decisionsWith({
      id: "D1",
      title: "the one that never ends",
      decision: `unbounded ${"x".repeat(10_000)} end`,
      reversal: "delete it",
    }),
  });

  const capped = digestOf(runs, { maxBytes: 900 });
  assert.ok(
    Buffer.byteLength(capped, "utf8") <= 900,
    `digest is ${Buffer.byteLength(capped, "utf8")} bytes — the cap must hold for a single oversized entry too`,
  );
  assert.match(capped, /D1 — the one that never ends/); // the entry is clamped, not dropped
  assert.ok(capped.includes("…"), "the clamp is visible: the cut entry ends in an ellipsis");
  assert.ok(capped.includes(PAST_RUN_DATA_AUTHORITY), "the framing header survives the clamp");

  // The default cap holds too, and clamping never splits a UTF-8 code point.
  const dflt = digestOf(runs);
  assert.ok(Buffer.byteLength(dflt, "utf8") <= DIGEST_MAX_BYTES,
    `digest is ${Buffer.byteLength(dflt, "utf8")} bytes — over DIGEST_MAX_BYTES`);
  assert.ok(!dflt.includes("�"), "no replacement character: the clamp respects code points");
});

test("an oversized first entry is clamped and the older entries behind it are counted as truncated", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260601T000000Z-mixed", {
    "DECISIONS.md": decisionsWith(
      { id: "D1", title: "older small call", decision: "keep it flat", reversal: "nest it" },
      { id: "D2", title: "newest huge call", decision: `huge ${"y".repeat(5_000)} end`, reversal: "undo it" },
    ),
  });
  const d = digestOf(runs, { maxBytes: 900 });
  assert.ok(Buffer.byteLength(d, "utf8") <= 900, `digest is ${Buffer.byteLength(d, "utf8")} bytes`);
  assert.match(d, /D2 — newest huge call/); // newest kept (clamped) — never the oldest instead
  assert.match(d, /\(1 older decision truncated — run `leopold recall <query>` for more\.\)/);
});

test("digest is deterministic: same archive, byte-identical digest", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS_WITH_D2 });
  assert.equal(digestOf(runs), digestOf(runs));
});

test("@scenario no archived runs → no digest block at all", () => {
  assert.equal(digestOf(path.join(tmpArchive(), "does-not-exist")), "");
  // An archive dir with runs but no decisions is also digest-less.
  const runs = tmpArchive();
  writeRun(runs, "20260601T000000Z-empty", { "MISSION.md": "# Mission\n" });
  assert.equal(digestOf(runs), "");
});

test("@scenario the digest text carries the untrusted-content framing sentence verbatim", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260617T190000Z-dist", { "DECISIONS.md": DECISIONS_WITH_D2 });
  assert.ok(digestOf(runs).includes(PAST_RUN_DATA_AUTHORITY));
});

test("digest skips a malformed or unreadable trail without throwing", () => {
  const runs = tmpArchive();
  writeRun(runs, "20260501T000000Z-broken", { "DECISIONS.md": "## not a block\n\nno fields here\n" });
  writeRun(runs, "20260601T000000Z-good", { "DECISIONS.md": DECISIONS_WITH_D2 });
  const d = digestOf(runs);
  assert.match(d, /D2 — storage engine/);
  assert.ok(!d.includes("broken"));
});

// A hand-named archive dir (no ISO-stamp prefix) must never win recency by alphabet:
// this repo's own archive carries `canvas-2026-07-08`, and 'c' > '2' would have made
// it the "newest" run in every digest and every recency tie, forever.
test("a non-timestamp-named run dir never outranks stamped runs on recency", () => {
  const order = newestFirst(["canvas-2026-07-08", "20260805T210918Z-old", "20260818T074740Z-new"]);
  assert.deepEqual(order, ["20260818T074740Z-new", "20260805T210918Z-old", "canvas-2026-07-08"]);
  // Determinism among unstamped names: byte order, stable.
  assert.deepEqual(newestFirst(["zeta", "alpha"]), ["zeta", "alpha"].sort().reverse());
});

// The template's commented-out example must never become memory. A project that copies
// templates/DECISIONS.md verbatim archives the <!-- Example --> block; parsing it as a
// real decision would seed "this project already decided: in-memory map with a TTL"
// into every future run's digest — fabricated memory, the worst failure this module has.
test("HTML-commented example blocks are never parsed as decisions (the real template as fixture)", () => {
  const template = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "templates", "DECISIONS.md"), "utf8");
  assert.ok(template.includes("in-memory map with a TTL"), "the template still carries the example this test guards against");
  const { blocks } = parseDecisions(template);
  assert.deepEqual(blocks, [], "a commented-out example parsed as a real decision — memory poisoning");
  // ...and a real block AFTER a comment still parses.
  const mixed = template + "\n## D1 — Real call   (turn 1, 2026-08-18T00:00:00Z)\nDecision:    ship it\nReversal:    revert the commit\n";
  const real = parseDecisions(mixed).blocks;
  assert.equal(real.length, 1);
});

// A single-pass strip is not a strip: removing one comment can splice the fragments
// around it into a fresh `<!--`, and an unclosed `<!--` comments out everything after
// it in rendered markdown. Both must parse the way a renderer displays them.
test("comment stripping survives spliced markers — one pass is not enough", () => {
  const spliced = [
    "## D1 — Real call",
    "Decision:    keep",
    "<!<!-- inner -->--",
    "## D9 — Ghost from the spliced comment",
    "Decision:    poison",
    "-->",
  ].join("\n");
  const { blocks } = parseDecisions(spliced);
  assert.deepEqual(blocks.map((b) => b.id), ["D1"], "a comment spliced together by the first strip pass leaked its contents as a decision");
});

test("an unclosed <!-- comments out the rest of the file, exactly as rendered", () => {
  const dangling = [
    "## D1 — Real call",
    "Decision:    keep",
    "<!--",
    "## D9 — Ghost after the dangling comment",
    "Decision:    poison",
  ].join("\n");
  const { blocks } = parseDecisions(dangling);
  assert.deepEqual(blocks.map((b) => b.id), ["D1"], "text after an unclosed <!-- parsed as a decision — a renderer would never show it");
});
