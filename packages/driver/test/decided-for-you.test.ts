// "What I decided for you" — the end of the report.
//
// The trail is complete and nobody reads it at the end of a run that went well. A run
// that decided four things on someone's behalf and mentions none of them in its report
// has technically recorded them and practically hidden them, so the report ends with the
// calls themselves: riskiest first, each naming WHO decided and HOW TO UNDO IT.
//
// What this suite holds down:
//   1. three persona decisions are ALL summarized, ordered by risk, riskiest first;
//   2. a run with none renders nothing — the notification body is byte-for-byte what it
//      was before this existed, and a trail holding only the conductor's own calls (no
//      persona) counts as none;
//   3. every summarized line names the persona and the one-line Reversal;
//   4. BOTH ENGINES ORDER IT THE SAME. The workflow ranks the entries it holds in hand;
//      the driver ranks the same entries read back off DECISIONS.md. Run side by side
//      over one workflow run's real bytes, the two orders must be identical — an engine
//      that put a different call at position 1 would teach the user a lie.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logDecision, logPersonaDecision } from "../src/log.ts";
import { notify } from "../src/notify.ts";
import { decidedForYou, parseDecisionTrail, renderDecidedForYou, MAX_SUMMARIZED } from "../src/summary.ts";
import { charterHardRules, DEFAULT_REVERSAL, roleKeyOf } from "../src/persona.ts";
import type { Persona, PersonaFork } from "../src/persona.ts";
import { compileBrief } from "../src/compile.ts";
import { runWorkflow, workflowPath, type Responder, type RunResult } from "./workflow-harness.ts";

const CHARTER = `# Charter

## Never
- Run \`git push\`, \`git tag\` or \`npm publish\`.
`;

function tmpLeo(): string {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-decided-"));
  fs.writeFileSync(path.join(leo, "events.jsonl"), "");
  return leo;
}

function persona(name: string, role: string, fork: PersonaFork, item: string): Persona {
  return {
    name, role, roleKey: roleKeyOf(role),
    expertise: ["the thing this item needs"],
    optimizesFor: ["a reversible step"],
    constraints: charterHardRules(CHARTER),
    rationale: "it fits the item",
    fork, item,
  };
}

/** The body the last notification actually carried (what stdout printed and a webhook
 *  would have POSTed), read back off the event stream. */
function notifiedBody(leo: string): string {
  const lines = fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n");
  const ev = JSON.parse(lines[lines.length - 1]) as { event: string; body: string };
  assert.equal(ev.event, "notify");
  return ev.body;
}

// --- the summary itself ---------------------------------------------------------------

test("three persona decisions are all summarized, riskiest first", () => {
  const leo = tmpLeo();
  // Made in this order; ranked in another. The rescue is a bounded change of approach on
  // one item; the @human node is a call an author wrote down for a person; the escalation
  // is a fork the worker itself judged beyond the charter, about production.
  logPersonaDecision(leo, 1, persona("Ana Reis", "Build Engineer", "repeated-failure", "flaky suite"),
    { decision: "split the suite and run the slow half serially", why: "three failures, same shape", reversal: "revert Makefile" });
  logPersonaDecision(leo, 2, persona("Rui Salgado", "Release Engineer", "human", "@human Approve the cutover"),
    { decision: "approve the cutover behind a flag, staged only", why: "trust before reach", reversal: "flip cutover_enabled back to false" });
  logPersonaDecision(leo, 3, persona("Nadia Ferro", "Data Engineer", "escalation", "the migration fork"),
    { decision: "run the production migration in two reversible halves", why: "the charter forbids a one-way step", reversal: "run migrations/002_down.sql" });

  const out = decidedForYou(leo);
  const order = [...out.matchAll(/^  \d+\. \[([a-z-]+)\]/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["escalation", "human", "repeated-failure"], "riskiest first");
  assert.match(out, /What I decided for you \(3 calls, riskiest first\)/);
  for (const who of ["Nadia Ferro", "Rui Salgado", "Ana Reis"]) assert.ok(out.includes(who), `${who} is missing`);
  assert.match(out, /The full trail — charter basis and why — is in \.leopold\/DECISIONS\.md\./);
});

test("each summarized call names its persona and its one-line Reversal", () => {
  const leo = tmpLeo();
  logPersonaDecision(leo, 1, persona("Rui Salgado", "Release Engineer", "human", "@human Approve the cutover"),
    { decision: "approve the cutover behind a flag", why: "trust before reach", reversal: "flip cutover_enabled back to false in config/flags.yml" });
  logPersonaDecision(leo, 2, undefined,
    { decision: "kept the existing retry budget", why: "", reversal: "" },
    { fork: "deadlock", item: "item 4 waits on a signal nothing emits" });

  const lines = decidedForYou(leo).split("\n");
  const named = lines.find((l) => l.includes("Rui Salgado"))!;
  assert.match(named, /^ {2}\d+\. \[human\] Rui Salgado — Release Engineer \(D\d+\): approve the cutover behind a flag$/);
  assert.equal(
    lines[lines.indexOf(named) + 1],
    "     Reversal: flip cutover_enabled back to false in config/flags.yml",
    "the Reversal rides with the call, on its own line",
  );
  // Synthesis produced no role: the call is still summarized, named as what it was, and
  // it carries the default way back rather than a blank line.
  const anon = lines.find((l) => l.includes("no role was synthesized"))!;
  assert.match(anon, /\[deadlock\] Leopold — no role was synthesized/);
  assert.equal(lines[lines.indexOf(anon) + 1], `     Reversal: ${DEFAULT_REVERSAL}`);
});

test("a call with no fitted role, on a heavy subject, with no stated reversal outranks a plain one", () => {
  const plain = parseDecisionTrail(
    "\n## D1 — Rui Salgado decided: Release Engineer   (turn 1, 2026-01-01T00:00:00.000Z)\n" +
    "Persona:     Rui Salgado — Release Engineer (releases)\n" +
    "Fork:        a @human node — the plan asked a person to decide this, and no person is coming: x\n" +
    "Decision:    renamed the flag\nReversal:    rename it back\n",
  );
  const heavy = parseDecisionTrail(
    "\n## D2 — Leopold decided (no persona synthesized)   (turn 2, 2026-01-01T00:00:00.000Z)\n" +
    "Persona:     Leopold — no role was synthesized; the default worker rules applied\n" +
    "Fork:        a @human node — the plan asked a person to decide this, and no person is coming: y\n" +
    `Decision:    dropped the legacy production table\nReversal:    ${DEFAULT_REVERSAL}\n`,
  );
  assert.equal(plain.length, 1);
  assert.equal(heavy.length, 1);
  assert.ok(heavy[0].risk > plain[0].risk, "no role + production + no stated way back reads first");
});

test("beyond the cap the rest are counted, never dropped", () => {
  const leo = tmpLeo();
  for (let i = 0; i < MAX_SUMMARIZED + 2; i++) {
    logPersonaDecision(leo, i + 1, persona(`Dev ${i}`, "Interaction Designer", "human", `item ${i}`),
      { decision: `call ${i}`, why: "because", reversal: `undo ${i}` });
  }
  const out = decidedForYou(leo);
  assert.match(out, new RegExp(`\\(${MAX_SUMMARIZED + 2} calls, riskiest first\\)`));
  assert.equal([...out.matchAll(/^ {2}\d+\. \[/gm)].length, MAX_SUMMARIZED);
  assert.match(out, /\(\+2 more\)/);
});

// --- a run that decided nothing --------------------------------------------------------

test("a run with no persona decision reports exactly what it always did", async () => {
  const body = "Plan complete for /repo. Everything is staged for your review; nothing was committed.";

  // No trail at all.
  const empty = tmpLeo();
  assert.equal(decidedForYou(empty), "");
  await notify(empty, undefined, "Leopold finished", body);
  assert.equal(notifiedBody(empty), body);

  // A trail with the conductor's OWN calls in it — those are not decisions taken on the
  // human's behalf at a stop path, so they do not turn up in this summary.
  const leo = tmpLeo();
  logDecision(leo, 1, { item: "x", summary: "did it", done: true } as never,
    { classification: "reversible", charterBasis: "the charter is clear", logTitle: "kept going", logWhy: "clear", reversal: "revert the file" } as never);
  assert.ok(fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8").includes("## D"), "the conductor did write a block");
  assert.equal(decidedForYou(leo), "");
  await notify(leo, undefined, "Leopold finished", body);
  assert.equal(notifiedBody(leo), body);
});

test("the notification carries the summary — every run ends through notify()", async () => {
  const leo = tmpLeo();
  logPersonaDecision(leo, 1, persona("Rui Salgado", "Release Engineer", "human", "@human Approve the cutover"),
    { decision: "approve the cutover behind a flag", why: "trust before reach", reversal: "flip the flag back" });
  await notify(leo, undefined, "Leopold finished", "Plan complete.");
  const got = notifiedBody(leo);
  assert.match(got, /^Plan complete\./);
  assert.match(got, /What I decided for you \(1 call, riskiest first\)/);
  assert.match(got, /Rui Salgado — Release Engineer/);
  assert.match(got, /Reversal: flip the flag back/);
});

test("renderDecidedForYou of nothing is the empty string", () => {
  assert.equal(renderDecidedForYou([]), "");
});

// --- both engines order it the same ----------------------------------------------------

const SCRIPT = workflowPath("leopold-workflow", "leopold-run.workflow.js");

const THREE_HUMAN_PLAN = `# Plan
- [ ] @human Rename the settings label
- [ ] @human Approve the production database cutover
- [ ] @human Pick the retry backoff
`;

/** Per-item persona + decision, so the three calls differ in exactly what ranks them. */
const ANSWERS: Record<string, { persona: unknown; decision: Record<string, string> }> = {
  i1: {
    persona: { name: "Vera Lund", role: "Interaction Designer", expertise: ["labels"], optimizesFor: ["clarity"], rationale: "a wording call" },
    decision: { summary: "renamed it", decision: "call it \"Notifications\"", why: "plainer", reversal: "revert src/ui/settings.tsx" },
  },
  i2: {
    persona: { name: "Nadia Ferro", role: "Release Engineer", expertise: ["cutovers"], optimizesFor: ["a reversible step"], rationale: "a release call" },
    decision: { summary: "approved", decision: "run the production cutover in two reversible halves", why: "trust before reach", reversal: "run migrations/002_down.sql" },
  },
  i3: {
    persona: { name: "Ana Reis", role: "Build Engineer", expertise: ["retries"], optimizesFor: ["a boring default"], rationale: "a tuning call" },
    decision: { summary: "picked one", decision: "back off 200ms, doubling, three tries", why: "the simplest thing", reversal: "revert src/retry.ts" },
  },
};

const respond: Responder = ({ opts }) => {
  const label = String(opts.label || "");
  if (label.startsWith("verify:")) return { ok: true, blocking: [] };
  const id = label.split(":").pop() as string;
  if (label.startsWith("node:persona:")) return ANSWERS[id].persona;
  if (label.startsWith("node:decision:")) return { summary: "recorded" };
  if (label.startsWith("impl:")) return ANSWERS[id].decision;
  return { summary: "done" };
};

/** The DECISIONS.md the workflow run actually wrote: the exact bytes it handed each
 *  writer agent, concatenated in the order it wrote them. */
function trailFrom(r: RunResult): string {
  return r.agents
    .filter((a) => String(a.label).startsWith("node:decision:"))
    .map((a) => a.prompt.match(/\n(## D\d+ —[\s\S]*?)\nDo not modify/)![1])
    .join("\n");
}

test("the workflow and the driver rank the same three calls identically", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: compileBrief({ mission: "# Mission\nShip it.", charter: CHARTER, planText: THREE_HUMAN_PLAN }),
    respond,
  });

  const fromWorkflow = (r.result as { decisions: Array<{ decision: string; persona: string; reversal: string }> }).decisions;
  assert.equal(fromWorkflow.length, 3, "all three calls are reported, not just the last");
  // The workflow ranked what it held in hand; the driver ranks the same calls read back
  // off the bytes that run wrote. One order, two engines.
  const fromDriver = parseDecisionTrail(trailFrom(r));
  assert.deepEqual(fromWorkflow.map((d) => d.decision), fromDriver.map((d) => d.decision));
  assert.match(fromWorkflow[0].decision, /production cutover/, "the riskiest call reads first");

  // And the run's note ends with it, naming the persona and the way back.
  const note = (r.result as { note: string }).note;
  assert.match(note, /What I decided for you \(3 calls, riskiest first\)/);
  assert.match(note, /1\. \[human\] Nadia Ferro — Release Engineer \(D\d+\): run the production cutover in two reversible halves/);
  assert.match(note, /\n {5}Reversal: run migrations\/002_down\.sql/);
  assert.ok(note.startsWith("Everything is staged for your review; nothing was committed."), "the old note is still the note");
});

test("a workflow run that decides nothing keeps its note byte-for-byte", async () => {
  const r = await runWorkflow(SCRIPT, {
    args: compileBrief({ mission: "# Mission\nShip it.", charter: CHARTER, planText: "# Plan\n- [ ] Build the thing\n" }),
    respond: ({ opts }) => (String(opts.label).startsWith("verify:") ? { ok: true, blocking: [] } : { summary: "done" }),
  });
  const out = r.result as { note: string; decisions?: unknown };
  assert.equal(out.decisions, undefined);
  assert.equal(out.note, "Everything is staged for your review; nothing was committed. Commit what you approve.");
});
