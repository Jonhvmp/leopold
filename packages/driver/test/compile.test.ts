// The brief→workflow compiler: dependency waves, risk classification of each item,
// resumed-plan handling, and cycle detection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileBrief, wavesOf } from "../src/compile.ts";
import { parsePlan } from "../src/plan.ts";

const CHARTER = "Be pragmatic.";

test("independent items land in one wave; dependents cascade into later waves", () => {
  const plan = `# Plan
- [ ] First thing
- [ ] Second thing
- [ ] (after: 1) Third depends on first
- [ ] (after: 3) Fourth depends on third`;
  const c = compileBrief({ mission: "m", charter: CHARTER, planText: plan });
  assert.equal(c.waves.length, 3);
  assert.deepEqual(c.waves[0].map((i) => i.id), ["i1", "i2"]);
  assert.deepEqual(c.waves[1].map((i) => i.id), ["i3"]);
  assert.deepEqual(c.waves[2].map((i) => i.id), ["i4"]);
});

test("each item is risk-classified (effort + critical + sensitive)", () => {
  const plan = `# Plan
- [ ] Fix a typo in the readme
- [ ] Add Stripe billing to the checkout flow
- [ ] Migrate the users table schema`;
  const c = compileBrief({ mission: "m", charter: CHARTER, planText: plan });
  const flat = c.waves.flat();
  const typo = flat.find((i) => i.text.includes("typo"))!;
  const billing = flat.find((i) => i.text.includes("Stripe"))!;
  const migrate = flat.find((i) => i.text.includes("Migrate"))!;
  assert.equal(typo.effort, "low");
  assert.equal(typo.critical, false);
  assert.equal(billing.critical, true);
  assert.equal(billing.sensitive, true);
  assert.equal(migrate.effort, "max"); // sharp-edge critical
});

test("done items are skipped but still satisfy dependencies", () => {
  const plan = `# Plan
- [x] Already done groundwork
- [ ] (after: 1) Build on it`;
  const c = compileBrief({ mission: "m", charter: CHARTER, planText: plan });
  assert.equal(c.waves.length, 1);
  assert.deepEqual(c.waves[0].map((i) => i.id), ["i2"]);
});

test("maxReviewRounds is read from guardrails, default 2", () => {
  const plan = "# Plan\n- [ ] x";
  assert.equal(compileBrief({ mission: "m", charter: "", planText: plan }).maxReviewRounds, 2);
  assert.equal(compileBrief({ mission: "m", charter: "", guardrails: "max_review_rounds: 4", planText: plan }).maxReviewRounds, 4);
});

test("a dependency cycle is rejected, not silently dropped", () => {
  // parsePlan only keeps deps that reference EARLIER items, so a true forward cycle
  // can't be expressed; an unsatisfiable dep (referencing a done-less missing index
  // via manual construction) is what wavesOf must catch. Simulate with a hand-built graph.
  const node = { kind: "work" as const, kindLabel: "", routes: [], emits: [], needs: [] };
  const items = [
    { index: 1, text: "a", done: false, deps: [2], scenarios: [], ...node }, // waits on a later item → unsatisfiable
    { index: 2, text: "b", done: false, deps: [1], scenarios: [], ...node },
  ];
  assert.throws(() => wavesOf(items), /cycle|unsatisfiable/i);
});

test("an empty plan is a compile error", () => {
  assert.throws(() => compileBrief({ mission: "m", charter: "", planText: "# Plan\n(no items)" }), /no checkbox items/i);
});

// --- issue #60: the compiler must ship the whole item, or refuse to ship at all -------

test("wrapped done-when prose and @scenario lines survive compilation", () => {
  const plan =
    "- [ ] Register the JSON flag — done when: the CLI emits valid JSON on stdout\n" +
    "      and the table keeps printing unchanged without the flag.\n" +
    "      @scenario no flag → the table prints unchanged\n" +
    "      @scenario flag set → stdout is valid JSON\n";
  const c = compileBrief({ mission: "m", charter: CHARTER, planText: plan });
  const it = c.waves[0][0];
  assert.equal(
    it.text,
    "Register the JSON flag — done when: the CLI emits valid JSON on stdout and the table keeps printing unchanged without the flag.",
    "the wrapped sentence must arrive whole — a worker prompted with a mid-sentence fragment guesses the acceptance criteria",
  );
  assert.deepEqual(it.scenarios, ["no flag → the table prints unchanged", "flag set → stdout is valid JSON"],
    "scenarios are load-bearing: without them conformance passes vacuously");
});

test("an item with no scenarios compiles with an empty list, nothing else changed", () => {
  const c = compileBrief({ mission: "m", charter: CHARTER, planText: "- [ ] Plain item\n" });
  assert.deepEqual(c.waves[0][0].scenarios, []);
  assert.equal(c.waves[0][0].text, "Plain item");
});
