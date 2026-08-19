// End-to-end persona conduction with ZERO model calls. The whole conductor ↔
// persona-worker exchange reaches a harness only through the one seam in
// src/sdk.ts; here a deterministic fake (setQuery) plays the workers and the
// summary turn, and the real conductCast does everything else: journal
// contract, bound enforcement, stall handling, window continuity, fan-out,
// findings, report, notify. Hermetic: every run lives in a temp dir.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setQuery, resetQuery } from "../src/sdk.ts";
import {
  TURN_FENCE,
  OUTCOME_FENCE,
  IRREVERSIBLE_SIGNAL,
  checkBounds,
  nextBlock,
  conductCast,
  turnIdOf,
  type ConductOptions,
} from "../src/persona-testing/conduct.ts";
import { JOURNEY_FILE, JOURNEY_SCHEMA, headerLine, parseJourney } from "../src/persona-testing/journey.ts";
import { parseFlow } from "../src/persona-testing/flow.ts";

afterEach(() => resetQuery());

// -- Fixtures -----------------------------------------------------------------

const NOW = () => new Date("2026-08-18T12:00:00.000Z");

const FLOW_TEXT = `# Flow — checkout

## Entry point
https://shop.example.com/

## Goal
Buy the starter plan as a first-time visitor.

## Success criteria
- reaches the order confirmation screen

## Domain allowlist (hard boundary)
- shop.example.com

## Out of bounds
- submitting a real payment

## App version pin
the git commit of the deployed build

## Step budget
max_turns: 10
`;

function contractText(id: string, status = "ready"): string {
  return `schema_version: "persona-contract/1.0"\npersona_id: "${id}"\ncontract_status: "${status}"\n`;
}

/** A hermetic project: root, .leopold, .leopold/persona with a flow + contracts. */
function tmpProject(personas: Array<{ id: string; status?: string }>): {
  root: string;
  leoDir: string;
  personaDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-persona-conduct-"));
  const leoDir = path.join(root, ".leopold");
  const personaDir = path.join(leoDir, "persona");
  fs.mkdirSync(path.join(personaDir, "flows"), { recursive: true });
  fs.writeFileSync(path.join(personaDir, "flows", "checkout.md"), FLOW_TEXT);
  for (const p of personas) {
    const dir = path.join(personaDir, "personas", p.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "contract.yaml"), contractText(p.id, p.status ?? "ready"));
  }
  return { root, leoDir, personaDir };
}

function opts(p: ReturnType<typeof tmpProject>, over: Partial<ConductOptions> = {}): ConductOptions {
  return {
    root: p.root,
    leoDir: p.leoDir,
    personaDir: p.personaDir,
    flow: "checkout",
    personas: "all",
    parallel: 1,
    appVersion: "1.2.3",
    now: NOW,
    ...over,
  };
}

function turnObj(persona: string, n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: JOURNEY_SCHEMA,
    turn_id: turnIdOf(n),
    persona_id: persona,
    persona_response: `turn ${n} as ${persona}`,
    observed_behavior: {
      intended_action: "click the continue button",
      continuation_intent: "keep going",
      friction_points: [],
      comprehension: "clear enough",
    },
    state_delta: { newly_perceived: [`fact-${n}`], next_action: "continue" },
    declared_navigations: [],
    ...extra,
  };
}

const fenced = (tag: string, obj: unknown): string => "```" + tag + "\n" + JSON.stringify(obj) + "\n```";
const outcomeBlock = (outcome: string, detail: string): string =>
  fenced(OUTCOME_FENCE, { outcome, detail });

type Msg = { type: string; message?: { content: Array<{ type: string; text: string }> }; result?: string };
const A = (text: string): Msg => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const R: Msg = { type: "result" };

/** A channel-blind scripted provider: per worker launch, a fixed list of
 *  assistant texts, chosen by persona id and launch number. Summary calls
 *  (string prompt) answer with a fixed line. */
function scriptedQuery(
  perLaunch: (info: { persona: string; prompt: string; launch: number }) => string[],
): void {
  const launches = new Map<string, number>();
  setQuery(((input: { prompt: unknown }) =>
    (async function* (): AsyncGenerator<Msg> {
      if (typeof input.prompt === "string") {
        yield A("Cast summary: see findings.");
        yield { type: "result", result: "Cast summary: see findings." };
        return;
      }
      let first = "";
      for await (const m of input.prompt as AsyncIterable<{ message: { content: Array<{ text: string }> } }>) {
        first = m.message.content[0].text;
        break;
      }
      const persona = /Persona under enactment: (\S+)\./.exec(first)?.[1] ?? "?";
      const launch = (launches.get(persona) ?? 0) + 1;
      launches.set(persona, launch);
      for (const text of perLaunch({ persona, prompt: first, launch })) yield A(text);
      yield R;
    })()) as never);
}

function journalLines(runDir: string, persona: string): string[] {
  const text = fs.readFileSync(path.join(runDir, persona, JOURNEY_FILE), "utf8");
  return text.split("\n").filter((l) => l !== "");
}

// -- The pure bounds (unit) ---------------------------------------------------

test("checkBounds: an off-allowlist URL in the vendored intended_action prose fails closed", () => {
  const flow = parseFlow(FLOW_TEXT);
  assert.equal(flow.status, "ok");
  if (flow.status !== "ok") return;
  const turn = turnObj("ana", 1, {
    observed_behavior: { intended_action: "follow the link to https://evil.example.net/deal" },
  });
  const verdict = checkBounds(flow.flow, turn as never);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.rule, "allowlist");
});

test("checkBounds: subdomains pass, lookalike hosts do not", () => {
  const flow = parseFlow(FLOW_TEXT);
  if (flow.status !== "ok") return assert.fail("flow");
  const sub = turnObj("ana", 1, { declared_navigations: ["https://www.shop.example.com/cart"] });
  assert.equal(checkBounds(flow.flow, sub as never).ok, true);
  const evil = turnObj("ana", 1, { declared_navigations: ["https://shop.example.com.evil.io/cart"] });
  assert.equal(checkBounds(flow.flow, evil as never).ok, false);
});

test("checkBounds: a declared deletion reads as irreversible", () => {
  const flow = parseFlow(FLOW_TEXT);
  if (flow.status !== "ok") return assert.fail("flow");
  const turn = turnObj("ana", 1, { observed_behavior: { intended_action: "delete my account to start over" } });
  const verdict = checkBounds(flow.flow, turn as never);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.rule, "irreversible");
  assert.ok(IRREVERSIBLE_SIGNAL.test("press the Pay now button"), "payment phrasing must trip the signal");
});

test("nextBlock waits for a complete fence and returns the earliest block", () => {
  assert.equal(nextBlock("```" + TURN_FENCE + "\n{\"half\":"), undefined);
  const text = "noise " + fenced(TURN_FENCE, { a: 1 }) + " tail " + fenced(OUTCOME_FENCE, { outcome: "succeeded" });
  const block = nextBlock(text);
  assert.equal(block?.tag, TURN_FENCE);
  assert.deepEqual(JSON.parse(block!.body), { a: 1 });
});

// -- @scenario a stubbed worker emitting 3 valid turns then success ----------

test("three valid turns then success: journal has header + 3 turns, FINDINGS and REPORT exist, cast is ok", async () => {
  const p = tmpProject([{ id: "ana" }]);
  scriptedQuery(({ persona }) => [
    fenced(TURN_FENCE, turnObj(persona, 1)),
    fenced(TURN_FENCE, turnObj(persona, 2)),
    fenced(TURN_FENCE, turnObj(persona, 3)),
    outcomeBlock("succeeded", "reached the confirmation screen"),
  ]);

  const result = await conductCast(opts(p));
  assert.equal(result.status, "ok"); // the exit-0 analog: the cast conducted end to end
  if (result.status !== "ok") return;
  assert.deepEqual(result.personas[0].result, {
    status: "completed",
    outcome: "succeeded",
    detail: "reached the confirmation screen",
    turns: 3,
  });

  const lines = journalLines(result.runDir, "ana");
  assert.equal(lines.length, 4); // header + 3 turns, nothing else
  assert.equal(
    lines[0],
    headerLine({
      journey_schema: JOURNEY_SCHEMA,
      flow: "checkout",
      persona: "ana",
      app_version: "1.2.3",
      started_at: "2026-08-18T12:00:00.000Z",
    }),
  );
  const parsed = parseJourney(lines.join("\n") + "\n");
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.deepEqual(parsed.journey.turns.map((t) => t.turn_id), ["turn-1", "turn-2", "turn-3"]);

  assert.ok(fs.existsSync(path.join(result.runDir, "ana", "FINDINGS.md")), "FINDINGS.md exists");
  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.ok(report.startsWith("# Persona run report — checkout"));
  assert.ok(report.includes("- app version: 1.2.3"), "app version pinned in the report");
  assert.ok(report.includes("Cast summary: see findings."), "the executive summary was spliced in");

  // The event stream carries what `leopold insights` reads: the cast start, one
  // persona_turn per enacted turn, the outcome, and a persona_findings count.
  const events = fs
    .readFileSync(path.join(p.leoDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(events.filter((e) => e.event === "persona_run_start").length, 1);
  assert.equal(events.filter((e) => e.event === "persona_turn").length, 3);
  assert.equal(events.filter((e) => e.event === "persona_outcome").length, 1);
  const findingsEv = events.filter((e) => e.event === "persona_findings");
  assert.equal(findingsEv.length, 1, "one persona_findings event per persona");
  assert.equal(findingsEv[0].persona, "ana");
  assert.equal(typeof findingsEv[0].count, "number");
});

// -- @scenario navigation outside the allowlist ------------------------------

test("off-allowlist navigation stops that persona with reason allowlist; the journal's last line records it; others continue", async () => {
  const p = tmpProject([{ id: "bad" }, { id: "good" }]);
  scriptedQuery(({ persona }) =>
    persona === "bad"
      ? [fenced(TURN_FENCE, turnObj("bad", 1, { declared_navigations: ["https://evil.io/steal"] }))]
      : [fenced(TURN_FENCE, turnObj("good", 1)), outcomeBlock("succeeded", "done")],
  );

  const result = await conductCast(opts(p));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const byId = new Map(result.personas.map((x) => [x.personaId, x.result]));

  const bad = byId.get("bad");
  assert.equal(bad?.status, "stopped");
  if (bad?.status === "stopped") assert.equal(bad.reason, "allowlist");
  assert.equal(byId.get("good")?.status, "completed", "the rest of the cast still runs");

  const lines = journalLines(result.runDir, "bad");
  const last = JSON.parse(lines[lines.length - 1]) as { journey_stop?: { reason: string } };
  assert.equal(last.journey_stop?.reason, "allowlist", "the journal's last line records the violation");
  const offending = JSON.parse(lines[lines.length - 2]) as { bound_violation?: { rule: string } };
  assert.equal(offending.bound_violation?.rule, "allowlist", "the offending turn carries the stamp");

  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.ok(report.includes("[major] bound"), "the violation distills into a report finding");
});

// -- @scenario a declared payment submit -------------------------------------

test("a declared payment submit is never executed: no ACT reply reaches the worker, and it lands as a finding", async () => {
  const p = tmpProject([{ id: "payer" }]);
  const replies: string[] = [];
  setQuery(((input: { prompt: unknown }) =>
    (async function* (): AsyncGenerator<Msg> {
      if (typeof input.prompt === "string") {
        yield { type: "result", result: "s" };
        return;
      }
      const it = (input.prompt as AsyncIterable<{ message: { content: Array<{ text: string }> } }>)[
        Symbol.asyncIterator
      ]();
      await it.next(); // the base prompt
      yield A(
        fenced(
          TURN_FENCE,
          turnObj("payer", 1, {
            observed_behavior: { intended_action: "press the Pay now button to submit payment" },
          }),
        ),
      );
      const next = await it.next(); // an ACT reply would arrive here; a stop closes the channel instead
      if (!next.done) replies.push(next.value.message.content[0].text);
      yield R;
    })()) as never);

  const result = await conductCast(opts(p));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const payer = result.personas[0].result;
  assert.equal(payer.status, "stopped");
  if (payer.status === "stopped") assert.equal(payer.reason, "irreversible");
  assert.deepEqual(
    replies.filter((r) => r.startsWith("ACT:")),
    [],
    "the conductor never told the worker to execute the payment",
  );

  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.ok(report.includes('bound "irreversible"'), "the withheld payment is a finding, not an action");
  const findings = fs.readFileSync(path.join(result.runDir, "payer", "FINDINGS.md"), "utf8");
  assert.ok(findings.includes('bound "irreversible"'));
});

// -- @scenario garbage instead of a turn --------------------------------------

test("garbage instead of a turn: one retry lead, then that persona fails loudly while the cast continues", async () => {
  const p = tmpProject([{ id: "ghost" }, { id: "solid" }]);
  const prompts: string[] = [];
  let ghostLaunches = 0;
  scriptedQuery(({ persona, prompt, launch }) => {
    if (persona === "ghost") {
      ghostLaunches = launch;
      prompts.push(prompt);
      return ["lol I forgot how to output turns"];
    }
    return [fenced(TURN_FENCE, turnObj("solid", 1)), outcomeBlock("succeeded", "done")];
  });

  const result = await conductCast(opts(p));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const byId = new Map(result.personas.map((x) => [x.personaId, x.result]));

  const ghost = byId.get("ghost");
  assert.equal(ghost?.status, "failed");
  if (ghost?.status === "failed") assert.match(ghost.reason, /no valid turn after one retry/);
  assert.equal(ghostLaunches, 2, "exactly one retry launch, then the failure");
  assert.ok(prompts[1].includes("This is your one retry"), "the second launch carries the retry lead");
  assert.equal(byId.get("solid")?.status, "completed", "the cast run continues");

  const lines = journalLines(result.runDir, "ghost");
  const last = JSON.parse(lines[lines.length - 1]) as { journey_stop?: { reason: string } };
  assert.equal(last.journey_stop?.reason, "stall");
  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.ok(report.includes("conductor stop: stall"), "the report names the failure");
});

// -- @scenario kill the worker after turn N, relaunch (continuity) -----------

test("window roll: the relaunch resumes from the journal — next line is turn N+1, nothing lost, nothing repeated", async () => {
  const p = tmpProject([{ id: "ana" }]);
  const secondPrompts: string[] = [];
  scriptedQuery(({ prompt, launch }) => {
    if (launch === 1)
      // the window dies after two journaled turns — no outcome, no goodbye
      return [fenced(TURN_FENCE, turnObj("ana", 1)), fenced(TURN_FENCE, turnObj("ana", 2))];
    secondPrompts.push(prompt);
    return [fenced(TURN_FENCE, turnObj("ana", 3)), outcomeBlock("succeeded", "made it after the roll")];
  });

  const result = await conductCast(opts(p));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.personas[0].result, {
    status: "completed",
    outcome: "succeeded",
    detail: "made it after the roll",
    turns: 3,
  });

  // The relaunch prompt reseeds from the journal tail: last state, next id.
  assert.equal(secondPrompts.length, 1);
  assert.ok(secondPrompts[0].includes("PRIOR_STATE (from turn turn-2)"), "reseed carries the tail state_delta");
  assert.ok(secondPrompts[0].includes("TURN_ID turn-3"), "the relaunch is told the next turn id");

  const parsed = parseJourney(journalLines(result.runDir, "ana").join("\n") + "\n");
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.deepEqual(
    parsed.journey.turns.map((t) => t.turn_id),
    ["turn-1", "turn-2", "turn-3"],
    "nothing lost, nothing repeated",
  );
});

test("a relaunched worker that repeats an already-journaled turn is refused (the duplicate never lands)", async () => {
  const p = tmpProject([{ id: "ana" }]);
  scriptedQuery(({ launch }) => {
    if (launch === 1) return [fenced(TURN_FENCE, turnObj("ana", 1))];
    // the roll replays turn-1 (wrong), then corrects to turn-2 after the retry lead
    return [
      fenced(TURN_FENCE, turnObj("ana", 1)),
      fenced(TURN_FENCE, turnObj("ana", 2)),
      outcomeBlock("abandoned", "too confusing"),
    ];
  });
  const result = await conductCast(opts(p));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const parsed = parseJourney(journalLines(result.runDir, "ana").join("\n") + "\n");
  if (parsed.status !== "ok") return assert.fail("journal unreadable");
  assert.deepEqual(parsed.journey.turns.map((t) => t.turn_id), ["turn-1", "turn-2"]);
});

// -- @scenario --persona all --parallel 2 with 3 personas ---------------------

test("cast fan-out: 3 personas at parallel 2 — three journals in distinct subdirs, one REPORT.md ranking across them", async () => {
  const p = tmpProject([{ id: "p1" }, { id: "p2" }, { id: "p3" }]);
  let active = 0;
  let peak = 0;
  const launches = new Map<string, number>();
  setQuery(((input: { prompt: unknown }) =>
    (async function* (): AsyncGenerator<Msg> {
      if (typeof input.prompt === "string") {
        yield A("Cast summary: see findings.");
        yield { type: "result", result: "Cast summary: see findings." };
        return;
      }
      active += 1;
      peak = Math.max(peak, active);
      try {
        let first = "";
        for await (const m of input.prompt as AsyncIterable<{ message: { content: Array<{ text: string }> } }>) {
          first = m.message.content[0].text;
          break;
        }
        const persona = /Persona under enactment: (\S+)\./.exec(first)?.[1] ?? "?";
        launches.set(persona, (launches.get(persona) ?? 0) + 1);
        // p1 and p2 hit the SAME wall (friction at the same step); p3 sails through.
        const friction = persona === "p3" ? [] : ["the price is hidden until the last step"];
        yield A(
          fenced(
            TURN_FENCE,
            turnObj(persona, 1, {
              flow_step: "plans",
              observed_behavior: {
                intended_action: "click the continue button",
                continuation_intent: "keep going",
                friction_points: friction,
                comprehension: "clear",
              },
            }),
          ),
        );
        yield A(outcomeBlock("succeeded", "done"));
        yield R;
      } finally {
        active -= 1;
      }
    })()) as never);

  const result = await conductCast(opts(p, { parallel: 2 }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(peak <= 2, `parallel bound held (peak ${peak})`);
  assert.deepEqual([...launches.keys()].sort(), ["p1", "p2", "p3"]);

  for (const id of ["p1", "p2", "p3"])
    assert.ok(fs.existsSync(path.join(result.runDir, id, JOURNEY_FILE)), `journal for ${id} in its own subdir`);

  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.ok(report.includes("personas hit: 2 (p1, p2)"), "the shared wall is ranked across personas");
  for (const id of ["p1", "p2", "p3"]) assert.ok(report.includes(`### ${id}`), `journey summary for ${id}`);
});

// -- Preflight and gating -----------------------------------------------------

test("a draft contract is skipped as data — reported, never enacted, never a run subdir", async () => {
  const p = tmpProject([{ id: "ana" }, { id: "drafty", status: "draft" }]);
  scriptedQuery(() => [fenced(TURN_FENCE, turnObj("ana", 1)), outcomeBlock("succeeded", "done")]);
  const result = await conductCast(opts(p));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const byId = new Map(result.personas.map((x) => [x.personaId, x.result]));
  assert.equal(byId.get("drafty")?.status, "skipped");
  assert.ok(!fs.existsSync(path.join(result.runDir, "drafty")), "a skipped persona leaves no run subdir");
});

test("a missing flow is a loud error, not a run", async () => {
  const p = tmpProject([{ id: "ana" }]);
  scriptedQuery(() => []);
  const result = await conductCast(opts(p, { flow: "nope" }));
  assert.equal(result.status, "error");
  if (result.status === "error") assert.match(result.reason, /no flow at/);
});
