// The workflow engine's decision trail — the gap this closes: /leopold-workflow used to
// write NO decisions at all, because `logDecision` lived in the driver's loop and the
// workflow script only wrote from a `@feedback` node. A run of the same brief left
// DECISIONS.md empty.
//
// What is proven here:
//   1. a workflow run resolving a `@human` node writes a DECISIONS.md entry, and the
//      block is INDISTINGUISHABLE from the one the driver's logPersonaDecision writes
//      for the same persona and the same call — compared against the real driver writer,
//      not against a restatement of its format;
//   2. the persona's binding rules are the CHARTER'S, lifted by the same deterministic
//      rules `charterHardRules` uses in the driver (the port is asserted against it);
//   3. a synthesis that produces a generic role still leaves an entry — no persona path
//      may decide without a trail — and the item runs under the default prompt;
//   4. a decision that states no reversal gets the default one; a Reversal line is never
//      blank;
//   5. `autonomy: ask` halts as before and writes nothing;
//   6. a plan that authors no graph is untouched: no persona agent, no writer agent, and
//      the script's agent prompts are BYTE-IDENTICAL to the script as it stood before
//      this capability existed (run side by side against the frozen pre-persona copy in
//      fixtures/, so the guarantee keeps being checked after this change is committed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileBrief } from "../src/compile.ts";
import { charterHardRules, type Persona } from "../src/persona.ts";
import { logPersonaDecision } from "../src/log.ts";
import { runWorkflow, workflowPath, type Responder, type RunResult } from "./workflow-harness.ts";

const SCRIPT = workflowPath("leopold-workflow", "leopold-run.workflow.js");
/** The script as it stood before personas existed — frozen, never regenerated. */
const PRE_PERSONA_SCRIPT = path.join(import.meta.dirname, "fixtures", "leopold-run.workflow.pre-persona.js");

// A real-shaped charter: a `## Never` section whose polarity is half of each rule, and a
// wrapped bullet that a naive line scan would split into a rule and an orphan fragment.
const CHARTER = `# Charter

## What I optimize for
1. TRUST BEFORE REACH. The git lock is the boundary this product rests on, and it
   does not move.
2. The simplest thing that ships.

## Never
- Run \`git push\`, \`git tag\` or \`npm publish\`.
- Ship a claim the tests do not back.
`;

const HUMAN_PLAN = `# Plan
- [ ] Build the thing
- [ ] (after: 1) @human Approve the production cutover
- [ ] (after: 2) Announce it
`;

const PERSONA = {
  name: "Rui Salgado",
  role: "Release Engineer",
  expertise: ["production cutovers", "rollback design"],
  optimizesFor: ["a reversible release"],
  rationale: "A cutover is a release call, not a coding call.",
};

const DECISION = {
  decision: "release the cutover behind the flag, staged only",
  why: "the charter says trust before reach; nothing ships without the human",
  reversal: "flip `cutover_enabled` back to false in config/flags.yml",
};

function compile(planText: string, guardrails?: string) {
  return compileBrief({ mission: "# Mission\nShip it.", charter: CHARTER, planText, guardrails });
}

/** Drive the script with a responder that answers each agent by its label role. */
function respondWith(over: Partial<Record<string, unknown>> = {}): Responder {
  return ({ opts }) => {
    const label = String(opts.label || "");
    if (label.startsWith("verify:")) return { ok: true, blocking: [] };
    if (label.startsWith("node:persona:")) return "persona" in over ? over.persona : PERSONA;
    if (label.startsWith("node:decision:")) return { summary: "recorded" };
    if (label.startsWith("impl:i2")) return "impl" in over ? over.impl : { summary: "cutover done", ...DECISION };
    return { summary: "done" };
  };
}

/** The bytes the run handed the writer agent that appends to DECISIONS.md. */
function writtenTrail(r: RunResult): string {
  const writer = r.agents.find((a) => String(a.label).startsWith("node:decision:"));
  assert.ok(writer, "a persona decision must reach the DECISIONS.md writer");
  return writer!.prompt;
}

/** The `## D<n>` block out of whatever text carries it, with the timestamp/turn header
 *  reduced to its title so two engines' entries can be compared field for field. */
function blockOf(text: string): string {
  const m = text.match(/^## D\d+ — [\s\S]*?(?=\n\n|\nDo not modify|$)/m);
  assert.ok(m, "no decision block found");
  return m![0].replace(/\(turn \d+, [^)]+\)/, "(turn N, TS)");
}

test("a workflow run resolving a @human node writes the driver's exact DECISIONS entry", async () => {
  const r = await runWorkflow(SCRIPT, { args: compile(HUMAN_PLAN), respond: respondWith() });

  // It ran, and the run carried on past it.
  const impl = r.agents.filter((a) => String(a.label).startsWith("impl:")).map((a) => a.label);
  assert.deepEqual(impl, ["impl:i1", "impl:i2", "impl:i3"]);

  // The persona was assumed, with the charter's rules attached in code.
  const item = r.agents.find((a) => a.label === "impl:i2")!;
  assert.match(item.prompt, /YOU ARE RUI SALGADO — Release Engineer\./);
  for (const rule of charterHardRules(CHARTER)) assert.ok(item.prompt.includes(rule), `charter rule missing: ${rule}`);
  assert.match(item.prompt, /Never: Run `git push`/, "a `## Never` rule keeps its polarity");

  // …and the entry it left is the driver's, field for field.
  const persona: Persona = {
    ...PERSONA, roleKey: "engineer-release",
    constraints: charterHardRules(CHARTER), fork: "human", item: "@human Approve the production cutover",
  };
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-trail-"));
  logPersonaDecision(leo, 2, persona, DECISION, { fork: "human", item: persona.item });
  const fromDriver = blockOf(fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8"));
  assert.equal(blockOf(writtenTrail(r)), fromDriver);

  // The report says what was decided for the human, and points at the way back.
  const out = r.result as { decisions?: Array<{ persona: string; decision: string; reversal: string }> };
  assert.equal(out.decisions?.length, 1);
  assert.match(out.decisions![0].persona, /Rui Salgado — Release Engineer/);
  assert.equal(out.decisions![0].reversal, DECISION.reversal);
});

test("a generic role is refused, and the decision is STILL on the record", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: compile(HUMAN_PLAN),
    respond: respondWith({ persona: { name: "Helper", role: "an agent", expertise: ["things"] } }),
  });
  const item = r.agents.find((a) => a.label === "impl:i2")!;
  assert.ok(!item.prompt.includes("YOU ARE"), "an 'agent' with a hat on is not a persona");
  const trail = writtenTrail(r);
  assert.match(trail, /Persona:\s+Leopold — no role was synthesized/);
  assert.match(trail, /Decision:\s+release the cutover behind the flag/);
  assert.match(trail, /^Reversal:\s+\S/m);
});

test("a decision that states no reversal still gets one — a Reversal line is never blank", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: compile(HUMAN_PLAN),
    respond: respondWith({ impl: { summary: "approved the cutover", decision: "approve it", why: "", reversal: "" } }),
  });
  const trail = writtenTrail(r);
  assert.match(trail, /Reversal:\s+Nothing was committed: discard this item's staged work/);
  assert.match(trail, /Why:\s+no separate reasoning was stated/);
});

test("a @human node that returns nothing usable is recorded anyway", async () => {
  const r = await runWorkflow(SCRIPT, { args: compile(HUMAN_PLAN), respond: respondWith({ impl: {} }) });
  const trail = writtenTrail(r);
  assert.match(trail, /Decision:\s+ran the @human item/);
  assert.match(trail, /^Reversal:\s+\S/m);
});

test("with autonomy: ask nothing is decided and nothing is written", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: compile(HUMAN_PLAN, "- autonomy: ask\n"),
    respond: respondWith(),
  });
  assert.deepEqual(r.agents.filter((a) => /node:(persona|decision):/.test(String(a.label))), []);
  assert.ok((r.result as { awaiting_human?: unknown }).awaiting_human, "ask still hands the seat back");
});

test("a plan with no persona path writes nothing, and runs byte-identically to the old script", async () => {
  const plan = "# Plan\n- [ ] Build the thing\n- [ ] (after: 1) Ship it\n";
  const respond: Responder = ({ opts }) =>
    String(opts.label || "").startsWith("verify:") ? { ok: true, blocking: [] } : { summary: "done" };

  const now = await runWorkflow(SCRIPT, { args: compile(plan), respond });
  assert.deepEqual(now.agents.filter((a) => /node:(persona|decision):/.test(String(a.label))), []);
  assert.deepEqual(Object.keys(now.result as object), ["mission", "total", "done", "incomplete", "note"]);

  // The same plan through the script as it stood BEFORE personas existed: same agents,
  // same prompts, same options, same result. The @human semantic change is deliberate
  // and loud; everything else is untouched, and this is what proves it.
  //
  // The baseline is a checked-in frozen copy, NOT `git show HEAD:` of the script — that
  // pattern stops testing anything the moment this change is committed, because HEAD then
  // holds the new script and the comparison is the file against itself.
  const then = await runWorkflow(PRE_PERSONA_SCRIPT, { args: compile(plan), respond });

  assert.deepEqual(
    now.agents.map((a) => ({ prompt: a.prompt, opts: a.opts })),
    then.agents.map((a) => ({ prompt: a.prompt, opts: a.opts })),
  );
  assert.deepEqual(now.result, then.result);
});
