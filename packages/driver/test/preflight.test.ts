// Fail fast: a malformed graph costs ZERO tokens.
//
// The gate lives in runDriver, before the run is activated, reaped, worktreed or
// dispatched. These tests drive the real runDriver with a counting fake harness, so
// the claim "no agent was spawned" is measured, not asserted from the shape of the
// code: the fake increments a counter on every single query the driver makes, and a
// rejected plan must leave that counter at 0.
//
// The other half of the gate is that a VALID plan is untouched by it — same start,
// same output, no new line on stdout or stderr — which is what makes this safe to
// put in front of every run.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver, InvalidPlanGraphError } from "../src/loop.ts";
import { preflightPlan } from "../src/graph-cmd.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

/** A repo with a brief whose PLAN.md is `plan`. Git is real (the loop reads HEAD). */
function briefRepo(plan: string): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-pf-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".leopold/\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  fs.writeFileSync(path.join(leo, "MISSION.md"), "# Mission\nShip it.\n");
  fs.writeFileSync(path.join(leo, "CHARTER.md"), "# Charter\nSimplicity.\n");
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- max_failures: 3\n- max_iterations: 30\n");
  fs.writeFileSync(path.join(leo, "PLAN.md"), plan);
  return { root, leo };
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

/** Install a fake harness that always closes the item it is handed, and COUNTS every
 *  agent the driver spawns — worker, conductor, reviewer, all of them. */
function installCountingFake(): { count: () => number } {
  let n = 0;
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    n += 1;
    const sp = input.options?.systemPrompt;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
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
    if (sys.includes("the conductor")) {
      return /STATUS:\s*blocked/i.test(prompt)
        ? stream('{"action":"answer","reply":"try another angle","classification":"reversible","charterBasis":"retry"}')
        : stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    }
    return stream('{"ok":true,"blocking":[],"summary":"clean"}');
  }) as never);
  return { count: () => n };
}

interface Captured { out: string; err: string; }

/** Run the driver capturing everything it writes, so "no extra output" is testable. */
async function drive(root: string, argv: string[]): Promise<{ error?: unknown } & Captured> {
  const log = console.log, warn = console.warn, error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  let out = "", err = "";
  console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  console.warn = (...a: unknown[]) => { err += a.join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { err += a.join(" ") + "\n"; };
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try {
    await runDriver(root, argv);
    return { out, err };
  } catch (e) {
    return { error: e, out, err };
  } finally {
    console.log = log; console.warn = warn; console.error = error;
    process.stdout.write = write; resetQuery();
  }
}

const BASE = ["--no-review", "--no-hypotheses", "--no-literal-reset"];

// A route to item 99 in a 3-item plan: the classic dangling edge.
const DANGLING_PLAN = `# Plan

- [ ] Prepare the release
- [ ] Run the migration
      @on fail -> 99
- [ ] (after: 2) Announce the release
`;

const VALID_PLAN = `# Plan

- [ ] Prepare the release
- [ ] (after: 1) Announce the release
`;

test("a dangling edge refuses the run before the first agent: zero agents spawned", async () => {
  const { root, leo } = briefRepo(DANGLING_PLAN);
  const fake = installCountingFake();
  const r = await drive(root, BASE);

  // The run refused, naming the defect.
  assert.ok(r.error instanceof InvalidPlanGraphError, `expected InvalidPlanGraphError, got ${String(r.error)}`);
  const diags = (r.error as InvalidPlanGraphError).diagnostics;
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, "dangling-edge");
  assert.equal(diags[0].index, 2);
  assert.equal(diags[0].target, 99);

  // The diagnostic was PRINTED, naming both the offending item and its target.
  assert.match(r.err, /Invalid graph/);
  assert.match(r.err, /item 2 \("Run the migration"\)/);
  assert.match(r.err, /99/);

  // THE claim: not one agent ran.
  assert.equal(fake.count(), 0, "a rejected plan must cost zero tokens");

  // Nothing was activated either: no run_start, no item_start, no state.json.
  const ev = events(leo);
  assert.deepEqual(ev.filter((e) => e.event === "run_start"), []);
  assert.deepEqual(ev.filter((e) => e.event === "item_start"), []);
  assert.equal(fs.existsSync(path.join(leo, "state.json")), false, "the run must never be activated");

  // The refusal is on the record, with the offender named in the log too.
  const rejected = ev.filter((e) => e.event === "preflight_rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "invalid_graph");
  assert.match(JSON.stringify(rejected[0].diagnostics), /dangling-edge/);
});

test("--dry-run is gated too: a malformed plan never even prints the dry run", async () => {
  const { root } = briefRepo(DANGLING_PLAN);
  const fake = installCountingFake();
  const r = await drive(root, ["--dry-run"]);
  assert.ok(r.error instanceof InvalidPlanGraphError);
  assert.equal(fake.count(), 0);
  assert.doesNotMatch(r.out, /DRY RUN/);
});

test("a cycle is refused the same way, naming every item in it", async () => {
  const { root } = briefRepo(`# Plan

- [ ] Migrate the database
      @on fail -> 2
- [ ] Roll it back
      @on fail -> 1
`);
  const fake = installCountingFake();
  const r = await drive(root, BASE);
  assert.ok(r.error instanceof InvalidPlanGraphError);
  assert.equal((r.error as InvalidPlanGraphError).diagnostics[0].code, "cycle");
  assert.match(r.err, /item 1/);
  assert.match(r.err, /item 2/);
  assert.equal(fake.count(), 0);
});

test("a valid plan starts exactly as today: the gate adds no output and no stderr", async () => {
  const { root, leo } = briefRepo(VALID_PLAN);
  const fake = installCountingFake();
  const r = await drive(root, BASE);

  assert.equal(r.error, undefined, `a valid plan must not be rejected: ${String(r.error)}`);
  assert.ok(fake.count() > 0, "a valid plan still runs its agents");
  assert.equal(r.err, "", `the gate must be silent on a valid plan, got: ${r.err}`);
  assert.doesNotMatch(r.out, /Invalid graph|preflight|Graph is valid/i);

  // It ran to completion, and the log carries no trace of the gate.
  const ev = events(leo);
  assert.deepEqual(ev.filter((e) => e.event === "preflight_rejected"), []);
  assert.equal(ev.filter((e) => e.event === "item_start").length, 2);
});

test("every plan Leopold ships passes the gate — the fixtures and the repo's own brief", () => {
  const plans = [
    path.join(REPO, "templates", "PLAN.md"),
    path.join(REPO, ".leopold", "PLAN.md"),
    ...fs.readdirSync(path.join(HERE, "fixtures", "plans"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(HERE, "fixtures", "plans", f)),
  ].filter((p) => fs.existsSync(p));
  assert.ok(plans.length >= 3, "expected the template, the repo's brief and the plan fixtures");
  for (const p of plans) {
    const r = preflightPlan(p);
    assert.ok(r.ok, `${p} must pass the pre-flight, got:\n${r.report}`);
  }
});

test("the /leopold-run entry runs the same gate before it activates the run", () => {
  const skill = fs.readFileSync(path.join(REPO, "skills", "leopold-run", "SKILL.md"), "utf8");
  const step0 = skill.slice(skill.indexOf("## Step 0"), skill.indexOf("## Step 1"));
  assert.match(step0, /graph --quiet/, "Step 0 must validate the graph via the leopold CLI");
  assert.match(step0, /GRAPH_INVALID/, "Step 0 must have a marker the model can branch on");
  assert.match(step0, /GRAPH_UNVALIDATED/, "an absent CLI must be reported, never silently skipped");
  assert.match(step0, /do not spawn a single agent/i, "the instruction must be: refuse before any agent");
});
