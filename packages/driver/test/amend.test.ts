// Feedback nodes: the run may improve its own plan, and may NOT run away with it.
//
// Two halves, both proven here:
//
//   the bounds       judgeAmendments is pure, so every bound is asserted without a
//                    model, a repo or a clock — and each refusal is asserted by its
//                    BOUND CODE, not by prose that could drift;
//   the loop         the real driver, driven end to end with a deterministic fake
//                    harness (zero model calls), so what actually lands on disk —
//                    PLAN.md, DECISIONS.md, events.jsonl, state.json — is the evidence.
//
// The bar every scenario in the plan item states:
//   2 proposed  -> both appended, two DECISIONS.md entries, each with a Reversal line
//   5 proposed  -> the first 3 applied, the rest refused and logged with the bound
//   a delete    -> refused, logged, PLAN.md byte-identical on disk
//   GUARDRAILS  -> refused, logged, the file's bytes unchanged
//   no feedback -> byte-identical behavior to a plan written before this existed
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver, buildWorkerPrompt } from "../src/loop.ts";
import { parsePlan, setItemDone } from "../src/plan.ts";
import { isFeedback, isReadOnlyNode, isReviewOnly, EDIT_TOOLS } from "../src/kinds.ts";
import {
  parseAmendments, judgeAmendments, applyAmendments, MAX_ADDED_ITEMS, MAX_ITEM_TEXT,
  type AmendBound,
} from "../src/amend.ts";
import { compileBrief } from "../src/compile.ts";
import { summarize, renderInsights } from "../src/insights.ts";
import { runWorkflow, workflowPath, type Responder } from "./workflow-harness.ts";

// --- the bounds, as pure functions ------------------------------------------------

const PLAN3 = "# Plan\n\n- [x] Ship the parser\n- [ ] Wire the scheduler\n- [ ] Write the docs\n";

/** Judge one block of proposal lines against `PLAN3`, with a full budget by default. */
function judge(lines: string, remaining = MAX_ADDED_ITEMS, planText = PLAN3) {
  return judgeAmendments(planText, parseAmendments("```leopold-amend\n" + lines + "\n```"), remaining);
}
const bounds = (j: { refused: Array<{ bound: AmendBound }> }): AmendBound[] => j.refused.map((r) => r.bound);

test("a turn with no leopold-amend block proposes nothing at all", () => {
  assert.deepEqual(parseAmendments("I read the log. The plan is right; I propose nothing."), []);
  assert.deepEqual(parseAmendments("```leopold-status\nSTATUS: done\n```"), []);
  // Restating proposals replaces them — the last block wins, exactly as parseStatus does.
  const p = parseAmendments("```leopold-amend\nADD: first idea\n```\nthinking again…\n```leopold-amend\nADD: better idea\n```");
  assert.deepEqual(p.map((x) => x.text), ["better idea"]);
});

test("proposals parse the way a human writes them, verb and all", () => {
  const p = parseAmendments([
    "```leopold-amend",
    "ADD: Add a regression test for the routing latch",
    "- add Backfill the docs",
    "DELETE: item 2",
    "EDIT 3: rewrite the docs item",
    "GUARDRAILS: raise max_failures to 10",
    "NONE",
    "please also consider retrying",
    "```",
  ].join("\n"));
  assert.deepEqual(p.map((x) => x.op), ["add", "add", "delete", "edit", "guardrails", "unknown"]);
  assert.equal(p[0].text, "Add a regression test for the routing latch");
  assert.equal(p[1].text, "Backfill the docs");
  assert.equal(p[2].target, 2);
  assert.equal(p[3].target, 3);
});

test("an accepted amendment is APPENDED, so no existing item's index moves", () => {
  const j = judge("ADD: Add a regression test for the latch\nADD: Backfill the pt-BR docs");
  assert.deepEqual(j.accepted.map((a) => a.index), [4, 5]);
  assert.deepEqual(j.refused, []);
  const after = parsePlan(j.planText);
  assert.equal(after.length, 5);
  // Every pre-existing item is untouched, in place, with its state intact.
  assert.deepEqual(after.slice(0, 3).map((i) => [i.index, i.text, i.done]),
    parsePlan(PLAN3).map((i) => [i.index, i.text, i.done]));
  assert.deepEqual(after.slice(3).map((i) => [i.text, i.done, i.kind]), [
    ["Add a regression test for the latch", false, "work"],
    ["Backfill the pt-BR docs", false, "work"],
  ]);
  // The original text is a PREFIX of the amended one: nothing was rewritten.
  assert.ok(j.planText.startsWith(PLAN3), "an amendment only ever appends");
});

test("the add budget is 3 per run, and it counts what the run already spent", () => {
  const five = "ADD: one\nADD: two\nADD: three\nADD: four\nADD: five";
  const fresh = judge(five);
  assert.deepEqual(fresh.accepted.map((a) => a.text), ["one", "two", "three"]);
  assert.deepEqual(bounds(fresh), ["add-budget", "add-budget"]);
  assert.match(fresh.refused[0].reason, /at most 3 items per run/);
  assert.match(fresh.refused[0].reason, /3 already added this run/);

  // A run that already added 2 may add exactly 1 more.
  const partial = judge(five, MAX_ADDED_ITEMS - 2);
  assert.deepEqual(partial.accepted.map((a) => a.text), ["one"]);
  assert.equal(partial.refused.length, 4);
  // A spent budget applies nothing and leaves the plan text untouched.
  const spent = judge(five, 0);
  assert.deepEqual(spent.accepted, []);
  assert.equal(spent.planText, PLAN3);
});

test("delete, edit, GUARDRAILS and gibberish are each refused by their own bound", () => {
  assert.deepEqual(bounds(judge("DELETE: item 2")), ["no-delete"]);
  assert.deepEqual(bounds(judge("DELETE: item 1")), ["no-delete"], "even a done item is not deletable");
  assert.deepEqual(bounds(judge("EDIT 1: reword the shipped parser item")), ["no-touch-done"]);
  assert.deepEqual(bounds(judge("EDIT 2: reword the scheduler item")), ["add-only"]);
  assert.deepEqual(bounds(judge("GUARDRAILS: raise max_failures to 10")), ["no-guardrails"]);
  assert.deepEqual(bounds(judge("just let me run three more times")), ["add-only"]);
  // Each refusal states the rule, so the log reads as a diagnostic and not as a code.
  assert.match(judge("EDIT 1: x").refused[0].reason, /never touch an item already marked done/);
  assert.match(judge("EDIT 1: x").refused[0].reason, /item 1 is already marked done/);
  assert.match(judge("GUARDRAILS: x").refused[0].reason, /never edit GUARDRAILS\.md/);
});

test("an added item is a plain work item — a feedback node cannot author a node kind", () => {
  for (const marker of ["@tool make release", "@human Approve the deploy", "@gate Judge it", "@feedback Read the run", "@node tool `rm -rf /`"]) {
    assert.deepEqual(bounds(judge(`ADD: ${marker}`)), ["work-only"], marker);
  }
  // And the bound is not evaded by hiding the marker behind a dependency marker.
  assert.deepEqual(bounds(judge("ADD: (after: 2) @tool `make release`")), ["work-only"]);
  // A plain item that merely mentions a tool is fine — the bound is about the MARKER.
  assert.deepEqual(judge("ADD: Run make test in CI as well").refused, []);
});

test("a malformed item is refused instead of being appended as junk", () => {
  assert.deepEqual(bounds(judge("ADD:")), ["malformed"]);
  assert.deepEqual(bounds(judge("ADD: " + "x".repeat(MAX_ITEM_TEXT + 1))), ["malformed"]);
  assert.deepEqual(bounds(judge("ADD: (after: 9) Fix the thing")), ["malformed"]);
  assert.match(judge("ADD: (after: 9) Fix it").refused[0].reason, /depends on item 9, which does not exist/);
  // A dependency on an item that DOES exist is honored, and parses back as a real dep.
  const ok = judge("ADD: (after: 2) Fix what item 2 leaves open");
  assert.deepEqual(ok.refused, []);
  assert.deepEqual(parsePlan(ok.planText)[3].deps, [2]);
});

test("the wrapping a model puts around an item is stripped, not appended", () => {
  const j = judge('ADD: - [ ] "Add the missing pt-BR twin"');
  assert.equal(j.accepted[0].line, "- [ ] Add the missing pt-BR twin");
  // A checkbox cannot be smuggled in pre-checked: the driver writes the box, not the node.
  const sneaky = judge("ADD: [x] Pretend this is already done");
  assert.equal(sneaky.accepted[0].line, "- [ ] Pretend this is already done");
  assert.equal(parsePlan(sneaky.planText)[3].done, false);
});

test("a batch that is entirely refused never opens PLAN.md for writing at all", () => {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-amend-io-"));
  const planPath = path.join(leo, "PLAN.md");
  // No trailing newline on purpose: a plan that is written back "unchanged" after
  // normalization would still differ here, and it must not be written back at all.
  fs.writeFileSync(planPath, "- [x] shipped\n- [ ] pending");
  const before = fs.statSync(planPath);
  const r = applyAmendments(
    { leoDir: leo, planPath, by: 1, byText: "Read the run", alreadyAdded: 0 },
    parseAmendments("```leopold-amend\nDELETE: 2\nGUARDRAILS: unlock git push\nEDIT 1: reword it\n```"),
  );
  assert.equal(r.added, 0);
  assert.deepEqual(r.refused.map((x) => x.bound), ["no-delete", "no-guardrails", "no-touch-done"]);
  assert.equal(fs.readFileSync(planPath, "utf8"), "- [x] shipped\n- [ ] pending");
  assert.equal(fs.statSync(planPath).mtimeMs, before.mtimeMs, "the plan was never opened for writing");
  assert.ok(!fs.existsSync(path.join(leo, "DECISIONS.md")), "nothing was accepted, so nothing is logged as accepted");
  const refusals = fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(refusals.map((e) => e.bound), ["no-delete", "no-guardrails", "no-touch-done"]);
});

test("the kind predicates put a feedback node on the read-only path", () => {
  assert.equal(isFeedback("feedback"), true);
  assert.equal(isReviewOnly("feedback"), false, "it judges the RUN, not a diff");
  assert.equal(isReadOnlyNode("feedback"), true);
  for (const k of ["work", "gate", "human", "tool", "verify"] as const) assert.equal(isFeedback(k), false);
  const [n] = parsePlan("- [ ] @feedback health Read the run\n");
  assert.equal(n.kind, "feedback");
  assert.equal(n.kindLabel, "health");
  assert.equal(n.text, "Read the run");
});

// --- the loop, end to end with a fake harness --------------------------------------

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function briefRepo(plan: string): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-amend-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  // Real projects gitignore the brief (Leopold's own repo does), which is exactly why a
  // write under `.leopold/` is invisible to any git-based signature. Reproduce that here
  // or the receipt test proves nothing.
  fs.writeFileSync(path.join(root, ".gitignore"), ".leopold/\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "MISSION.md"), "# Mission\nShip it.\n");
  fs.writeFileSync(path.join(leo, "CHARTER.md"), "# Charter\nSimplicity.\n");
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), GUARDRAILS);
  fs.writeFileSync(path.join(leo, "PLAN.md"), plan);
  return { root, leo };
}

const GUARDRAILS = "# Guardrails\n- max_failures: 3\n- max_iterations: 30\n- amendments: at most 3 per run\n";

const events = (leo: string): Array<Record<string, unknown>> =>
  fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const eventsOf = (leo: string, name: string): Array<Record<string, unknown>> =>
  events(leo).filter((e) => e.event === name);
const planOf = (leo: string): string => fs.readFileSync(path.join(leo, "PLAN.md"), "utf8");
const decisionsOf = (leo: string): string => {
  const p = path.join(leo, "DECISIONS.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};

function stream(text: string) {
  return (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    yield { type: "result", result: text, total_cost_usd: 0 };
  })();
}

type ChannelMessage = { message?: { content?: Array<{ text?: string }> } };
async function firstPrompt(channel: unknown): Promise<string> {
  const it = (channel as AsyncIterable<ChannelMessage>)[Symbol.asyncIterator]();
  const first = await it.next();
  return first.value?.message?.content?.[0]?.text ?? "";
}

interface Session { prompt: string; options: Record<string, unknown> }
interface Fake { sessions: Session[] }

/** A harness that answers every role deterministically. A FEEDBACK session — recognized
 *  by its system prompt, exactly as the real one is built — answers with `amend` as its
 *  proposal block; every other session reports a plain `done`.
 *
 *  `sideEffect` runs inside the feedback session, standing in for a node that went
 *  around the proposal channel and wrote a file with its shell. */
function installFake(amend: string | null = null, sideEffect?: () => void): Fake {
  const f: Fake = { sessions: [] };
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      const append = String((sp as { append?: unknown }).append ?? "");
      return (async function* () {
        const text = await firstPrompt(input.prompt);
        f.sessions.push({ prompt: text, options: (input.options ?? {}) as Record<string, unknown> });
        const item =
          (text.match(/Work on this plan item now:\n\n([\s\S]*?)\n\n/) ??
            text.match(/you may NOT edit anything:\n\n([\s\S]*?)\n\n/) ?? [])[1]?.trim() ?? "";
        const isFeedbackNode = /FEEDBACK node/.test(append);
        if (isFeedbackNode && sideEffect) sideEffect();
        const block =
          (isFeedbackNode && amend ? "```leopold-amend\n" + amend + "\n```\n\n" : "") +
          "```leopold-status\nSTATUS: done\nITEM: " + item +
          "\nSUMMARY: " + (isFeedbackNode ? "read the run" : "implemented and verified") +
          "\nNEXT: none\nEVIDENCE: events.jsonl\n```";
        yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
        yield { type: "result", result: block, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    if (sys.includes("the conductor")) {
      return /STATUS:\s*blocked/i.test(prompt)
        ? stream('{"action":"answer","reply":"try another angle","classification":"reversible","charterBasis":"retry"}')
        : stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    }
    return stream('{"ok":true,"blocking":[],"summary":"clean"}');
  }) as never);
  return f;
}

async function drive(root: string, argv: string[]): Promise<void> {
  const log = console.log, warn = console.warn, write = process.stdout.write.bind(process.stdout);
  console.log = () => {}; console.warn = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { await runDriver(root, argv); }
  finally { console.log = log; console.warn = warn; process.stdout.write = write; resetQuery(); }
}

const BASE = ["--no-review", "--no-hypotheses", "--no-literal-reset"];

const FEEDBACK_PLAN = `# Plan

- [ ] Build the thing
- [ ] (after: 1) @feedback health Read the run and improve the plan if the evidence demands it
`;

test("a feedback node proposing 2 items appends both, with two reversible DECISIONS entries", async () => {
  const { root, leo } = briefRepo(FEEDBACK_PLAN);
  const fake = installFake("ADD: Add a regression test for the routing latch\nADD: Backfill the pt-BR docs twin");
  await drive(root, BASE);

  // Both items are in the plan, appended after the two authored ones.
  const items = parsePlan(planOf(leo));
  assert.deepEqual(items.map((i) => i.index), [1, 2, 3, 4]);
  assert.deepEqual(items.slice(2).map((i) => i.text), [
    "Add a regression test for the routing latch",
    "Backfill the pt-BR docs twin",
  ]);
  // And they RAN — an amendment the run cannot execute is a note, not an amendment.
  for (const t of items.slice(2)) {
    assert.ok(fake.sessions.some((s) => s.prompt.includes(t.text)), `item ${t.index} was dispatched`);
    assert.equal(t.done, true, `item ${t.index} closed`);
  }

  // Two DECISIONS.md blocks, each carrying the full contract INCLUDING a Reversal line.
  const blocks = decisionsOf(leo).split(/^## /m).filter((b) => b.startsWith("Plan amended"));
  assert.equal(blocks.length, 2, "one decision block per accepted amendment");
  for (const b of blocks) {
    for (const field of ["Fork:", "Class:", "Charter:", "Decision:", "Why:", "Reversal:"]) {
      assert.match(b, new RegExp(`^${field}`, "m"), `${field} present`);
    }
    assert.match(b, /^Reversal:\s+delete the line "- \[ \] .+" at the end of .+PLAN\.md/m);
  }
  assert.equal(eventsOf(leo, "amendment").length, 2);
  assert.deepEqual(eventsOf(leo, "amendment_refused"), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")).amendments_added, 2);

  // The node that proposed them never touched a file: no write tool was available to it.
  const fb = fake.sessions.find((s) => /FEEDBACK node/.test(String((s.options.systemPrompt as { append?: string }).append)))!;
  assert.deepEqual(fb.options.disallowedTools, [...EDIT_TOOLS]);
  assert.match(fb.prompt, /^Run this feedback item now/);
  // Nothing was committed; the human still ships.
  assert.equal(sh(root, ["log", "--oneline"]).trim().split("\n").length, 1);
});

test("a feedback node proposing 5 items applies the first 3 and logs the bound that refused the rest", async () => {
  const { root, leo } = briefRepo(FEEDBACK_PLAN);
  installFake(["ADD: one", "ADD: two", "ADD: three", "ADD: four", "ADD: five"].join("\n"));
  await drive(root, BASE);

  assert.deepEqual(parsePlan(planOf(leo)).slice(2).map((i) => i.text), ["one", "two", "three"]);
  assert.equal(eventsOf(leo, "amendment").length, MAX_ADDED_ITEMS);

  const refused = eventsOf(leo, "amendment_refused");
  assert.equal(refused.length, 2);
  for (const r of refused) {
    assert.equal(r.bound, "add-budget", "the refusal names the bound that refused it");
    assert.match(String(r.reason), /at most 3 items per run/);
    assert.equal(r.item, 2, "and the feedback node that proposed it");
  }
  assert.deepEqual(refused.map((r) => r.proposal), ["ADD: four", "ADD: five"]);
  assert.equal(decisionsOf(leo).split(/^## /m).filter((b) => b.startsWith("Plan amended")).length, 3,
    "only accepted amendments reach the decision trail");

  // A run that rewrote its own plan says so in the report a human reads afterwards.
  const lines = fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").split("\n");
  const report = summarize(lines, {});
  assert.deepEqual(report.amendments, { applied: 3, refused: 2 });
  assert.match(renderInsights(report), /Plan amendments {2}3 applied · 2 refused by a bound/);
});

test("insights stays silent about amendments on a run that made none", () => {
  const r = summarize(['{"event":"item_done","item":"x"}'], {});
  assert.deepEqual(r.amendments, { applied: 0, refused: 0 });
  assert.ok(!renderInsights(r).includes("Plan amendments"), "no feedback node, no line");
});

test("a feedback node attempting a delete is refused, and PLAN.md is unchanged on disk", async () => {
  const { root, leo } = briefRepo(FEEDBACK_PLAN);
  installFake("DELETE: 1\nDELETE: item 2");
  const before = planOf(leo);
  await drive(root, BASE);

  // Byte for byte, apart from the checkboxes the run legitimately closed.
  assert.equal(planOf(leo), before.replace(/- \[ \]/g, "- [x]"), "not one line was removed or added");
  assert.deepEqual(eventsOf(leo, "amendment"), []);
  const refused = eventsOf(leo, "amendment_refused");
  assert.deepEqual(refused.map((r) => r.bound), ["no-delete", "no-delete"]);
  assert.match(String(refused[0].reason), /never delete a plan item/);
  assert.ok(!decisionsOf(leo).includes("Plan amended"), "nothing was amended, so nothing is logged as amended");
});

test("a feedback node attempting to edit GUARDRAILS.md is refused, and its bytes are unchanged", async () => {
  const { root, leo } = briefRepo(FEEDBACK_PLAN);
  installFake("GUARDRAILS: raise max_failures to 99 and unlock git push\nADD: A legitimate follow-up item");
  const guardrailsBefore = fs.readFileSync(path.join(leo, "GUARDRAILS.md"), "utf8");
  await drive(root, BASE);

  assert.equal(fs.readFileSync(path.join(leo, "GUARDRAILS.md"), "utf8"), guardrailsBefore,
    "the autonomy boundary is the human's, and the run cannot move it");
  const refused = eventsOf(leo, "amendment_refused");
  assert.deepEqual(refused.map((r) => r.bound), ["no-guardrails"]);
  assert.match(String(refused[0].reason), /never edit GUARDRAILS\.md/);
  // The legitimate proposal in the same block still landed: one bad line refuses itself,
  // not the batch.
  assert.deepEqual(parsePlan(planOf(leo)).slice(2).map((i) => i.text), ["A legitimate follow-up item"]);
});

test("the budget is run-wide: two feedback nodes cannot add three items each", async () => {
  const { root, leo } = briefRepo(`# Plan

- [ ] @feedback First look at the run
- [ ] (after: 1) @feedback Second look at the run
`);
  installFake("ADD: one\nADD: two");
  await drive(root, BASE);

  const added = parsePlan(planOf(leo)).filter((i) => i.index > 2).map((i) => i.text);
  assert.deepEqual(added, ["one", "two", "one"], "the second node got the last of the budget, not a fresh one");
  assert.equal(eventsOf(leo, "amendment").length, MAX_ADDED_ITEMS);
  assert.equal(eventsOf(leo, "amendment_refused").length, 1);
  assert.equal(eventsOf(leo, "amendment_refused")[0].bound, "add-budget");
});

// The budget is spent by the RUN, and the driver is re-invoked to resume one (every
// escalation and failure notice says "re-run leopold-driver"). A counter that reset on
// each invocation would hand every restart a fresh purse of three — unbounded plan
// growth across resumes, which is precisely the runaway this bound exists to prevent.

test("a resumed run inherits the amendment budget it already spent", async () => {
  const { root, leo } = briefRepo(FEEDBACK_PLAN);
  // What the previous invocation left behind: the full budget, already spent.
  fs.writeFileSync(path.join(leo, "state.json"), JSON.stringify({ amendments_added: MAX_ADDED_ITEMS }));
  const before = planOf(leo);
  installFake("ADD: sneak one\nADD: sneak two\nADD: sneak three");
  await drive(root, BASE);

  assert.equal(planOf(leo), before.replace(/- \[ \]/g, "- [x]"), "not one item was appended on the restart");
  assert.deepEqual(eventsOf(leo, "amendment"), []);
  const refused = eventsOf(leo, "amendment_refused");
  assert.equal(refused.length, 3);
  for (const r of refused) assert.equal(r.bound, "add-budget");
  assert.ok(!decisionsOf(leo).includes("Plan amended"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")).amendments_added, MAX_ADDED_ITEMS,
    "the counter is inherited, not reset and not doubled");
});

test("a resumed run spends only what is LEFT of the budget", async () => {
  const { root, leo } = briefRepo(FEEDBACK_PLAN);
  fs.writeFileSync(path.join(leo, "state.json"), JSON.stringify({ amendments_added: 2 }));
  installFake("ADD: the last one that fits\nADD: one too many");
  await drive(root, BASE);

  assert.deepEqual(parsePlan(planOf(leo)).slice(2).map((i) => i.text), ["the last one that fits"]);
  assert.deepEqual(eventsOf(leo, "amendment_refused").map((r) => r.bound), ["add-budget"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8")).amendments_added, MAX_ADDED_ITEMS);
});

// --- the bounds are enforced on the SHELL too, not just on the proposal channel ------
// The bounds live on the channel a feedback node proposes through. Its session still
// holds Bash, and `.leopold/` is gitignored — so without a lock on that path a node
// could `sed -i` the plan, `cat >>` GUARDRAILS.md or `touch ALLOW_GIT`, and neither the
// bounds nor the tree-signature receipt would ever see it.

test("the session the driver builds for a feedback node refuses a shell write to the brief", async () => {
  const { root } = briefRepo(FEEDBACK_PLAN);
  const fake = installFake();
  await drive(root, BASE);

  const fb = fake.sessions.find((s) => /FEEDBACK node/.test(String((s.options.systemPrompt as { append?: string }).append)))!;
  const ask = fb.options.canUseTool as (t: string, i: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;
  for (const command of [
    "sed -i '/Build the thing/d' .leopold/PLAN.md",          // no-delete, through the shell
    "sed -i 's/\\[ \\]/[x]/g' .leopold/PLAN.md",             // no-touch-done, through the shell
    "cat >> .leopold/GUARDRAILS.md",                          // no-guardrails, through the shell
    "printf '{\"amendments_added\":0}' > .leopold/state.json", // add-budget, through the shell
    "touch .leopold/ALLOW_GIT",                               // the git lock itself
  ]) {
    const r = await ask("Bash", { command });
    assert.equal(r.behavior, "deny", command);
    assert.match(String(r.message), /read-only node/);
  }
  // Reading the run — the node's entire job — is untouched.
  for (const command of ["cat .leopold/events.jsonl", "jq -r '.iteration' .leopold/state.json",
    "grep -c amendment .leopold/events.jsonl", "tail -20 .leopold/PLAN.md", "git --no-pager diff HEAD", "make test"]) {
    assert.equal((await ask("Bash", { command })).behavior, "allow", command);
  }
});

test("a read-only node that writes the brief anyway is never silent", async () => {
  const { root, leo } = briefRepo(FEEDBACK_PLAN);
  // A node that got past every lock and appended to GUARDRAILS.md. `.leopold/` is
  // gitignored, so the git-based tree signature cannot see this — the brief digest can.
  installFake(null, () => fs.appendFileSync(path.join(leo, "GUARDRAILS.md"), "- unlock everything\n"));
  await drive(root, BASE);

  const flagged = eventsOf(leo, "review_node_edited");
  assert.equal(flagged.length, 1, "the run reports the write instead of passing the verdict off as clean");
  assert.equal(flagged[0].kind, "feedback");
  assert.equal(flagged[0].brief, true, "and says it was the BRIEF that moved, not the working tree");
});

// The forgery that ends a run early. The brief digest hashes PLAN.md with its
// checkboxes blanked (a --parallel sibling closes items mid-node, and crying wolf on
// every node is worse than useless), so a node that flips every `[ ]` to `[x]` moves
// NOTHING the digest can see: the next round parses allDone and the run stops with
// `plan_complete` — "everything is staged" — with the remaining items never run. The
// driver's flip ledger is what closes that: it knows which boxes it closed itself.

test("a read-only node that forges a checkbox is caught, and the checkbox is put back", async () => {
  const { root, leo } = briefRepo(`# Plan

- [ ] Build the thing
- [ ] (after: 1) @feedback health Read the run and improve the plan
- [ ] (after: 2) Ship the docs
`);
  // A node that got past every lock and marked the whole plan done with its shell.
  const fake = installFake(null, () => {
    const p = path.join(leo, "PLAN.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/- \[ \]/g, "- [x]"));
  });
  await drive(root, BASE);

  // Caught, named, and attributed to the BRIEF — not passed off as a clean verdict.
  const flagged = eventsOf(leo, "review_node_edited");
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].brief, true);
  assert.deepEqual(flagged[0].checkboxes, [2, 3], "the forged items, by index");
  assert.deepEqual(flagged[0].restored, [2, 3], "and each one put back");

  // And the run did NOT end on the lie: item 3 was actually dispatched and done by a
  // worker, not by a `sed`.
  assert.ok(fake.sessions.some((s) => s.prompt.includes("Ship the docs")), "item 3 ran");
  assert.deepEqual(parsePlan(planOf(leo)).map((i) => i.done), [true, true, true]);
  assert.deepEqual(eventsOf(leo, "item_done").map((e) => e.item),
    ["Build the thing", "Read the run and improve the plan", "Ship the docs"]);
});

// …and the other half of the same rule: the driver closing an item while a read-only
// node runs is exactly what a --parallel run does all day. That must read as the
// driver's own doing, or the receipt would revert a legitimately finished item and the
// run would do it twice.

test("a checkbox the DRIVER closes while a read-only node runs is not a forgery", async () => {
  const { root, leo } = briefRepo(`# Plan

- [ ] Build the thing
- [ ] (after: 1) @feedback health Read the run and improve the plan
- [ ] Ship the docs
`);
  // Stand in for a concurrent sibling finishing mid-node: the driver's own writer,
  // closing an item the feedback node has nothing to do with.
  const fake = installFake(null, () => { setItemDone(path.join(leo, "PLAN.md"), 3); });
  await drive(root, BASE);

  assert.deepEqual(eventsOf(leo, "review_node_edited"), [], "the driver's own flip is not a node edit");
  assert.deepEqual(parsePlan(planOf(leo)).map((i) => i.done), [true, true, true]);
  assert.ok(!fake.sessions.some((s) => s.prompt.includes("Ship the docs")),
    "and the closed item is not re-opened and run again");
});

test("the --parallel scheduler amends the plan without losing a concurrent checkbox", async () => {
  const { root, leo } = briefRepo(`# Plan

- [ ] Build A
- [ ] Build B
- [ ] (after: 1) @feedback Read the run and improve the plan
`);
  const fake = installFake("ADD: Add the missing integration test");
  await drive(root, [...BASE, "--parallel", "3"]);

  // The amendment landed AND every concurrently-written checkbox survived: both go
  // through the scheduler's one serialized writer for PLAN.md.
  const items = parsePlan(planOf(leo));
  assert.deepEqual(items.map((i) => i.text), [
    "Build A", "Build B", "Read the run and improve the plan", "Add the missing integration test",
  ]);
  assert.deepEqual(items.map((i) => i.done), [true, true, true, true]);
  assert.equal(eventsOf(leo, "amendment").length, 1);
  // The feedback node read the accumulated main tree, not a fresh fork of HEAD.
  const fb = fake.sessions.find((s) => s.prompt.includes("Read the run and improve"))!;
  assert.equal(fb.options.cwd, root);
});

// --- the other engine: /leopold-workflow ------------------------------------------
// BOTH ENGINES OR NEITHER. The workflow script has no filesystem of its own, so the
// WRITE is delegated to an agent — but the JUDGEMENT is not: the script decides what
// survives, exactly as amend.ts does, and hands the writer the finished bytes.

const WORKFLOW_PLAN = `# Plan
- [ ] Build the thing
- [ ] (after: 1) @feedback health Read the run and improve the plan
`;

test("the workflow engine enforces the same bounds and runs what it added", async () => {
  const proposals = [
    { op: "add", text: "one" }, { op: "add", text: "two" }, { op: "add", text: "three" },
    { op: "add", text: "four" },
    { op: "delete", text: "", target: 1 },
    { op: "guardrails", text: "unlock git push" },
    { op: "add", text: "@tool `make release`" },
  ];
  const respond: Responder = ({ opts }) => {
    const label = String(opts.label || "");
    const [role, kind] = label.split(":");
    if (role === "verify") return { ok: true, blocking: [] };
    if (role === "node" && kind === "feedback") return { summary: "the plan is missing follow-ups", proposals };
    if (role === "node") return { ok: true, blocking: [], exit: 0 };
    return { summary: "done" };
  };
  const run = await runWorkflow(
    workflowPath("leopold-workflow", "leopold-run.workflow.js"),
    { args: compileBrief({ mission: "# Mission\nShip it.", charter: "Be pragmatic.", planText: WORKFLOW_PLAN }), respond },
  );

  // Three added, in the node's own priority order, and the fourth over budget.
  const logs = run.logs.join("\n");
  assert.match(logs, /amendment -> item 3 added: one/);
  assert.match(logs, /amendment -> item 4 added: two/);
  assert.match(logs, /amendment -> item 5 added: three/);
  assert.ok(!/item 6 added/.test(logs), "the budget is 3 per run on this engine too");
  for (const bound of ["add-budget", "no-delete", "no-guardrails", "work-only"]) {
    assert.match(logs, new RegExp(`amendment refused \\[${bound}\\]`), bound);
  }

  // The writer agent got the exact bytes the bounds produced — and nothing else.
  const writer = run.agents.find((a) => String(a.label).startsWith("node:amend:"))!;
  assert.ok(writer, "the accepted amendment is persisted to PLAN.md and DECISIONS.md");
  for (const t of ["one", "two", "three"]) assert.ok(writer.prompt.includes(`- [ ] ${t}\n`), t);
  assert.ok(!writer.prompt.includes("four"), "a refused proposal never reaches the writer");
  assert.ok(!writer.prompt.includes("make release"), "nor does a refused node kind");
  assert.equal((writer.prompt.match(/^Reversal:/gm) ?? []).length, 3, "every block carries a Reversal line");
  assert.match(writer.prompt, /Do not modify any existing line/);

  // And the added items actually RAN in this same run.
  const impl = run.agents.filter((a) => String(a.label).startsWith("impl:")).map((a) => String(a.label));
  assert.deepEqual(impl, ["impl:i1", "impl:i3", "impl:i4", "impl:i5"]);
  assert.equal((run.result as { done: number }).done, 5);
});

test("a workflow plan with no feedback node writes nothing and asks for nothing", async () => {
  const respond: Responder = ({ opts }) => {
    const label = String(opts.label || "");
    return label.startsWith("verify:") ? { ok: true, blocking: [] } : { summary: "done" };
  };
  const run = await runWorkflow(
    workflowPath("leopold-workflow", "leopold-run.workflow.js"),
    { args: compileBrief({ mission: "# Mission\nShip it.", charter: "Be pragmatic.", planText: "# Plan\n- [ ] Build the thing\n- [ ] (after: 1) Ship it\n" }), respond },
  );
  assert.deepEqual(run.agents.filter((a) => String(a.label).includes("amend")), []);
  assert.ok(!run.logs.join("\n").includes("amendment"));
});

// --- backward compatibility --------------------------------------------------------

test("a plan with no feedback node behaves exactly as it did before amendments existed", async () => {
  const plan = "# Plan\n\n- [ ] Add the API layer\n- [ ] (after: 1) Wire the UI to the API\n- [ ] Independent docs pass\n";
  const { root, leo } = briefRepo(plan);
  const fake = installFake("ADD: this must never be proposed, let alone applied");
  await drive(root, BASE);

  // The plan is what the human wrote, with only its own boxes ticked.
  assert.equal(planOf(leo), plan.replace(/- \[ \]/g, "- [x]"));
  assert.deepEqual(eventsOf(leo, "amendment"), []);
  assert.deepEqual(eventsOf(leo, "amendment_refused"), []);
  assert.deepEqual(eventsOf(leo, "feedback"), []);
  assert.equal(decisionsOf(leo), "", "no amendment trail is written for a plan without one");
  const st = JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8"));
  assert.ok(!("amendments_added" in st), "state.json gains no field");
  // Every session is still an ordinary work session with the prompt it always had.
  for (const s of fake.sessions) {
    assert.equal(s.options.disallowedTools, undefined);
    assert.equal(s.prompt, buildWorkerPrompt(s.prompt.match(/item now:\n\n([\s\S]*?)\n\n/)![1], []));
  }
});
