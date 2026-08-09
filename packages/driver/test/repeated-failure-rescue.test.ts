// Repeated failure buys ONE persona-led change of approach — and only one.
//
// `consecutive_failures >= max_failures` used to end the run: the item still open, the
// work handed back to a person who is not there. A run that failed three times the same
// way did not run out of budget, it ran out of ideas — so a role is synthesized from the
// failure evidence, it decides a genuinely different approach, and the last attempt runs
// under it. These tests drive the REAL runDriver through an injected fake SDK (zero model
// calls, zero tokens) and prove the four things the change promises:
//
//   1. three failures of the same kind → one differently-framed attempt runs BEFORE the
//      run stops, and the worker actually receives the new approach;
//   2. that attempt failing too → the run stops with `repeated_failure`, as today;
//   3. the attempt is on the trail: DECISIONS.md names the persona, the approach and a
//      Reversal, and the event stream says why it differed;
//   4. the ceiling is never raised — `max_failures` is untouched, the extra attempt is
//      ONE, and it is charged as an iteration like any other.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver } from "../src/loop.ts";
import {
  parseRescue, rescueSystemPrompt, rescueUserPrompt, formatRescueLead, type Rescue,
} from "../src/rescue.ts";
import { DEFAULT_REVERSAL, NO_EXECUTION_CLAUSE } from "../src/persona.ts";
import type { Brief } from "../src/types.ts";

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

const MISSION = "Ship the importer.";
const CHARTER = `# Charter

## What I optimize for
- Reversible over clever.

## Never
- Add a new runtime dependency.
`;

function briefRepo(item: string, guardrails = "# Guardrails\n- max_failures: 3\n- max_iterations: 50\n"): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-rescue-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".leopold/\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "MISSION.md"), `# Mission\n${MISSION}\n`);
  fs.writeFileSync(path.join(leo, "CHARTER.md"), CHARTER);
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), guardrails);
  fs.writeFileSync(path.join(leo, "PLAN.md"), `# Plan\n\n- [ ] ${item}\n`);
  return { root, leo };
}

const evLines = (leo: string): Array<Record<string, unknown>> =>
  fs.existsSync(path.join(leo, "events.jsonl"))
    ? fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

const PERSONA_JSON = JSON.stringify({
  name: "Dana Okonkwo",
  role: "Data Migration Engineer",
  expertise: ["idempotent batch importers", "reading failure output literally"],
  optimizesFor: ["a smaller first slice over a complete rewrite"],
  rationale: "The failures are all in the batch boundary, which is this role's daily work.",
});
const APPROACH = "Import ONE row end to end through the existing loader before touching batching at all.";
const DIFFERENT = "Every failed attempt started from the batch writer; this starts from a single row and never opens it.";
const RESCUE_JSON = JSON.stringify({
  approach: APPROACH,
  different: DIFFERENT,
  decision: "Take the single-row path on the last attempt instead of fixing the batch writer.",
  why: "The charter prefers the reversible, smaller slice when two paths are close.",
  reversal: "Revert src/import.ts and re-open the batch-writer approach.",
});

const stream = (text: string) => (async function* () {
  yield { type: "assistant", message: { content: [{ type: "text", text }] } };
  yield { type: "result", result: text, total_cost_usd: 0 };
})();

/** Drive a whole run whose worker ALWAYS fails, and record what each attempt was told. */
async function runAlwaysFailing(root: string, opts: { rescue?: string } = {}): Promise<{
  prompts: string[]; personaCalls: number; rescueCalls: number; rescueAsk: string; rescueSys: string;
}> {
  const prompts: string[] = [];
  const seen = { personaCalls: 0, rescueCalls: 0, rescueAsk: "", rescueSys: "" };
  const item = "Import the legacy rows";
  const blocked = "```leopold-status\nSTATUS: blocked\nITEM: " + item +
    "\nSUMMARY: the batch writer rejects the payload\nNEXT: ?\nEVIDENCE: 1 failing test\n```";

  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      // The worker: read the item prompt off the channel (that is where the lead lands),
      // then fail. One worker call per attempt.
      return (async function* () {
        const ch = input.prompt as AsyncIterable<{ message: { content: Array<{ text: string }> } }>;
        const it = ch[Symbol.asyncIterator]();
        const first = await it.next();
        if (!first.done) prompts.push(first.value.message.content[0].text);
        yield { type: "assistant", message: { content: [{ type: "text", text: blocked }] } };
        yield { type: "result", result: blocked, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    const user = typeof input.prompt === "string" ? input.prompt : "";
    if (sys.includes("synthesize the ROLE")) { seen.personaCalls += 1; return stream(PERSONA_JSON); }
    if (sys.includes("failed the maximum number of times")) {
      seen.rescueCalls += 1; seen.rescueAsk = user; seen.rescueSys = sys;
      return stream(opts.rescue ?? RESCUE_JSON);
    }
    if (sys.includes("the conductor")) return stream('{"action":"answer","reply":"keep going"}');
    if (sys.includes("review gate")) return stream('{"ok":true,"blocking":[],"summary":"clean"}');
    return stream('{"ok":true}');
  }) as never);

  const origLog = console.log; const origWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {}; process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runDriver(root, ["--no-hypotheses"]);
  } finally {
    console.log = origLog; process.stdout.write = origWrite; resetQuery();
  }
  return { prompts, ...seen };
}

// --- scenario 1 + 2 + 4: one extra attempt, then the run stops, ceiling untouched ------

test("three failures buy ONE differently-framed attempt; when it fails too the run stops with repeated_failure", async () => {
  const { root, leo } = briefRepo("Import the legacy rows");
  const r = await runAlwaysFailing(root);

  assert.equal(r.prompts.length, 4, "3 allowed failures + exactly ONE persona-led last attempt");
  assert.equal(r.personaCalls, 1, "the role is synthesized once, from the failure evidence");
  assert.equal(r.rescueCalls, 1, "the change of approach is decided once — it is a ceiling, not a budget");

  // The last attempt is the framed one, and the first three are not.
  for (const p of r.prompts.slice(0, 3)) {
    assert.ok(!p.includes("THIS IS THE LAST ATTEMPT"), "the attempts under the ceiling are unchanged");
  }
  const last = r.prompts[3];
  assert.ok(last.includes("THIS IS THE LAST ATTEMPT"), "the rescued attempt knows it is the last one");
  assert.ok(last.includes(APPROACH), "the worker RECEIVES the new approach");
  assert.ok(last.includes(DIFFERENT), "…and how it differs from what failed");
  assert.ok(last.includes("Dana Okonkwo"), "…under the role that decided it");

  const state = JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")) as Record<string, unknown>;
  assert.equal(state.stopped_reason, "repeated_failure", "the extra attempt failing too stops the run as today");
  assert.equal(state.max_failures, 3, "the failure ceiling was NEVER raised");
  assert.equal(state.failure_rescue_used, true, "the run's single rescue is marked spent");
  assert.ok((state.iteration as number) <= 4, "the extra attempt is charged as an iteration, not exempted");

  const events = evLines(leo);
  assert.equal(events.filter((e) => e.event === "item_incomplete").length, 4, "four failed attempts, no more");
  assert.equal(events.filter((e) => e.event === "failure_rescue").length, 1, "one rescue, ever");
  assert.equal(events.filter((e) => e.event === "stop" && e.reason === "repeated_failure").length, 1);
});

// --- scenario 3: the attempt is on the trail, with its approach and why it differed ----

test("the persona-led attempt is logged with its approach, why it differed, and a Reversal", async () => {
  const { root, leo } = briefRepo("Import the legacy rows");
  await runAlwaysFailing(root);

  const rescue = evLines(leo).find((e) => e.event === "failure_rescue")!;
  assert.equal(rescue.persona, "Dana Okonkwo");
  assert.equal(rescue.role, "Data Migration Engineer");
  assert.equal(rescue.approach, APPROACH, "the event records WHAT the attempt does differently");
  assert.equal(rescue.different, DIFFERENT, "…and WHY that is different from what failed");
  assert.equal(rescue.max_failures, 3, "the event records the ceiling it did not move");
  assert.equal(rescue.extra_attempts, 1);

  const decisions = fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8");
  assert.match(decisions, /Dana Okonkwo — Data Migration Engineer/, "the trail names the role that decided");
  assert.match(decisions, /repeated failure/, "…and the fork it decided at");
  assert.match(decisions, /Decision:\s+Take the single-row path/);
  assert.match(decisions, /Reversal:\s+Revert src\/import\.ts/, "a decision with no Reversal is not done");
  assert.match(decisions, /Charter:\s+\d+ charter rule\(s\) bind Data Migration Engineer/);
});

// --- a rescue that decides nothing is not a free extra attempt ------------------------

test("a change of approach that cannot be decided stops the run instead of buying a fourth try", async () => {
  const { root, leo } = briefRepo("Import the legacy rows");
  // The role answers with no approach in it: that is a fourth try, not a decision.
  const r = await runAlwaysFailing(root, { rescue: '{"different":"nothing concrete"}' });

  assert.equal(r.prompts.length, 3, "no extra attempt is granted when no approach was decided");
  const state = JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")) as Record<string, unknown>;
  assert.equal(state.stopped_reason, "repeated_failure");
  const events = evLines(leo);
  assert.equal(events.filter((e) => e.event === "failure_rescue_declined").length, 1,
    "and it is never silent: the log says the rescue was tried and produced nothing");
  assert.equal(events.filter((e) => e.event === "failure_rescue").length, 0);
});

// --- backward compatibility: a run that never hits the ceiling is untouched -----------

test("a run whose item succeeds spends no rescue and synthesizes no role", async () => {
  const item = "Import the legacy rows";
  const { root, leo } = briefRepo(item);
  const done = "```leopold-status\nSTATUS: done\nITEM: " + item + "\nSUMMARY: done\nNEXT: none\nEVIDENCE: build+test ok\n```";
  const prompts: string[] = [];
  let personaCalls = 0, rescueCalls = 0;

  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      return (async function* () {
        const it = (input.prompt as AsyncIterable<{ message: { content: Array<{ text: string }> } }>)[Symbol.asyncIterator]();
        const first = await it.next();
        if (!first.done) prompts.push(first.value.message.content[0].text);
        yield { type: "assistant", message: { content: [{ type: "text", text: done }] } };
        yield { type: "result", result: done, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    if (sys.includes("synthesize the ROLE")) { personaCalls += 1; return stream(PERSONA_JSON); }
    if (sys.includes("failed the maximum number of times")) { rescueCalls += 1; return stream(RESCUE_JSON); }
    if (sys.includes("the conductor")) return stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    if (sys.includes("review gate")) return stream('{"ok":true,"blocking":[],"summary":"clean"}');
    return stream('{"ok":true}');
  }) as never);

  const origLog = console.log; const origWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {}; process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await runDriver(root, ["--no-hypotheses"]); } finally {
    console.log = origLog; process.stdout.write = origWrite; resetQuery();
  }

  assert.equal(prompts.length, 1);
  assert.equal(personaCalls, 0, "no failure, no role");
  assert.equal(rescueCalls, 0, "no failure, no change of approach");
  assert.ok(!prompts[0].includes("THIS IS THE LAST ATTEMPT"), "the prompt is byte-identical to before");
  const state = JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")) as Record<string, unknown>;
  assert.equal(state.stopped_reason, "plan_complete");
  assert.equal(state.failure_rescue_used, false, "the run's rescue is still unspent");
});

test("a new run gets its rescue back: a spent flag left on disk does not deny the next run", async () => {
  const { root, leo } = briefRepo("Import the legacy rows");
  const first = await runAlwaysFailing(root);
  assert.equal(first.rescueCalls, 1);
  assert.equal(
    (JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")) as Record<string, unknown>).failure_rescue_used,
    true,
  );

  // Re-run the driver on the same brief — the failure counter resets, so the one attempt
  // that answers it resets with it. (writeState merges forward; without an explicit reset
  // the stale `true` would silently outlive the run that spent it.)
  const second = await runAlwaysFailing(root);
  assert.equal(second.rescueCalls, 1, "the new run decides its own change of approach");
  assert.equal(second.prompts.length, 4, "…and still gets exactly one extra attempt, not two");
});

// --- the pure halves: prompt, parse, format ------------------------------------------

const brief = { mission: MISSION, charter: CHARTER, guardrails: "", planPath: "", root: "", leoDir: "" } as Brief;

test("the change-of-approach prompt binds the role and forbids buying more room", () => {
  const sys = rescueSystemPrompt(brief);
  assert.match(sys, /Add a new runtime dependency/, "the charter's hard rules bind the call");
  assert.match(sys, /may not raise max_failures, max_iterations or any budget/);
  assert.ok(sys.includes(NO_EXECUTION_CLAUSE), "and it decides nothing it could execute");
  assert.match(sys, /GENUINELY DIFFERENT/);

  const ask = rescueUserPrompt({ item: "Import rows", failureContext: "batch writer rejects", failures: 3 });
  assert.match(ask, /failed 3 time\(s\) in a row/);
  assert.match(ask, /batch writer rejects/);
  assert.match(ask, /root-cause panel produced no surviving hypothesis/, "no panel → say so, do not invent one");
  assert.match(
    rescueUserPrompt({ item: "Import rows", failureContext: "x", failures: 3, panelLead: "THEORY: the loader is fine" }),
    /THEORY: the loader is fine/,
    "the panel's surviving hypothesis reaches the role that decides",
  );
});

test("a rescue with no approach or no difference is refused; the Reversal is never empty", () => {
  assert.equal(parseRescue("not json"), undefined);
  assert.equal(parseRescue('{"different":"a lot"}'), undefined, "no approach → nothing to hand the next attempt");
  assert.equal(parseRescue('{"approach":"do X"}'), undefined, "no stated difference → it is a fourth try");
  const r = parseRescue('{"approach":"do X","different":"the old one did Y"}')!;
  assert.equal(r.approach, "do X");
  assert.equal(r.decision.reversal, DEFAULT_REVERSAL);
  assert.match(r.decision.decision, /do X/, "a decision is recorded even when the role stated none");
  const fenced = parseRescue('```json\n' + RESCUE_JSON + '\n```')!;
  assert.equal(fenced.approach, APPROACH);
});

test("the lead a rescued attempt runs under carries the approach, the evidence and the role", () => {
  const parsed = parseRescue(RESCUE_JSON)!;
  const rescue: Rescue = { ...parsed, persona: undefined };
  const lead = formatRescueLead(rescue, "THEORY: the loader is fine");
  assert.match(lead, /THIS IS THE LAST ATTEMPT ON THIS ITEM/);
  assert.ok(lead.includes(APPROACH));
  assert.ok(lead.includes(DIFFERENT));
  assert.match(lead, /THEORY: the loader is fine/, "the panel evidence rides along with the approach");
  assert.match(lead, /do not fall back to the approach that already failed/);
});

// --- the parallel scheduler must not condemn an attempt it has not judged -------------
//
// The serial loop and the parallel scheduler both buy the same ONE last attempt, and the
// parallel one used to throw it away. `consecutive_failures` only drops when an item
// SETTLES, so the top-of-loop ceiling check fired again while the rescued attempt was
// still running: `rescueLead` returned null (the rescue is already spent), and the run
// broke with `repeated_failure` — abandoning the attempt it had just paid a persona
// synthesis and a root-cause panel for.
//
// The interleaving that exposes it is the ordinary one: two items in flight, the OTHER
// item's failure lands first. The fake below makes that ordering deterministic by letting
// the rescued attempt take longer than the failing one, which is precisely the real race.
test("a rescued attempt still in flight is not killed by the other item's failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-rescue-par-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".leopold/\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "MISSION.md"), `# Mission\n${MISSION}\n`);
  fs.writeFileSync(path.join(leo, "CHARTER.md"), CHARTER);
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- max_failures: 3\n- max_iterations: 12\n");
  fs.writeFileSync(path.join(leo, "PLAN.md"), "# Plan\n\n- [ ] Import the legacy rows\n- [ ] Backfill the audit table\n");

  const status = (item: string, s: "done" | "blocked") =>
    "```leopold-status\nSTATUS: " + s + "\nITEM: " + item +
    (s === "done"
      ? "\nSUMMARY: implemented and verified\nNEXT: none\nEVIDENCE: build+test ok\n```"
      : "\nSUMMARY: the batch writer rejects the payload\nNEXT: ?\nEVIDENCE: 1 failing test\n```");

  let rescuedRan = false;
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      return (async function* () {
        const ch = input.prompt as AsyncIterable<{ message: { content: Array<{ text: string }> } }>;
        const it = ch[Symbol.asyncIterator]();
        const first = await it.next();
        const text = first.done ? "" : first.value.message.content[0].text;
        const item = /Backfill/.test(text) ? "Backfill the audit table" : "Import the legacy rows";
        // Only the attempt carrying the decided approach succeeds — and it takes longer
        // than the failing one, so the other item's failure lands while it is in flight.
        if (text.includes(APPROACH)) {
          rescuedRan = true;
          await new Promise((r) => setTimeout(r, 60));
          const ok = status(item, "done");
          yield { type: "assistant", message: { content: [{ type: "text", text: ok }] } };
          yield { type: "result", result: ok, total_cost_usd: 0 };
          return;
        }
        const bad = status(item, "blocked");
        yield { type: "assistant", message: { content: [{ type: "text", text: bad }] } };
        yield { type: "result", result: bad, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    if (sys.includes("synthesize the ROLE")) return stream(PERSONA_JSON);
    if (sys.includes("failed the maximum number of times")) return stream(RESCUE_JSON);
    if (sys.includes("the conductor")) return stream('{"action":"answer","reply":"keep going"}');
    if (sys.includes("review gate")) return stream('{"ok":true,"blocking":[],"summary":"clean"}');
    return stream('{"ok":true}');
  }) as never);

  // Quiet the run through console only. Stubbing `process.stdout.write` would also
  // swallow the TEST RUNNER's own TAP output — every result that lands while the stub is
  // in place vanishes from the report and from the counters, so a suite can silently
  // shrink from 9 tests to 1 and still print "pass".
  const origLog = console.log; const origWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    await runDriver(root, ["--no-hypotheses", "--parallel", "2"]);
  } finally {
    console.log = origLog; console.warn = origWarn; resetQuery();
  }

  assert.ok(rescuedRan, "the rescued attempt never reached a worker at all");

  // The invariant, stated as the event stream tells it: once the rescue is GRANTED, the
  // attempt it bought must actually be DISPATCHED before the run may stop. With the bug
  // the next pass re-judged the ceiling while the attempt was in flight, so `stop` landed
  // straight after `failure_rescue` with no `item_start` between them.
  const events = evLines(leo).map((e) => String(e.event));
  const granted = events.indexOf("failure_rescue");
  assert.ok(granted >= 0, "the ceiling was never reached, so this proves nothing");
  const after = events.slice(granted + 1);
  const dispatched = after.indexOf("item_start");
  const stopped = after.indexOf("stop");
  assert.ok(
    dispatched >= 0 && (stopped < 0 || dispatched < stopped),
    "the rescued attempt was abandoned: the scheduler judged the ceiling again while the " +
      `attempt was still in flight and stopped the run. Events after the rescue: ${after.slice(0, 8).join(", ")}`,
  );
  const stoppedReason = JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")).stopped_reason;
  assert.notEqual(
    stoppedReason, "repeated_failure",
    "the run stopped with repeated_failure even though the attempt it paid for had not been judged",
  );
});
