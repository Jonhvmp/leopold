// An escalation is SETTLED, not surrendered.
//
// `needs-decision` used to be the end of a run: the worker asked, the conductor could
// not settle it from the charter, and the item sat there with a question attached until
// a person came back. These tests drive the REAL processItem through an injected fake
// SDK (zero model calls, zero tokens) and prove the three things the change promises:
//
//   1. a needs-decision no longer ends a default run — a role settles it, the worker
//      RECEIVES that decision as its next instruction, and the item closes;
//   2. the call lands in DECISIONS.md naming the persona, the fork, the charter basis
//      and a Reversal — an autonomous decision with no trail is the failure mode;
//   3. `autonomy: ask` escalates and stops, byte-for-byte as before personas existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { processItem } from "../src/loop.ts";
import {
  escalationSystemPrompt, escalationUserPrompt, parseResolution, resolveEscalation,
} from "../src/conductor.ts";
import { DEFAULT_REVERSAL, NO_EXECUTION_CLAUSE } from "../src/persona.ts";
import type { Brief, DriverConfig, RunState, WorkerStatus } from "../src/types.ts";

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function tmpRepo(): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-escal-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo); fs.writeFileSync(path.join(leo, "events.jsonl"), "");
  return { root, leo };
}

const MISSION = "Ship the checkout rewrite.";
const CHARTER = `# Charter

## What I optimize for
- Reversible over clever.

## Never
- Add a new runtime dependency.
- Run git push, git tag or npm publish.
`;

const cfg = (autonomy: "full" | "ask"): DriverConfig => ({
  maxTurnsPerItem: 40, review: false, maxReviewRounds: 2, conformance: false,
  hypotheses: false, smartRouting: false, learnOnFinish: false, parallel: 1,
  literalReset: false, bestOfK: 1, sliceScope: false, worktree: false, dryRun: false,
  autonomy,
} as DriverConfig);
const state = (): RunState =>
  ({ active: true, iteration: 1, max_iterations: 50, consecutive_failures: 0, max_failures: 3, started_at: "" });

const ITEM = "Pick the session store for checkout";
const FORK = "Redis (new infra) or the existing Postgres table? A/B tradeoff: latency vs a new dependency.";

function statusBlock(kind: string, extra = ""): string {
  return "```leopold-status\nSTATUS: " + kind + "\nITEM: " + ITEM +
    `\nSUMMARY: ${kind === "done" ? "implemented and verified" : "hit a fork"}\n${extra}NEXT: none\nEVIDENCE: build+test ok\n\`\`\``;
}
const NEEDS = statusBlock("needs-decision", `DECISION-NEEDED: ${FORK}\n`);
const DONE = statusBlock("done");

const PERSONA_JSON = JSON.stringify({
  name: "Marta Vieira",
  role: "Staff Platform Engineer",
  expertise: ["session storage design", "operational cost of new infrastructure"],
  optimizesFor: ["fewest moving parts in production"],
  rationale: "The fork is an infrastructure choice, not a product one.",
});
const RESOLUTION_JSON = JSON.stringify({
  decision: "Use the existing Postgres table for sessions; no Redis.",
  why: "The charter forbids adding a new runtime dependency.",
  reversal: "Revert src/session-store.ts and re-open the Redis option.",
  reply: "Store sessions in the existing Postgres table. Do not add Redis. Finish the item and verify with build+test.",
});

/** A fake worker that reads the input channel, so the test can SEE what the driver
 *  pushed back to it — the whole point of settling an escalation is that the decision
 *  reaches the worker. */
function fakeWorker(channel: AsyncIterable<{ message: { content: Array<{ text: string }> } }>, received: string[]) {
  const assistant = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  return (async function* () {
    const it = channel[Symbol.asyncIterator]();
    await it.next();                                   // the item's worker prompt
    yield assistant(NEEDS);                            // the fork
    const next = await it.next();                      // whatever the driver decided
    if (next.done) { yield { type: "result", result: NEEDS, total_cost_usd: 0 }; return; }
    received.push(next.value.message.content[0].text);
    yield assistant(DONE);                             // it acts on the decision
    yield { type: "result", result: DONE, total_cost_usd: 0 };
  })();
}

/** What each call was asked, so a test can prove the fork actually reached the role. */
interface Seen { persona: string; personaAsk: string; resolve: string; resolveAsk: string }
const noSeen = (): Seen => ({ persona: "", personaAsk: "", resolve: "", resolveAsk: "" });

/** Route every model call by its system prompt: worker / conductor / persona synthesis /
 *  escalation resolution. `escalations` lets a test make the conductor escalate once and
 *  then accept the finish. */
function routeQuery(received: string[], seen: Seen, resolution = RESOLUTION_JSON) {
  const stream = (text: string) => (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    yield { type: "result", result: text, total_cost_usd: 0 };
  })();
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      return fakeWorker(input.prompt as never, received);
    }
    const sys = typeof sp === "string" ? sp : "";
    const user = typeof input.prompt === "string" ? input.prompt : "";
    if (sys.includes("synthesize the ROLE")) { seen.persona = sys; seen.personaAsk = user; return stream(PERSONA_JSON); }
    if (sys.includes("escalated it")) { seen.resolve = sys; seen.resolveAsk = user; return stream(resolution); }
    if (sys.includes("the conductor")) {
      // The worker's fork escalates; a `done` turn finishes.
      return user.includes("STATUS: needs-decision")
        ? stream('{"action":"escalate","classification":"irreversible","charterBasis":"","escalationReason":"new infrastructure is a charter question"}')
        : stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    }
    return stream('{"ok":true}');
  }) as never);
}

// --- scenario 1: a persona decides, the worker receives it, the item closes ----------

test("a worker reporting needs-decision no longer ends the run: a role settles it and the item closes", async () => {
  const { root, leo } = tmpRepo();
  const brief = { mission: MISSION, charter: CHARTER, guardrails: "", planPath: "", root, leoDir: leo } as Brief;
  const received: string[] = [];
  const seen = noSeen();
  routeQuery(received, seen);
  try {
    const outcome = await processItem(brief, cfg("full"), state(), [], ITEM, [], root);
    assert.equal(outcome.escalated, false, "the run does not escalate");
    assert.equal(outcome.done, true, "the item closes");
  } finally { resetQuery(); }

  // The worker RECEIVED the decision — not a restatement of the question.
  assert.equal(received.length, 1);
  assert.match(received[0], /existing Postgres table/);
  assert.match(received[0], /Do not add Redis/);

  // The role was synthesized from the fork, and it was bound by the charter in code.
  assert.match(seen.personaAsk, /Redis \(new infra\) or the existing Postgres table/);
  assert.match(seen.resolveAsk, /Redis \(new infra\) or the existing Postgres table/);
  assert.match(seen.resolve, /MARTA VIEIRA — Staff Platform Engineer/);
  assert.match(seen.resolve, /Never: Add a new runtime dependency\./);

  const events = fs.readFileSync(path.join(leo, "events.jsonl"), "utf8");
  assert.match(events, /"event":"persona","fork":"escalation"/);
  assert.match(events, /"event":"persona_decision","fork":"escalation"/);
});

// --- scenario 2: the trail ----------------------------------------------------------

test("the settled fork is in DECISIONS.md naming the persona, the fork and its charter basis", async () => {
  const { root, leo } = tmpRepo();
  const brief = { mission: MISSION, charter: CHARTER, guardrails: "", planPath: "", root, leoDir: leo } as Brief;
  routeQuery([], noSeen());
  try {
    await processItem(brief, cfg("full"), state(), [], ITEM, [], root);
  } finally { resetQuery(); }

  const trail = fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8");
  assert.match(trail, /Marta Vieira decided: Staff Platform Engineer/);
  assert.match(trail, /Persona:\s+Marta Vieira — Staff Platform Engineer/);
  assert.match(trail, /Fork:\s+an escalation — the worker hit a fork/);
  assert.match(trail, /Charter:\s+2 charter rule\(s\) bind Staff Platform Engineer/);
  assert.match(trail, /Decision:\s+Use the existing Postgres table/);
  assert.match(trail, /Reversal:\s+Revert src\/session-store\.ts/);
});

// --- scenario 3: autonomy: ask is exactly what it was -------------------------------

test("with autonomy: ask the run escalates and stops, and no role is synthesized", async () => {
  const { root, leo } = tmpRepo();
  const brief = { mission: MISSION, charter: CHARTER, guardrails: "", planPath: "", root, leoDir: leo } as Brief;
  const received: string[] = [];
  const seen = noSeen();
  routeQuery(received, seen);
  try {
    const outcome = await processItem(brief, cfg("ask"), state(), [], ITEM, [], root);
    assert.equal(outcome.escalated, true, "ask keeps the old halt");
    assert.equal(outcome.done, false);
    assert.match(outcome.escalation?.question ?? "", /Redis \(new infra\)/);
  } finally { resetQuery(); }

  assert.equal(seen.persona, "", "no synthesis call under ask");
  assert.equal(seen.resolve, "", "no resolution call under ask");
  assert.equal(received.length, 0, "nothing was pushed back to the worker");
  assert.equal(fs.existsSync(path.join(leo, "DECISIONS.md")), false, "no persona entry under ask");
});

// --- an unsettleable fork still escalates -------------------------------------------

test("a resolution that cannot be parsed escalates, loudly, instead of pretending", async () => {
  const { root, leo } = tmpRepo();
  const brief = { mission: MISSION, charter: CHARTER, guardrails: "", planPath: "", root, leoDir: leo } as Brief;
  const received: string[] = [];
  routeQuery(received, noSeen(), "I would rather ask a human about this.");
  try {
    const outcome = await processItem(brief, cfg("full"), state(), [], ITEM, [], root);
    assert.equal(outcome.escalated, true);
    assert.equal(outcome.done, false);
  } finally { resetQuery(); }
  assert.match(fs.readFileSync(path.join(leo, "events.jsonl"), "utf8"), /"event":"escalation_unsettled"/);
  assert.equal(fs.existsSync(path.join(leo, "DECISIONS.md")), false, "nothing was decided, so nothing is recorded");
});

// --- the framing, as a unit ---------------------------------------------------------

test("the resolution prompt binds the role with the charter's rules in code and claims no authority the guard denies", () => {
  const brief = { mission: MISSION, charter: CHARTER } as Brief;
  const sys = escalationSystemPrompt(brief);
  // The rules come from the charter, lifted verbatim — not from anything a model wrote.
  assert.match(sys, /Never: Add a new runtime dependency\./);
  assert.match(sys, /Never: Run git push, git tag or npm publish\./);
  assert.ok(sys.includes(NO_EXECUTION_CLAUSE), "the one no-execution clause, not a paraphrase");
  assert.match(sys, /NO HUMAN IS COMING/);
  assert.match(sys, /Do not ask a question back/);
  // Pure: the same brief twice gives the same string.
  assert.equal(sys, escalationSystemPrompt(brief));
});

test("the user turn carries the fork, the worker's evidence and why it was escalated", () => {
  const status = {
    kind: "needs-decision", item: ITEM, summary: "hit a fork",
    decisionNeeded: FORK, evidence: "bench: 4ms vs 11ms",
  } as WorkerStatus;
  const p = escalationUserPrompt(status, "new infrastructure is a charter question");
  assert.match(p, /Redis \(new infra\)/);
  assert.match(p, /bench: 4ms vs 11ms/);
  assert.match(p, /new infrastructure is a charter question/);
});

test("a resolution with no reply is not a resolution: there is nothing to unblock the worker with", () => {
  assert.equal(parseResolution('{"decision":"use Postgres","why":"charter","reversal":"revert"}'), undefined);
  assert.equal(parseResolution('{"reply":"go","why":"charter"}'), undefined);
  assert.equal(parseResolution("not json at all"), undefined);
});

test("a resolution that states no reversal still gets one — a run never commits, so undoing it is always true", () => {
  const r = parseResolution('```json\n{"decision":"use Postgres","reply":"do it","why":"charter"}\n```');
  assert.equal(r?.reversal, DEFAULT_REVERSAL);
  assert.equal(r?.decision, "use Postgres");
});

test("a harness error during resolution returns undefined instead of killing the run", async () => {
  setQuery((() => { throw new Error("harness died"); }) as never);
  try {
    const r = await resolveEscalation(cfg("full"), { mission: MISSION, charter: CHARTER } as Brief,
      { kind: "needs-decision", item: ITEM, summary: "fork" } as WorkerStatus, "why");
    assert.equal(r, undefined);
  } finally { resetQuery(); }
});
