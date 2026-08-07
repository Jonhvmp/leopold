// The docs are executable, or they are fiction.
//
// docs/reference/plan-grammar.md is where a human learns to write a routing plan. This
// suite runs the worked example STRAIGHT OUT OF THAT PAGE — parsed from the markdown,
// never re-typed here — through the exact functions the scheduler uses: parsePlan,
// buildGraph, validateGraph, routeDecision. If the page and the engine ever disagree,
// this fails, because there is no second copy to drift.
//
// It also holds the reference to its promise: every construct of the grammar appears
// on the page with an example, the pt-BR twin carries the SAME worked example byte for
// byte, and the shipped templates/PLAN.md is itself a valid graph.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan } from "../src/plan.ts";
import { buildGraph, validateGraph, routeDecision } from "../src/graph.ts";

const REPO = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const EN = path.join(REPO, "docs", "reference", "plan-grammar.md");
const PT = path.join(REPO, "docs", "reference", "plan-grammar.pt-BR.md");

/** The markdown fences on the page, in order, for a given info string. */
function fences(doc: string, lang: string): string[] {
  const re = new RegExp("```" + lang + "\\r?\\n([\\s\\S]*?)```", "g");
  return [...doc.matchAll(re)].map((m) => m[1]);
}

/** The worked example: the one fenced markdown block on the page that is a whole plan
 *  (it is the only one starting with a `# Plan` heading). */
function workedExample(doc: string): string {
  const whole = fences(doc, "markdown").filter((b) => b.trimStart().startsWith("# Plan"));
  assert.equal(whole.length, 1, "the page must carry exactly one worked example plan");
  return whole[0];
}

const enDoc = fs.readFileSync(EN, "utf8");
const ptDoc = fs.readFileSync(PT, "utf8");
const EXAMPLE = workedExample(enDoc);

test("every construct of the grammar is documented with an example", () => {
  for (const construct of [
    "(after:", "@scenario", "@node", "@work", "@gate", "@verify", "@tool", "@human",
    "@feedback", "@emit", "@needs", "@on",
  ]) {
    assert.ok(enDoc.includes(construct), `the reference never shows ${construct}`);
    assert.ok(ptDoc.includes(construct), `the pt-BR reference never shows ${construct}`);
  }
  // An example, not just a mention: each one appears inside a fenced block too.
  const code = [...fences(enDoc, "markdown"), ...fences(enDoc, "text")].join("\n");
  for (const construct of ["(after:", "@scenario", "@gate", "@tool", "@human", "@emit", "@needs", "@on"]) {
    assert.ok(code.includes(construct), `${construct} is mentioned but never shown in an example`);
  }
});

test("the pt-BR twin carries the same worked example, character for character", () => {
  assert.equal(workedExample(ptDoc), EXAMPLE, "the translated page's example drifted from the English one");
});

test("the documented worked example parses into the graph the page describes", () => {
  const items = parsePlan(EXAMPLE);
  assert.equal(items.length, 7, "the worked example is a seven-item plan");
  assert.deepEqual(
    items.map((i) => i.kind),
    ["work", "tool", "verify", "gate", "work", "feedback", "human"],
    "the example must exercise every node kind the page documents",
  );
  assert.equal(items[0].scenarios.length, 2);
  assert.deepEqual(items[1].deps, [1]);
  assert.equal(items[1].text, "make migrate", "a @tool node's text is the command, word for word");
  assert.equal(items[3].kindLabel, "release");
  assert.deepEqual(items[2].emits, [
    { key: "migrated", value: "true" },
    { key: "migrated", value: "false" },
  ]);
  assert.deepEqual(items[6].needs, ["migrated"]);
  assert.deepEqual(
    items[1].routes.map((r) => [r.when, r.target]),
    [["exit=0", 3], ["exit!=0", 5]],
  );
});

test("the documented worked example is a sound graph — leopold graph would exit 0", () => {
  const graph = buildGraph(parsePlan(EXAMPLE));
  assert.deepEqual(
    validateGraph(graph).map((d) => d.message),
    [],
    "the plan printed in the docs must validate clean",
  );
});

test("the documented worked example actually routes, both ways", () => {
  const graph = buildGraph(parsePlan(EXAMPLE));

  // The command failed: control goes to the rollback, and the verify branch is skipped.
  const failed = routeDecision(graph, [1, 2], { signals: { exit: "1" } });
  assert.deepEqual(failed.taken, [{ from: 2, to: 5, when: "exit!=0" }]);
  assert.deepEqual(failed.dispatch, [5], "only the rollback runs when the migration fails");
  assert.ok(failed.bypassed.includes(3), "the verify branch is bypassed");

  // The command succeeded: the verify node runs and the rollback is bypassed.
  const ok = routeDecision(graph, [1, 2], { signals: { exit: "0" } });
  assert.deepEqual(ok.dispatch, [3], "only the proof branch runs when the migration lands");
  assert.ok(ok.bypassed.includes(5), "the rollback is bypassed");

  // The proof node says the schema is wrong: back to the rollback, gate skipped.
  const unproven = routeDecision(graph, [1, 2, 3], { signals: { exit: "0", migrated: "false" } });
  assert.deepEqual(unproven.dispatch, [5], "a failed proof routes to the rollback");
  assert.ok(unproven.bypassed.includes(4), "the release gate is bypassed");

  // The proof node is happy: the gate runs, and the human node waits for its signal.
  const proven = routeDecision(graph, [1, 2, 3], { signals: { exit: "0", migrated: "true" } });
  assert.deepEqual(proven.dispatch, [4], "a passing proof continues to the release gate");
  const late = routeDecision(graph, [1, 2, 3, 4, 6], { signals: { exit: "0", migrated: "true" } });
  assert.deepEqual(late.dispatch, [7], "the human node runs once its @needs signal is on the channel");
  assert.deepEqual(
    routeDecision(graph, [1, 2, 3, 4, 6], { signals: { exit: "0" } }).dispatch,
    [],
    "@needs holds the human node back while its signal is missing",
  );
});

test("the shipped templates/PLAN.md is itself a valid graph", () => {
  const template = fs.readFileSync(path.join(REPO, "templates", "PLAN.md"), "utf8");
  const items = parsePlan(template);
  assert.ok(items.length >= 3, "the template must still carry example items");
  assert.deepEqual(validateGraph(buildGraph(items)).map((d) => d.message), []);
});
