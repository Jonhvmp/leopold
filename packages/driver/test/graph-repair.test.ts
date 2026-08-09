// A malformed graph is a decision, not a dead end.
//
// `@on fail -> 99` in a 10-item plan used to end the run before it started: the
// validator named the dangling edge and the driver refused, correctly about the graph
// and wrongly about the situation — that is a typo, and a typo is not a reason to hand
// the work back to a person who is not there. These tests drive the REAL runDriver and
// the REAL workflow command through an injected fake SDK (zero model calls, zero tokens)
// and prove the four things the change promises:
//
//   1. a dangling edge is repaired under a synthesized role, the graph validates, and the
//      run starts — with the repair in DECISIONS.md carrying a Reversal;
//   2. a repair is bounded by the SAME amend.ts rules a @feedback node gets: at most 3
//      changes, never a delete, never a done item, never GUARDRAILS — and each refusal is
//      logged with the bound that refused it;
//   3. a graph the role CANNOT repair still refuses the run, printing the diagnostics AND
//      what the repair attempted, with PLAN.md byte-identical and no worker dispatched;
//   4. a VALID graph never reaches any of it: no persona, no repair call, no extra token.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver, InvalidPlanGraphError } from "../src/loop.ts";
import { runWorkflowCommand } from "../src/workflow-cmd.ts";
import { preflightPlan } from "../src/graph-cmd.ts";
import { parseAmendments, judgeAmendments, MAX_ADDED_ITEMS } from "../src/amend.ts";
import { renderRepairAttempt } from "../src/repair.ts";

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

const CHARTER = `# Charter

## Never
- Add a new runtime dependency.
`;

function briefRepo(plan: string): { root: string; leo: string; planPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-repair-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".leopold/\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "MISSION.md"), "# Mission\nShip the release.\n");
  fs.writeFileSync(path.join(leo, "CHARTER.md"), CHARTER);
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- max_failures: 3\n- max_iterations: 40\n");
  const planPath = path.join(leo, "PLAN.md");
  fs.writeFileSync(planPath, plan);
  return { root, leo, planPath };
}

const events = (leo: string): Array<Record<string, unknown>> => {
  const p = path.join(leo, "events.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
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

const PERSONA_JSON = JSON.stringify({
  name: "Ana Ribeiro",
  role: "Plan Engineer",
  expertise: ["dependency graphs", "release plan routing"],
  optimizesFor: ["the smallest change that makes the graph sound"],
  rationale: "The defect is a routing typo, not a product question.",
});

/** What the fake was asked, so a test can prove which calls were (not) made. */
interface Seen { workers: number; total: number; persona: string; repair: string; repairAsk: string }
const noSeen = (): Seen => ({ workers: 0, total: 0, persona: "", repair: "", repairAsk: "" });

/** A fake harness that closes every item it is handed, answers the persona synthesis with
 *  a plan engineer, and answers the repair call with whatever `repairAnswer` says. */
function installFake(seen: Seen, repairAnswer: string) {
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    seen.total += 1;
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      seen.workers += 1;
      return (async function* () {
        const text = await firstPrompt(input.prompt);
        const item = (text.match(/Work on this plan item now:\n\n([\s\S]*?)\n\n/) ?? [])[1]?.trim() ?? "";
        const block =
          "```leopold-status\nSTATUS: done\nITEM: " + item +
          "\nSUMMARY: implemented and verified\nNEXT: none\nEVIDENCE: build+test ok\n```";
        yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
        yield { type: "result", result: block, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    const user = typeof input.prompt === "string" ? input.prompt : "";
    if (sys.includes("synthesize the ROLE")) { seen.persona = sys; return stream(PERSONA_JSON); }
    if (sys.includes("declares a graph that does not validate")) {
      seen.repair = sys; seen.repairAsk = user;
      return stream(repairAnswer);
    }
    if (sys.includes("the conductor")) {
      return stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    }
    return stream('{"ok":true,"blocking":[],"summary":"clean"}');
  }) as never);
}

interface Captured { out: string; err: string }
async function capture<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown } & Captured> {
  const log = console.log, warn = console.warn, error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  let out = "", err = "";
  console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  console.warn = (...a: unknown[]) => { err += a.join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { err += a.join(" ") + "\n"; };
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try {
    return { value: await fn(), out, err };
  } catch (e) {
    return { error: e, out, err };
  } finally {
    console.log = log; console.warn = warn; console.error = error;
    process.stdout.write = write; resetQuery();
  }
}

const BASE = ["--no-review", "--no-hypotheses", "--no-literal-reset"];

/** A ten-item plan whose item 5 routes at an item nobody wrote. Everything else about
 *  it is sound, which is exactly what makes it a typo. */
const TEN_ITEM_PLAN = `# Plan

- [ ] Freeze the release branch
- [ ] Write the migration
- [ ] Review the migration
- [ ] Stage the rollout
- [ ] Run the migration
      @on fail -> 99
- [ ] Smoke the app
- [ ] Roll the migration back
- [ ] Update the changelog
- [ ] Tag the release notes
- [ ] Announce the release
`;

const REPAIR_ROUTE =
  "```leopold-amend\nROUTE 5 fail -> 7\n```\n\n" +
  "```leopold-decision\nDECISION: point item 5's failure route at item 7, the rollback\n" +
  "WHY: the plan's only rollback step is item 7 and item 99 does not exist\n" +
  "REVERSAL: restore the @on line under item 5 to `@on fail -> 99`\n```";

// --- scenario 1: the route is repaired and the run starts ----------------------------

test("a dangling edge is repaired under a synthesized role and the run starts", async () => {
  const { root, leo, planPath } = briefRepo(TEN_ITEM_PLAN);
  const seen = noSeen();
  installFake(seen, REPAIR_ROUTE);
  const r = await capture(() => runDriver(root, BASE));

  assert.equal(r.error, undefined, `the run must start: ${String(r.error)}`);
  assert.ok(seen.workers > 0, "the repaired plan actually dispatched work");

  // The plan on disk is repaired, and NOTHING else about it moved.
  const after = fs.readFileSync(planPath, "utf8");
  assert.match(after, /@on fail -> 7/);
  assert.doesNotMatch(after, /99/);
  assert.equal(after.split("\n").filter((l) => /^- \[/.test(l)).length, 10, "no item was added or removed");
  assert.ok(preflightPlan(planPath).ok, "the graph validates after the repair");

  // The role saw the actual diagnostic and the actual plan.
  assert.match(seen.repairAsk, /routes to item 99/);
  assert.match(seen.repairAsk, /Roll the migration back/);
  // …and it was bound by the charter, in code, through the same one writer.
  assert.match(seen.repair, /ANA RIBEIRO — Plan Engineer/);
  assert.match(seen.repair, /Never: Add a new runtime dependency\./);

  // The trail: the persona, the fork, the decision and its Reversal.
  const trail = fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8");
  assert.match(trail, /Ana Ribeiro decided: Plan Engineer/);
  assert.match(trail, /Fork:\s+a broken plan graph/);
  assert.match(trail, /Decision:\s+point item 5's failure route at item 7/);
  assert.match(trail, /Reversal:\s+restore the @on line under item 5/);

  const ev = events(leo);
  assert.equal(ev.filter((e) => e.event === "persona" && e.fork === "repair").length, 1);
  assert.equal(ev.filter((e) => e.event === "repair_applied").length, 1);
  assert.equal(ev.filter((e) => e.event === "repair_failed").length, 0);
  assert.deepEqual(ev.filter((e) => e.event === "preflight_rejected"), []);
  assert.match(r.out, /graph repaired -> item 5: @on fail -> 7/);
});

// --- scenario 2: the bounds are the ones that already existed ------------------------

test("a repair that would add 5 items applies 3 and refuses 2, naming the bound", () => {
  const plan = "# Plan\n\n- [ ] One\n- [ ] Two\n";
  const proposals = parseAmendments(
    "```leopold-amend\nADD One more\nADD Two more\nADD Three more\nADD Four more\nADD Five more\n```",
  );
  assert.equal(proposals.length, 5);
  const j = judgeAmendments(plan, proposals, MAX_ADDED_ITEMS, { allowRoute: true });
  assert.equal(j.accepted.length, 3);
  assert.equal(j.refused.length, 2);
  assert.deepEqual([...new Set(j.refused.map((r) => r.bound))], ["add-budget"]);
  assert.deepEqual(j.accepted.map((a) => a.index), [3, 4, 5]);
});

test("a route retarget draws on the SAME purse, so a repair can never make a fourth change", () => {
  const plan = "# Plan\n\n- [ ] One\n      @on fail -> 99\n- [ ] Two\n";
  const j = judgeAmendments(
    plan,
    parseAmendments("```leopold-amend\nROUTE 1 fail -> 2\nADD A\nADD B\nADD C\n```"),
    MAX_ADDED_ITEMS,
    { allowRoute: true },
  );
  assert.equal(j.accepted.length, 3, "the route counts as one of the three");
  assert.equal(j.refused.length, 1);
  assert.equal(j.refused[0].bound, "add-budget");
  assert.match(j.planText, /@on fail -> 2/);
});

test("the bounds a repair may not talk past: delete, a done item, GUARDRAILS, an invented route", () => {
  const plan = "# Plan\n\n- [x] Done already\n      @on fail -> 99\n- [ ] Open\n      @on ok -> 99\n";
  const j = judgeAmendments(
    plan,
    parseAmendments(
      "```leopold-amend\nDELETE 2\nROUTE 1 fail -> 2\nGUARDRAILS raise max_iterations\n" +
      "ROUTE 2 missing -> 1\nROUTE 2 ok -> 47\n```",
    ),
    MAX_ADDED_ITEMS,
    { allowRoute: true },
  );
  assert.equal(j.accepted.length, 0, "nothing survives, so the plan text is untouched");
  assert.equal(j.planText, plan);
  assert.deepEqual(j.refused.map((r) => r.bound), [
    "no-delete", "no-touch-done", "no-guardrails", "malformed", "malformed",
  ]);
  assert.match(j.refused[3].reason, /declares no "@on missing" route/);
  assert.match(j.refused[4].reason, /not an item that exists/);
});

test("outside a repair a ROUTE is refused by name: a feedback node cannot reach the verb", () => {
  const plan = "# Plan\n\n- [ ] One\n      @on fail -> 99\n- [ ] Two\n";
  const j = judgeAmendments(plan, parseAmendments("```leopold-amend\nROUTE 1 fail -> 2\n```"), MAX_ADDED_ITEMS);
  assert.equal(j.accepted.length, 0);
  assert.equal(j.refused[0].bound, "repair-only");
  assert.equal(j.planText, plan);
});

test("a repair's refusals are logged with the bound that refused them", async () => {
  const { root, leo, planPath } = briefRepo(TEN_ITEM_PLAN);
  const seen = noSeen();
  installFake(seen,
    "```leopold-amend\nROUTE 5 fail -> 7\nDELETE 3\nGUARDRAILS raise max_iterations\n```\n" +
    "```leopold-decision\nDECISION: retarget the route\nWHY: item 99 does not exist\nREVERSAL: put 99 back\n```");
  const r = await capture(() => runDriver(root, BASE));

  assert.equal(r.error, undefined);
  assert.ok(preflightPlan(planPath).ok);
  const refusals = events(leo).filter((e) => e.event === "repair_refused");
  assert.deepEqual(refusals.map((e) => e.bound), ["no-delete", "no-guardrails"]);
  assert.match(r.out, /repair refused \[no-guardrails\]/);
  // The one thing it may never do, even while it is fixing the plan.
  assert.match(fs.readFileSync(path.join(leo, "GUARDRAILS.md"), "utf8"), /max_iterations: 40/);
});

// --- scenario 3: what cannot be repaired still refuses ------------------------------

test("a graph the role cannot repair still refuses the run, printing both halves", async () => {
  const { root, leo, planPath } = briefRepo(TEN_ITEM_PLAN);
  const before = fs.readFileSync(planPath, "utf8");
  const seen = noSeen();
  // The role proposes only things the bounds refuse, so nothing survives to apply.
  installFake(seen, "```leopold-amend\nDELETE 5\nEDIT 5: drop the route\n```");
  const r = await capture(() => runDriver(root, BASE));

  assert.ok(r.error instanceof InvalidPlanGraphError, `expected a refusal, got ${String(r.error)}`);
  assert.equal((r.error as InvalidPlanGraphError).diagnostics[0].code, "dangling-edge");

  // NOT ONE WORKER. The repair costs a couple of conductor turns; the plan costs nothing.
  assert.equal(seen.workers, 0, "an unrepairable plan must dispatch no worker");
  assert.equal(fs.existsSync(path.join(leo, "state.json")), false, "the run must never be activated");
  assert.deepEqual(events(leo).filter((e) => e.event === "item_start"), []);

  // The plan is BYTE-IDENTICAL: a failed repair writes nothing.
  assert.equal(fs.readFileSync(planPath, "utf8"), before);
  assert.equal(fs.existsSync(path.join(leo, "DECISIONS.md")), false, "a repair that did not land decides nothing");

  // Both halves were printed: the diagnostics AND what the repair tried.
  assert.match(r.err, /Invalid graph/);
  assert.match(r.err, /routes to item 99/);
  assert.match(r.err, /Ana Ribeiro, Plan Engineer/);
  assert.match(r.err, /refused \[no-delete\]/);
  assert.match(r.err, /PLAN\.md was not modified/);

  const failed = events(leo).filter((e) => e.event === "repair_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].would_apply, 0);
  assert.equal(failed[0].refused, 2);
});

test("a repair that clears every bound but leaves the graph invalid writes NOTHING", async () => {
  // Retargeting item 1's route at item 2 is a legal change that swaps a dangling edge
  // for a cycle. Legal is not sound: the plan must come out untouched.
  const { root, leo, planPath } = briefRepo("# Plan\n\n- [ ] Migrate\n      @on fail -> 99\n- [ ] Roll back\n      @on fail -> 1\n");
  const before = fs.readFileSync(planPath, "utf8");
  const seen = noSeen();
  installFake(seen, "```leopold-amend\nROUTE 1 fail -> 2\n```");
  const r = await capture(() => runDriver(root, BASE));

  assert.ok(r.error instanceof InvalidPlanGraphError, `expected a refusal, got ${String(r.error)}`);
  assert.equal(fs.readFileSync(planPath, "utf8"), before, "an unsound repair is never written");
  assert.equal(seen.workers, 0);
  assert.equal(fs.existsSync(path.join(leo, "DECISIONS.md")), false);
  // The refusal shows what it WOULD have applied and what that still leaves broken.
  assert.match(r.err, /would apply: @on fail -> 2/);
  assert.match(r.err, /still invalid/);
  assert.match(r.err, /Cycle/);
  const failed = events(leo).filter((e) => e.event === "repair_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].would_apply, 1);
});

test("a role that proposes nothing at all is reported as such, not as an empty success", () => {
  const block = renderRepairAttempt({
    before: [{ code: "dangling-edge", index: 2, items: [2], target: 99, message: "item 2 routes to item 99, which does not exist" }],
    proposals: [], accepted: [], refused: [], after: [], ok: false,
  });
  assert.match(block, /it proposed no repair at all/);
  assert.match(block, /PLAN\.md was not modified/);
});

// --- scenario 4: a valid graph costs exactly nothing --------------------------------

test("a valid graph synthesizes no persona and spends no repair call", async () => {
  const { root, leo } = briefRepo("# Plan\n\n- [ ] Prepare the release\n- [ ] (after: 1) Announce it\n");
  const seen = noSeen();
  installFake(seen, "```leopold-amend\nADD nothing\n```");
  const r = await capture(() => runDriver(root, BASE));

  assert.equal(r.error, undefined, `a valid plan must not be rejected: ${String(r.error)}`);
  assert.equal(seen.persona, "", "no role is synthesized for a graph that validates");
  assert.equal(seen.repair, "", "no repair call is made for a graph that validates");
  assert.doesNotMatch(r.out, /graph repaired|repair refused/);
  assert.equal(r.err, "", `the gate must stay silent on a valid plan, got: ${r.err}`);
  assert.deepEqual(events(leo).filter((e) => String(e.event).startsWith("repair")), []);
});

// --- both engines ------------------------------------------------------------------

test("the workflow engine repairs the same graph the same way", async () => {
  const { root, leo, planPath } = briefRepo(TEN_ITEM_PLAN);
  const seen = noSeen();
  installFake(seen, REPAIR_ROUTE);
  const r = await capture(() => runWorkflowCommand(root, ["--print"]));

  assert.equal(r.value, 0, `the workflow must compile after the repair: ${r.err}`);
  assert.match(fs.readFileSync(planPath, "utf8"), /@on fail -> 7/);
  assert.equal(events(leo).filter((e) => e.event === "repair_applied").length, 1);
  assert.match(fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8"), /Ana Ribeiro decided: Plan Engineer/);
});

test("the workflow engine refuses what it cannot repair, and compiles nothing", async () => {
  const { root, leo, planPath } = briefRepo(TEN_ITEM_PLAN);
  const before = fs.readFileSync(planPath, "utf8");
  const seen = noSeen();
  installFake(seen, "```leopold-amend\nDELETE 5\n```");
  const r = await capture(() => runWorkflowCommand(root, ["--print"]));

  assert.equal(r.value, 1);
  assert.equal(fs.readFileSync(planPath, "utf8"), before);
  assert.match(r.err, /routes to item 99/);
  assert.match(r.err, /refused \[no-delete\]/);
  assert.doesNotMatch(r.out, /"waves"/, "nothing was compiled");
  assert.equal(events(leo).filter((e) => e.event === "preflight_rejected").length, 1);
});

test("under autonomy: ask the workflow refuses without synthesizing anything", async () => {
  const { root } = briefRepo(TEN_ITEM_PLAN);
  const seen = noSeen();
  installFake(seen, REPAIR_ROUTE);
  const r = await capture(() => runWorkflowCommand(root, ["--print", "--autonomy", "ask"]));

  assert.equal(r.value, 1);
  assert.equal(seen.total, 0, "ask costs zero tokens on a malformed plan");
});
