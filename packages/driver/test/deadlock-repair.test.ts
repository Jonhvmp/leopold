// A deadlock is a decision nobody made, not a dead end.
//
// The graph validated, the run started, and then the scheduler asked "what runs next?"
// and got nothing back while items were still open. That used to end the run with
// `deadlock` and hand the work to a person who is not there — for a plan that is
// perfectly legal: item 2 declares `@needs approved`, item 1 declares two possible
// values for `approved`, and item 1 ended without saying which. Nobody made the call.
//
// These tests drive the REAL runDriver through an injected fake SDK (zero model calls,
// zero tokens) and prove the four things the change promises:
//
//   1. a plan whose items are stranded is unstuck by a synthesized role deciding a
//      signal the PLAN ITSELF declares, and the run goes on to complete — with the call
//      in DECISIONS.md carrying a Reversal;
//   2. a repair that cannot unstick the run writes NOTHING (not PLAN.md, not the
//      channel) and the run stops with `deadlock`, naming the stranded items;
//   3. the repair is spent ONCE per run: a second deadlock stops, with no second role
//      synthesized;
//   4. the bounds are the ones amend.ts already enforces — the plan's own `@emit`
//      vocabulary is the whole vocabulary, the purse is the same 3-change purse, and
//      outside a repair the SIGNAL verb does not exist at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver } from "../src/loop.ts";
import { parseAmendments, judgeAmendments, MAX_ADDED_ITEMS } from "../src/amend.ts";
import { strandsOf, deadlockSystemPrompt } from "../src/repair.ts";
import { newRouting } from "../src/dispatch.ts";
import { parsePlan } from "../src/plan.ts";
import { readSignals } from "../src/bus.ts";

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

const CHARTER = `# Charter

## Never
- Add a new runtime dependency.
`;

function briefRepo(plan: string): { root: string; leo: string; planPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-deadlock-"));
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
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- max_failures: 3\n- max_iterations: 20\n");
  const planPath = path.join(leo, "PLAN.md");
  fs.writeFileSync(planPath, plan);
  return { root, leo, planPath };
}

const events = (leo: string): Array<Record<string, unknown>> => {
  const p = path.join(leo, "events.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const started = (leo: string): string[] =>
  events(leo).filter((e) => e.event === "item_start").map((e) => String(e.item));

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
  name: "Rui Salgado",
  role: "Release Manager",
  expertise: ["release gating", "rollout decisions"],
  optimizesFor: ["shipping what is already verified"],
  rationale: "The strand is a go/no-go call, not an engineering question.",
});

/** What the fake was asked, so a test can prove which calls were (not) made. */
interface Seen { workers: number; total: number; personas: number; repairs: number; ask: string; sys: string }
const noSeen = (): Seen => ({ workers: 0, total: 0, personas: 0, repairs: 0, ask: "", sys: "" });

/** A fake harness that closes every item it is handed WITHOUT reporting a signal —
 *  which is exactly how a legal plan strands itself — and answers the deadlock repair
 *  with whatever `answers` says (one per deadlock, the last one repeating). */
function installFake(seen: Seen, answers: string[]) {
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
    if (sys.includes("synthesize the ROLE")) { seen.personas += 1; return stream(PERSONA_JSON); }
    if (sys.includes("The run has stalled")) {
      seen.sys = sys; seen.ask = user;
      const answer = answers[Math.min(seen.repairs, answers.length - 1)] ?? "";
      seen.repairs += 1;
      return stream(answer);
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

/** A legal, valid plan that strands itself: item 1 may emit `approved` either way, so
 *  nothing lands on the channel unless the worker says which — and it does not. */
const STRANDED_PLAN = `# Plan

- [ ] Build the release candidate
      @emit approved=yes
      @emit approved=no
- [ ] (after: 1) Ship the release candidate
      @needs approved
`;

/** The same shape twice: unsticking the first strand walks the run into the second. */
const TWICE_STRANDED_PLAN = `# Plan

- [ ] Build the release candidate
      @emit approved=yes
      @emit approved=no
- [ ] (after: 1) Ship the release candidate
      @needs approved
      @emit announced=yes
      @emit announced=no
- [ ] (after: 2) Announce the release
      @needs announced
`;

const DECIDE_APPROVED =
  "```leopold-amend\nSIGNAL approved=yes\n```\n\n" +
  "```leopold-decision\nDECISION: approve the release candidate and let the ship step run\n" +
  "WHY: the build step reported done with evidence and the charter ships what is verified\n" +
  "REVERSAL: remove \"approved\" from the signals in .leopold/bus.json and re-run\n```";

// --- scenario 1: the strand is decided and the run completes -------------------------

test("a stranded plan is decided by a synthesized role and the run completes", async () => {
  const { root, leo, planPath } = briefRepo(STRANDED_PLAN);
  const seen = noSeen();
  installFake(seen, [DECIDE_APPROVED]);
  const r = await capture(() => runDriver(root, BASE));

  assert.equal(r.error, undefined, `the run must not throw: ${String(r.error)}`);
  assert.deepEqual(started(leo), ["Build the release candidate", "Ship the release candidate"],
    "the stranded item ran after the repair");
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "plan_complete");
  assert.equal(events(leo).filter((e) => e.event === "deadlock").length, 0, "the run never stopped for it");

  // The decision landed on the CHANNEL, not in the plan: a signal is not an edit.
  assert.deepEqual(readSignals(leo), { approved: "yes" });
  const after = fs.readFileSync(planPath, "utf8");
  assert.equal(after.split("\n").filter((l) => /^- \[/.test(l)).length, 2, "no item was added or removed");
  assert.match(after, /@emit approved=yes/, "the plan's own text is untouched");

  // The role saw what was stranded, and why.
  assert.match(seen.ask, /item 2 \("Ship the release candidate"\) waits on signal "approved"/);
  assert.match(seen.ask, /THE STATE CHANNEL RIGHT NOW/);
  assert.match(seen.sys, /RUI SALGADO — Release Manager/);
  assert.match(seen.sys, /Never: Add a new runtime dependency\./, "bound by the charter, in code");

  // The trail: persona, fork, decision, Reversal.
  const trail = fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8");
  assert.match(trail, /Rui Salgado decided: Release Manager/);
  assert.match(trail, /Fork:\s+a deadlock/);
  assert.match(trail, /Decision:\s+approve the release candidate/);
  assert.match(trail, /Reversal:\s+remove "approved" from the signals/);

  const ev = events(leo);
  assert.equal(ev.filter((e) => e.event === "persona" && e.fork === "deadlock").length, 1);
  const applied = ev.filter((e) => e.event === "deadlock_repair_applied");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].op, "signal");
  assert.equal(ev.filter((e) => e.event === "deadlock_repair_failed").length, 0);
  assert.equal(ev.filter((e) => e.event === "persona_decision" && e.fork === "deadlock").length, 1);
});

test("the --parallel scheduler resolves the same strand the same way", async () => {
  const { root, leo } = briefRepo(STRANDED_PLAN);
  const seen = noSeen();
  installFake(seen, [DECIDE_APPROVED]);
  const r = await capture(() => runDriver(root, [...BASE, "--parallel", "2"]));

  assert.equal(r.error, undefined);
  assert.deepEqual([...started(leo)].sort(), ["Build the release candidate", "Ship the release candidate"]);
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "plan_complete");
  assert.deepEqual(readSignals(leo), { approved: "yes" });
  assert.equal(events(leo).filter((e) => e.event === "deadlock_repair_applied").length, 1);
  assert.match(fs.readFileSync(path.join(leo, "DECISIONS.md"), "utf8"), /Rui Salgado decided: Release Manager/);
});

test("under autonomy: ask a deadlock stops exactly as it did before, costing nothing", async () => {
  const { root, leo } = briefRepo(STRANDED_PLAN);
  const seen = noSeen();
  installFake(seen, [DECIDE_APPROVED]);
  const r = await capture(() => runDriver(root, [...BASE, "--autonomy", "ask"]));

  assert.equal(r.error, undefined);
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "deadlock");
  assert.equal(seen.personas, 0, "no role is synthesized under ask");
  assert.equal(seen.repairs, 0);
  assert.deepEqual(readSignals(leo), {});
  const dead = events(leo).find((e) => e.event === "deadlock")!;
  assert.deepEqual(dead.items, [2]);
  assert.equal(dead.repair_attempted, false);
});

// --- scenario 2: a repair that cannot unstick the run changes nothing -----------------

test("a repair that cannot unstick the run writes nothing and the run stops with deadlock", async () => {
  const { root, leo, planPath } = briefRepo(STRANDED_PLAN);
  const before = fs.readFileSync(planPath, "utf8");
  const seen = noSeen();
  // `shipped` is a key the plan never declares — the bound refuses it by name.
  installFake(seen, ["```leopold-amend\nSIGNAL shipped=yes\n```"]);
  const r = await capture(() => runDriver(root, BASE));

  assert.equal(r.error, undefined);
  assert.deepEqual(started(leo), ["Build the release candidate"]);
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "deadlock");
  assert.equal(fs.readFileSync(planPath, "utf8"), before.replace("- [ ] Build", "- [x] Build"),
    "PLAN.md carries the checkbox the run flipped and NOTHING the repair proposed");
  assert.deepEqual(readSignals(leo), {}, "nothing reached the channel");

  const ev = events(leo);
  const dead = ev.find((e) => e.event === "deadlock")!;
  assert.deepEqual(dead.items, [2], "the stop names the stranded item");
  assert.equal(dead.repair_attempted, true);
  const failed = ev.find((e) => e.event === "deadlock_repair_failed")!;
  assert.deepEqual(failed.stranded, [2]);
  assert.equal(failed.reason, "no proposal cleared the bounds");
  const refused = ev.find((e) => e.event === "repair_refused" && e.fork === "deadlock")!;
  assert.equal(refused.bound, "undeclared-signal");

  // "it tried and could not" is information: the stop says what is stranded and why.
  assert.match(r.err, /item 2 waits on signal "approved"/);
  assert.match(r.err, /Rui Salgado, Release Manager/);
  assert.match(r.err, /refused \[undeclared-signal\]/);
});

// --- scenario 3: one repair per run, never a loop ------------------------------------

test("the repair is spent once per run: a second deadlock stops", async () => {
  const { root, leo } = briefRepo(TWICE_STRANDED_PLAN);
  const seen = noSeen();
  installFake(seen, [DECIDE_APPROVED, "```leopold-amend\nSIGNAL announced=yes\n```"]);
  const r = await capture(() => runDriver(root, BASE));

  assert.equal(r.error, undefined);
  assert.deepEqual(started(leo), ["Build the release candidate", "Ship the release candidate"],
    "the first strand recovered; the second was not decided");
  assert.equal(events(leo).find((e) => e.event === "stop")!.reason, "deadlock");
  assert.equal(seen.repairs, 1, "the second deadlock never reached the model");
  assert.equal(seen.personas, 1, "and never synthesized a second role");
  assert.deepEqual(readSignals(leo), { approved: "yes" }, "only the first decision landed");

  const ev = events(leo);
  const dead = ev.filter((e) => e.event === "deadlock");
  assert.equal(dead.length, 1);
  assert.deepEqual(dead[0].items, [3]);
  assert.equal(dead[0].repair_attempted, false, "the repair was already spent, not re-attempted");
});

// --- scenario 4: the bounds are the ones that already existed ------------------------

const CHANNEL = { approved: "yes" };
const SIGNAL_PLAN = `# Plan

- [x] Build it
      @emit approved=yes
      @emit approved=no
- [ ] (after: 1) Ship it
      @needs approved
      @emit rolled=true
`;
const judge = (block: string, remaining = MAX_ADDED_ITEMS, channel: Record<string, string> = {}) =>
  judgeAmendments(SIGNAL_PLAN, parseAmendments("```leopold-amend\n" + block + "\n```"), remaining,
    { allowRoute: true, allowSignal: true, channel });

test("a SIGNAL may only decide a key the plan declares with @emit", () => {
  const j = judge("SIGNAL shipped=yes");
  assert.equal(j.accepted.length, 0);
  assert.equal(j.refused[0].bound, "undeclared-signal");
  assert.match(j.refused[0].reason, /no item declares "@emit shipped"/);
});

test("a SIGNAL may only take a value the plan declares for that key", () => {
  const j = judge("SIGNAL approved=maybe");
  assert.equal(j.accepted.length, 0);
  assert.equal(j.refused[0].bound, "undeclared-signal");
  assert.match(j.refused[0].reason, /declares approved=yes or approved=no/);
});

test("a SIGNAL never overwrites a decision a node already made", () => {
  const j = judge("SIGNAL approved=no", MAX_ADDED_ITEMS, CHANNEL);
  assert.equal(j.accepted.length, 0);
  assert.equal(j.refused[0].bound, "malformed");
  assert.match(j.refused[0].reason, /already carries approved="yes"/);
});

test("a declared key with a single declared value is decided, and PLAN.md is not touched", () => {
  const j = judge("SIGNAL rolled=true");
  assert.equal(j.accepted.length, 1);
  assert.equal(j.accepted[0].text, "rolled=true");
  assert.equal(j.accepted[0].index, 2, "the item that declared the @emit is what the trail names");
  assert.equal(j.planText, SIGNAL_PLAN, "a signal is a decision, not an edit");
});

test("signals draw on the SAME purse: a run that already amended twice gets one change", () => {
  const j = judge("SIGNAL approved=yes\nADD Write the rollback runbook\nADD Update the changelog", 1);
  assert.equal(j.accepted.length, 1);
  assert.equal(j.accepted[0].proposal.op, "signal");
  assert.deepEqual(j.refused.map((r) => r.bound), ["add-budget", "add-budget"]);
});

test("outside a repair the SIGNAL verb does not exist: a feedback node is refused by name", () => {
  const j = judgeAmendments(SIGNAL_PLAN, parseAmendments("```leopold-amend\nSIGNAL approved=yes\n```"), MAX_ADDED_ITEMS);
  assert.equal(j.accepted.length, 0);
  assert.equal(j.refused[0].bound, "repair-only");
});

test("the deadlock role is told what it may never do", () => {
  const sys = deadlockSystemPrompt(
    { mission: "m", charter: CHARTER, guardrails: "", planPath: "p", root: "r", leoDir: "l" },
  );
  assert.match(sys, /at most 3 of them in total/);
  assert.match(sys, /may not invent either/);
  assert.match(sys, /raise a budget, or edit GUARDRAILS\.md/);
});

// --- the diagnosis itself ------------------------------------------------------------

test("strandsOf names the reason per item, and reports nothing when nothing is open", () => {
  const items = parsePlan(TWICE_STRANDED_PLAN);
  items[0].done = true;
  const strands = strandsOf(items, newRouting(), {});
  assert.deepEqual(strands.map((s) => s.index), [2, 3]);
  assert.match(strands[0].why, /waits on signal "approved"/);
  assert.match(strands[1].why, /waits on signal "announced".*and waits on item 2, which is not done/);

  for (const i of items) i.done = true;
  assert.deepEqual(strandsOf(items, newRouting(), {}), []);
});
