// Personas: the role Leopold synthesizes when it reaches work that used to wait for a
// person.
//
// Two halves, and the tests treat them very differently — because only one of them is a
// model call:
//
//   the FIT is synthesized     so what is asserted here is the FRAME (the item and the
//                              charter actually reach the synthesis call, and the call
//                              demands a role fitted to the item), that a fitted answer
//                              survives intact, and that a generic one is REFUSED in
//                              code rather than dressed up as an expert;
//   the CONSTRAINTS are not    so they are asserted absolutely: the charter's binding
//                              lines are in every persona, verbatim, whatever the model
//                              wrote — and identically across two syntheses.
//
// Every test here is zero-spend: the sdk.ts seam is swapped for a fake.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { setQuery, resetQuery } from "../src/sdk.ts";
import {
  synthesizePersona, parsePersona, personaAppend, personaSystemPrompt, personaUserPrompt,
  personaDecisionFields, charterHardRules, roleKeyOf, MAX_CHARTER_RULES, FORK_SITUATION,
  parseDecisionBlock, DEFAULT_REVERSAL, DECISION_BLOCK_INSTRUCTION,
  type Persona, type PersonaInput,
} from "../src/persona.ts";
import type { Brief, DriverConfig } from "../src/types.ts";

// Deliberately written the way a real charter is written: bullets that WRAP, sections
// whose heading carries half the rule, and the prohibitions last. A fixture of tidy
// one-line bullets would pass a scanner that decapitates every wrapped rule and truncates
// before it ever reaches `## Never`.
const CHARTER = `# Charter

## What I optimize for
1. Trust before reach. The git lock is the boundary this product rests on. It
   does not move in this mission.
2. Ship the simplest thing that works.

## Technology and style
- No new infrastructure for the MVP.
- Prefer the 10-line obvious solution.

## Never
- Add an AI signature anywhere.
- Run git push, git tag or npm publish, or open an external PR on
  your own.
`;

const TRUST = "Trust before reach. The git lock is the boundary this product rests on. It does not move in this mission.";
const NO_PUSH = "Never: Run git push, git tag or npm publish, or open an external PR on your own.";

const brief = (charter = CHARTER): Brief => ({
  mission: "# Mission\nNothing halts: Leopold assumes the role and does the work.",
  charter,
  guardrails: "# Guardrails\n- max_iterations: 30\n",
  planPath: "/tmp/PLAN.md",
  root: "/tmp",
  leoDir: "/tmp/.leopold",
});

const cfg = { maxTurnsPerItem: 20 } as DriverConfig;

const ITEM: PersonaInput = {
  fork: "human",
  item: "@human Decide the visual hierarchy of the dashboard header",
  detail: "Three competing layouts; which one reads first?",
};

/** A fake harness that answers the synthesis call with `text`, capturing what it was
 *  asked. `text` may be a thrower or an empty stream to exercise the failure paths. */
function fakeQuery(text: string | (() => never)): { prompt: string; system: string } {
  const seen = { prompt: "", system: "" };
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    seen.prompt = typeof input.prompt === "string" ? input.prompt : "";
    seen.system = String(input.options?.systemPrompt ?? "");
    if (typeof text === "function") text();
    return (async function* () {
      if (text) yield { type: "assistant", message: { content: [{ type: "text", text }] } };
      yield { type: "result", result: text, total_cost_usd: 0 };
    })();
  }) as never);
  return seen;
}

const DESIGNER = JSON.stringify({
  name: "Mara Vance",
  role: "Senior Interaction Designer",
  expertise: ["visual hierarchy and typographic scale", "dashboard information density", "accessible contrast"],
  optimizesFor: ["the first thing a user reads is the thing that matters", "fewer competing focal points"],
  constraints: ["make it pretty"],
  rationale: "The item is a layout judgement, not an implementation choice.",
});

// --- the fit: the frame, and what survives it --------------------------------------

test("the synthesis call carries the item, the mission and the charter, and demands a fitted role", async () => {
  const seen = fakeQuery(DESIGNER);
  try {
    const p = await synthesizePersona(cfg, brief(), ITEM);
    assert.ok(p, "a fitted answer produces a persona");
    // The item and the actual fork reach the model — a role synthesized without them
    // would be generic by construction.
    assert.match(seen.prompt, /visual hierarchy of the dashboard header/);
    assert.match(seen.prompt, /Three competing layouts/);
    assert.ok(seen.prompt.includes(FORK_SITUATION.human));
    // …and so do the mission and the charter, which is where the taste comes from.
    assert.match(seen.system, /Nothing halts: Leopold assumes the role/);
    assert.match(seen.system, /No new infrastructure for the MVP\./);
    // The frame asks for a person, not "an agent", and states what the role may never do.
    assert.match(seen.system, /"An assistant", "an agent", "an engineer" is not a persona/);
    assert.match(seen.system, /git commit, git push, git tag, publish/);
    // It is not asked to restate the charter's rules, because what it wrote there would
    // be thrown away: the rules are attached in code.
    assert.ok(!seen.system.includes('"constraints"'));
  } finally { resetQuery(); }
});

test("an item about visual hierarchy yields a persona whose expertise is design", async () => {
  const seen = fakeQuery(DESIGNER);
  try {
    const p = (await synthesizePersona(cfg, brief(), ITEM))!;
    assert.equal(p.name, "Mara Vance");
    assert.equal(p.role, "Senior Interaction Designer");
    assert.equal(p.roleKey, "designer-interaction", "the fit, normalized past its wording");
    assert.deepEqual(p.expertise, [
      "visual hierarchy and typographic scale",
      "dashboard information density",
      "accessible contrast",
    ]);
    assert.deepEqual(p.optimizesFor, [
      "the first thing a user reads is the thing that matters",
      "fewer competing focal points",
    ]);
    assert.equal(p.fork, "human");
    assert.match(p.item, /visual hierarchy of the dashboard header/);
    // And the assumed prompt is that person, not a generic worker with a hat on.
    const append = personaAppend(p);
    assert.match(append, /YOU ARE MARA VANCE — Senior Interaction Designer\./);
    assert.match(append, /visual hierarchy and typographic scale/);
    assert.match(append, /No human is coming; you have the seat/);
  } finally { resetQuery(); }
});

test('"an assistant" is refused as a persona instead of being dressed up as one', () => {
  for (const role of ["assistant", "AI assistant", "Agent", "an agent", "expert", "Software Engineer", "leopold"]) {
    const answer = JSON.stringify({ name: "Alex", role, expertise: ["doing things well"] });
    assert.equal(parsePersona(answer, ITEM, CHARTER), undefined, role);
  }
  // A role that names a real discipline is not caught by that net.
  assert.ok(parsePersona(JSON.stringify({ name: "Alex", role: "Release Engineer", expertise: ["cutovers"] }), ITEM, CHARTER));
});

// --- the constraints: proven, not hoped for -----------------------------------------

test("the charter's hard rules bind the persona VERBATIM, whatever the model wrote", async () => {
  // The model returns a persona with an EMPTY constraints list. The charter still binds.
  const noConstraints = JSON.stringify({
    name: "Ivo Bell", role: "Platform Engineer", expertise: ["data cutovers"], constraints: [],
  });
  fakeQuery(noConstraints);
  try {
    const p = (await synthesizePersona(cfg, brief(), { fork: "escalation", item: "Choose Postgres or SQLite" }))!;
    assert.ok(p.constraints.includes("No new infrastructure for the MVP."),
      "the constraint appears verbatim in the binding rules");
    assert.ok(p.constraints.includes(NO_PUSH));
    assert.ok(p.constraints.includes(TRUST), "and a rule that wrapped over two lines arrives whole");
    // And they are in the prompt the persona actually runs under, as binding rules.
    const append = personaAppend(p);
    assert.match(append, /YOU ARE BOUND BY THESE RULES/);
    assert.ok(append.includes("  - No new infrastructure for the MVP."));
  } finally { resetQuery(); }
});

test("what the model writes under constraints is discarded, not merged", () => {
  // A model that invents a rule ("make it pretty") cannot add one, and a model that
  // paraphrases a real one cannot soften it: the list is the charter's, lifted in code.
  const p = parsePersona(DESIGNER, ITEM, CHARTER)!;
  assert.deepEqual(p.constraints, charterHardRules(CHARTER));
  assert.ok(!p.constraints.includes("make it pretty"));
  const softened = JSON.stringify({
    name: "Ada", role: "Release Engineer", expertise: ["cutovers"],
    constraints: ["git push is usually best avoided"],
  });
  assert.deepEqual(parsePersona(softened, ITEM, CHARTER)!.constraints, charterHardRules(CHARTER));
});

test("charterHardRules lifts rules verbatim and ignores prose that binds nothing", () => {
  const rules = charterHardRules(CHARTER);
  assert.deepEqual(rules, [
    TRUST,
    "No new infrastructure for the MVP.",
    "Never: Add an AI signature anywhere.",
    NO_PUSH,
  ]);
  // These state no rule and sit under no rule heading, so neither binds anything.
  assert.ok(!rules.some((r) => r.includes("simplest thing")));
  assert.ok(!rules.some((r) => r.includes("10-line")));
  // A charter with no rules at all binds nothing, and does not crash.
  assert.deepEqual(charterHardRules("# Charter\n\nWe like good software.\n"), []);
  assert.deepEqual(charterHardRules(""), []);
});

test("a rule that wraps is ONE rule, never a rule plus a decapitated fragment", () => {
  // The bug this catches: scanning physical lines, the first line of a wrapped bullet
  // often carries no rule word ("1. Trust before reach. The git lock is the boundary")
  // and is dropped, while its continuation ("does not move in this mission") matches and
  // is lifted as a binding rule — a sentence half, with its subject gone.
  const rules = charterHardRules(CHARTER);
  assert.ok(rules.includes(TRUST));
  for (const r of rules) {
    assert.ok(!/^does not move/i.test(r), `orphan fragment lifted as a rule: ${r}`);
    assert.ok(!/^your own/i.test(r), `orphan fragment lifted as a rule: ${r}`);
  }
  // A continuation line that would qualify on its own does not become a second rule.
  assert.equal(rules.filter((r) => r.includes("does not move")).length, 1);
  // Wrapping is not special to bullets: a wrapped paragraph is one rule too.
  assert.deepEqual(
    charterHardRules("# Charter\n\nThe deploy key is locked and\nnothing may unlock it.\n"),
    ["The deploy key is locked and nothing may unlock it."],
  );
});

test("a rule under a negating heading carries the heading's polarity", () => {
  // Lifted bare under "YOU ARE BOUND BY THESE RULES", "Run git push, git tag or npm
  // publish." is an INSTRUCTION to run it. The heading is half the rule.
  const rules = charterHardRules(CHARTER);
  assert.ok(rules.includes("Never: Add an AI signature anywhere."));
  assert.ok(!rules.includes("Add an AI signature anywhere."), "never bare, that inverts it");
  assert.ok(!rules.some((r) => /^Run git push/.test(r)));
  // …and it survives into the prompt the persona is actually bound by.
  const append = personaAppend(parsePersona(DESIGNER, ITEM, CHARTER)!);
  assert.ok(append.includes("  - Never: Add an AI signature anywhere."));
  assert.ok(!/\n {2}- Run git push/.test(append));
  // Other polarities are labelled the same way; a neutral heading is left alone.
  assert.deepEqual(charterHardRules("## Always\n- Stage and report.\n"), ["Always: Stage and report."]);
  assert.deepEqual(charterHardRules("## Non-goals\n- Rewrite the scheduler.\n"), ["Non-goal: Rewrite the scheduler."]);
  assert.deepEqual(charterHardRules("## Hard rules\n- The git lock holds.\n"), ["The git lock holds."]);
});

test("the cap drops heuristic prose before it drops a declared rule", () => {
  // The bug this catches: capping in document order on a charter that puts `## Never`
  // last keeps the style preferences and silently loses every prohibition.
  const prose = Array.from({ length: MAX_CHARTER_RULES }, (_, i) => `- Style note ${i}: never skip it.`).join("\n");
  const charter = `# Charter\n\n## Technology and style\n${prose}\n\n## Never\n- Run git push.\n- Clear the kill switch.\n`;
  const rules = charterHardRules(charter);
  assert.equal(rules.length, MAX_CHARTER_RULES);
  assert.ok(rules.includes("Never: Run git push."), "the prohibition survives the cap");
  assert.ok(rules.includes("Never: Clear the kill switch."));
  // Document order is preserved among the survivors — a charter's order is its priority.
  assert.equal(rules[0], "Style note 0: never skip it.");
  assert.equal(rules.at(-1), "Never: Clear the kill switch.");
  // The cap is a ceiling, not a filter that reorders.
  const many = "## Never\n" + Array.from({ length: MAX_CHARTER_RULES + 10 }, (_, i) => `- rule number ${i}`).join("\n");
  const capped = charterHardRules(many);
  assert.equal(capped.length, MAX_CHARTER_RULES);
  assert.equal(capped[0], "Never: rule number 0");
});

test("this project's OWN charter binds a persona with its actual hard prohibitions", () => {
  // The done condition is that a persona "provably carries the charter's hard rules". The
  // proof has to be against a real charter — wrapped bullets, prohibitions last — not a
  // fixture shaped to suit the scanner.
  const charter = readFileSync(new URL("../../../.leopold/CHARTER.md", import.meta.url), "utf8");
  const rules = charterHardRules(charter);
  for (const must of [
    "Run `git push`, `git tag`, `npm publish`, or open an external PR.",
    "**Let a persona edit GUARDRAILS.md, raise a budget, or clear the kill switch.**",
    "Ship a claim the tests do not back.",
  ]) {
    assert.ok(rules.includes("Never: " + must), `the charter's own prohibition is missing: ${must}`);
  }
  assert.ok(rules.some((r) => r.startsWith("Always: Keep git LOCKED")));
  // And the first rule is a whole rule, not the tail of the one above it.
  assert.match(rules[0], /^\*\*Trust before reach\.\*\* The git lock is the boundary/);
  // Every binding rule reads as a complete instruction, never a mid-sentence fragment.
  for (const r of rules) assert.ok(!/^(does not|and |or |no new architecture)/i.test(r), r);
  // The persona actually built from it carries them all.
  const p = parsePersona(DESIGNER, ITEM, charter)!;
  assert.deepEqual(p.constraints, rules);
});

// --- stability: the fit is the same twice, the wording need not be --------------------

test("the same item and charter twice give the same role and the same constraints", async () => {
  const first = JSON.stringify({
    name: "Mara Vance", role: "Senior Interaction Designer",
    expertise: ["visual hierarchy"], constraints: ["keep it tasteful"],
  });
  // A second synthesis, worded differently: a different name, seniority dropped, the
  // words reordered, no constraint quoted at all.
  const second = JSON.stringify({
    name: "Dana Ruiz", role: "interaction designer",
    expertise: ["typographic scale"], constraints: [],
  });
  const of = async (answer: string): Promise<Persona> => {
    fakeQuery(answer);
    try { return (await synthesizePersona(cfg, brief(), ITEM))!; } finally { resetQuery(); }
  };
  const a = await of(first);
  const b = await of(second);
  assert.equal(a.roleKey, b.roleKey, "the fit is stable even though the wording is not");
  assert.deepEqual(a.constraints, b.constraints, "the binding rules are identical, run to run");
  assert.notEqual(a.name, b.name, "and the wording is genuinely allowed to differ");
});

test("roleKeyOf normalizes seniority and word order away, and nothing else", () => {
  assert.equal(roleKeyOf("Staff Release Engineer"), roleKeyOf("release engineer, senior"));
  assert.equal(roleKeyOf("Interaction Designer"), roleKeyOf("  interaction   designer  "));
  assert.notEqual(roleKeyOf("Release Engineer"), roleKeyOf("Interaction Designer"));
});

// --- failure is never fatal ----------------------------------------------------------

test("a synthesis that fails or returns nothing leaves the item on the default prompt", async () => {
  const fail = async (answer: string | (() => never)): Promise<Persona | undefined> => {
    fakeQuery(answer);
    try { return await synthesizePersona(cfg, brief(), ITEM); } finally { resetQuery(); }
  };
  assert.equal(await fail(""), undefined, "an empty answer");
  assert.equal(await fail("I could not think of a good role for this."), undefined, "prose");
  assert.equal(await fail("{not json at all"), undefined, "unparseable JSON");
  assert.equal(await fail("[]"), undefined, "the wrong JSON shape");
  assert.equal(await fail(JSON.stringify({ role: "Release Engineer", expertise: ["x"] })), undefined, "no name");
  assert.equal(await fail(JSON.stringify({ name: "Ada", role: "", expertise: ["x"] })), undefined, "no role");
  assert.equal(await fail(JSON.stringify({ name: "Ada", role: "Release Engineer" })), undefined, "no expertise");
  assert.equal(await fail(() => { throw new Error("harness exploded"); }), undefined, "a harness error");
  // …and the append for "no persona" is the empty string, so the caller's prompt is
  // byte-for-byte the default worker prompt.
  assert.equal(personaAppend(undefined), "");
  assert.deepEqual(personaDecisionFields(undefined), []);
});

// --- the record ----------------------------------------------------------------------

test("a persona is recordable with the decision it produced", () => {
  const p = parsePersona(DESIGNER, ITEM, CHARTER)!;
  const fields = Object.fromEntries(personaDecisionFields(p));
  assert.equal(fields.Persona, "Mara Vance — Senior Interaction Designer (visual hierarchy and typographic scale; dashboard information density; accessible contrast)");
  assert.match(fields.Fork, /^a @human node/);
  assert.match(fields.Fork, /visual hierarchy of the dashboard header/);
});

test("the persona prompt never claims authority the guard denies", () => {
  const p = parsePersona(DESIGNER, ITEM, CHARTER)!;
  const append = personaAppend(p);
  assert.match(append, /You DECIDE; you do not ship\./);
  // The two real denials, named as enforced...
  assert.match(append, /the Leopold guard denies `git commit` and `git push`/);
  // ...and everything else named as a rule the role keeps itself. What the guard actually
  // enforces is asserted against the live hook in trust-boundary.test.ts; this is the
  // wording half of the same contract.
  assert.match(append, /EVERYTHING ELSE IS ON YOU, because nothing blocks it/);
  assert.match(append, /do not run git tag, do not publish a package, do not cut a release, do not open an external PR/);
  assert.match(append, /never raise a budget or iteration limit, clear a kill switch, or edit GUARDRAILS\.md/);
});

test("prompt construction is pure — no model, no clock, no disk", () => {
  const b = brief();
  assert.equal(personaSystemPrompt(b), personaSystemPrompt(b));
  assert.equal(personaUserPrompt(ITEM), personaUserPrompt(ITEM));
  // An item with no detail still states what is being decided.
  assert.match(personaUserPrompt({ fork: "repair", item: "fix the graph" }), /\(the item as written\)/);
  assert.ok(personaUserPrompt({ fork: "repair", item: "fix the graph" }).includes(FORK_SITUATION.repair));
});

// --- the record: a decision without a Reversal line is not done ------------------

test("a persona's decision block is read back whole", () => {
  const turn = "Here is what I did.\n\n```leopold-decision\n" +
    "DECISION: ship the cutover on Sunday 02:00 UTC\n" +
    "WHY: the charter puts reversibility first and this is the lowest-traffic hour\n" +
    "REVERSAL: re-run the down migration in db/2026-08-cutover.sql\n```\n" +
    "```leopold-status\nSTATUS: done\nITEM: x\nSUMMARY: staged\n```";
  const d = parseDecisionBlock(turn)!;
  assert.equal(d.decision, "ship the cutover on Sunday 02:00 UTC");
  assert.match(d.why, /lowest-traffic hour/);
  assert.equal(d.reversal, "re-run the down migration in db/2026-08-cutover.sql");
});

test("no REVERSAL line is never an empty Reversal — the default is always true of a run", () => {
  // Git is locked, so "discard the staged work" undoes anything a persona did.
  const d = parseDecisionBlock("```leopold-decision\nDECISION: keep SQLite\nWHY: no new infrastructure\n```")!;
  assert.equal(d.reversal, DEFAULT_REVERSAL);
  assert.match(DEFAULT_REVERSAL, /Nothing was committed/);
});

test("a persona that stated nothing still leaves a decision, from its own summary", () => {
  assert.equal(parseDecisionBlock("no block here", "approved the window")!.decision, "approved the window");
  // …and only a fork with nothing at all to record produces no entry.
  assert.equal(parseDecisionBlock("no block here"), undefined);
});

test("the format the prompt asks for is the format the parser reads", () => {
  const d = parseDecisionBlock(DECISION_BLOCK_INSTRUCTION.replace(/<[^>]+>/g, "something"))!;
  assert.equal(d.decision, "something");
  assert.equal(d.why, "something");
  assert.equal(d.reversal, "something");
});

test("a persona that took several turns is recorded on the call it ENDED on", () => {
  const turns =
    "```leopold-decision\nDECISION: first thought\nWHY: a\nREVERSAL: b\n```\n" +
    "```leopold-decision\nDECISION: what I actually did\nWHY: c\nREVERSAL: d\n```";
  assert.equal(parseDecisionBlock(turns)!.decision, "what I actually did");
});

// A model wraps at ~80 columns constantly, and a Reversal is the one field the entire
// trail exists to carry. The field regex used to end its lookahead on `$` under the `m`
// flag, where `$` matches every end-of-LINE — so the lazy capture stopped at the first
// newline and recorded half an undo instruction, which reads complete and tells a human
// nothing. `(?![\s\S])` is the end-of-input assertion that was meant.
test("a wrapped WHY or REVERSAL is recorded whole, not cut at the first newline", () => {
  const block = [
    "```leopold-decision",
    "DECISION: ship the single-row path",
    "WHY: the charter prefers the reversible,",
    "  smaller slice when two paths are close",
    "REVERSAL: revert src/db/migrate.ts and",
    "  re-open item 4 in PLAN.md",
    "```",
  ].join("\n");
  const d = parseDecisionBlock(block)!;
  assert.equal(d.reversal, "revert src/db/migrate.ts and re-open item 4 in PLAN.md");
  assert.equal(d.why, "the charter prefers the reversible, smaller slice when two paths are close");
  assert.notEqual(d.reversal, DEFAULT_REVERSAL, "a stated Reversal must never fall back to the default");
  // One line per field survives: `clip` collapses the whitespace before it is written, so
  // un-truncating the capture cannot break the DECISIONS.md block format.
  for (const v of [d.decision, d.why, d.reversal]) assert.ok(!v.includes("\n"), `field still multi-line: ${v}`);
});

// The guard named three examples in its own system prompt and rejected one of them. Nothing
// stripped a leading article or a plural, so the exact strings the prompt calls "not a
// persona" were accepted as a fit — and a generic role is the whole feature failing quietly.
test("a generic role is rejected however it is spelled", () => {
  const charter = "# Charter\n\n## Never\n- Add a runtime dependency.\n";
  const item = { fork: "human" as const, item: "Approve the cutover" };
  const of = (role: string) => parsePersona(
    JSON.stringify({ name: "X", role, expertise: ["a"], optimizesFor: ["b"], rationale: "c" }),
    item, charter,
  );
  for (const role of ["an assistant", "An Engineer", "the assistant", "assistants", "an agent", "AI Agent", "Helper."]) {
    assert.equal(of(role), undefined, `"${role}" is not a persona and must not be accepted as one`);
  }
  // …and a real one still is. The guard must reject the costume, not the role.
  const real = of("Staff Release Engineer");
  assert.ok(real, "a specific role must survive the generic guard");
  assert.equal(real.role, "Staff Release Engineer");
});

// A charter of plain prose yields no hard rules, and the prompt used to print
// "YOU ARE BOUND BY THESE RULES…:" over an empty list — telling the role something binds
// it and then refusing to name it.
test("a charter with no hard rules says so instead of printing an empty binding list", () => {
  const persona = parsePersona(
    JSON.stringify({ name: "Dana Okonkwo", role: "Release Engineer", expertise: ["cutovers"], optimizesFor: ["reversibility"], rationale: "the item is a cutover" }),
    { fork: "human", item: "Approve the cutover" },
    "# Charter\n\nWe like good software.\n",
  )!;
  assert.deepEqual(persona.constraints, [], "this charter states no hard rule");
  const prompt = personaAppend(persona);
  assert.doesNotMatch(prompt, /YOU ARE BOUND BY THESE RULES/, "no header over an empty list");
  assert.match(prompt, /states no binding rule/i, "say plainly that there is none");
});

// RULE_WORDS guessed at rules in prose, and `did not` is past tense: a statement about what
// already happened is never a constraint. It was being injected under "a decision that
// breaks one is wrong however well argued".
test("charter prose in the past tense is history, not a binding rule", () => {
  assert.deepEqual(
    charterHardRules("# Charter\n\nThe first attempt did not use a worktree, which cost a day.\n"),
    [],
    "a post-mortem sentence must not become a rule the persona is bound by",
  );
  // The declared path is untouched: under `## Never`, the author said it is a rule.
  assert.deepEqual(
    charterHardRules("# Charter\n\n## Never\n- The first attempt did not use a worktree.\n"),
    ["Never: The first attempt did not use a worktree."],
  );
  // And a present-tense prose rule still binds.
  assert.deepEqual(
    charterHardRules("# Charter\n\nThe git lock does not move.\n"),
    ["The git lock does not move."],
  );
});
