// Driver checkpoint parity: the driver writes the ONE checkpoint artifact at every
// run end and consumes a present one at run start as the first dispatched item's
// lead — framed as untrusted past-window data. The seat passes between engines
// through this artifact, so the in-session skill's seeding instruction is asserted
// against the same exported contract (a drift test, like the hook's).
//
// All hermetic: temp repos, the fake SDK seam from sdk.ts, zero model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver, pickTrace, buildWorkerPrompt } from "../src/loop.ts";
import {
  CHECKPOINT_DATA_AUTHORITY,
  CHECKPOINT_TITLE,
  emptyCheckpoint,
  serializeCheckpoint,
  driverCheckpoint,
  checkpointLead,
  checkpointLine,
  parseCheckpoint,
  writeCheckpoint,
  readCheckpoint,
} from "../src/checkpoint.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

function briefRepo(items: string[], guardrails = "- max_failures: 3\n- max_iterations: 50\n"): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-cp-"));
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
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), `# Guardrails\n${guardrails}`);
  fs.writeFileSync(path.join(leo, "PLAN.md"), `# Plan\n\n${items.map((i) => `- [ ] ${i}`).join("\n")}\n`);
  return { root, leo };
}

const evLines = (leo: string): Array<Record<string, unknown>> =>
  fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** A fake SDK: the worker reports done, the conductor finishes, reviews pass.
 *  Captures every worker prompt in order. */
function fakeSdk(workerPrompts: string[]) {
  return ((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      // A worker session: the prompt is the streaming InputChannel. Capture its
      // first message — the opening worker prompt the driver built, lead included.
      const channel = input.prompt as AsyncIterable<{ message: { content: Array<{ text?: string }> } }>;
      return (async function* () {
        const first = await channel[Symbol.asyncIterator]().next();
        const text = first.done ? "" : first.value.message.content.map((c) => c.text ?? "").join("");
        workerPrompts.push(text);
        const item = /Work on this plan item now:\n\n(.+)\n/.exec(text)?.[1] ?? "item";
        const block = "```leopold-status\nSTATUS: done\nITEM: " + item +
          "\nSUMMARY: implemented and verified\nNEXT: none\nEVIDENCE: ok\n```";
        yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
        yield { type: "result", result: block, total_cost_usd: 0 };
      })();
    }
    const sys = typeof sp === "string" ? sp : "";
    const reply = sys.includes("the conductor")
      ? '{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}'
      : '{"ok":true,"blocking":[],"summary":"clean"}';
    return (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: reply }] } };
      yield { type: "result", result: reply, total_cost_usd: 0 };
    })();
  }) as never;
}

async function quietRun(root: string, argv: string[]): Promise<void> {
  const origLog = console.log; const origWarn = console.warn;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {}; console.warn = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runDriver(root, argv);
  } finally {
    console.log = origLog; console.warn = origWarn; process.stdout.write = origWrite;
  }
}

// -- the composer and the framing, as units ------------------------------------

test("driverCheckpoint composes run state only, with the next open item as Next Step", () => {
  const cp = driverCheckpoint({
    stopReason: "iteration_budget", iteration: 7,
    inFlight: "Wire the settings panel", failureDetail: "tests failed:\n  2 assertions",
    nextOpen: "Ship the docs page", decisions: ["conductor: proceed with sqlite", ""],
  });
  assert.equal(cp["In-Flight Item"], "Wire the settings panel");
  assert.match(cp["Errors and Fixes"], /Wire the settings panel: tests failed: 2 assertions/);
  assert.equal(cp["Decisions This Run"], "- conductor: proceed with sqlite");
  assert.match(cp["Current Work"], /"iteration_budget" at iteration 7/);
  assert.match(cp["Next Step"], /Ship the docs page/);
  // Brief state is structurally absent, and the document parses under the contract.
  const parsed = parseCheckpoint(`${CHECKPOINT_TITLE}\n\n` +
    (Object.entries(cp).map(([s, b]) => `## ${s}\n${b}\n`).join("\n")));
  assert.deepEqual(parsed, cp);
});

test("checkpointLine collapses newlines so a pasted body cannot read as a heading", () => {
  assert.equal(checkpointLine("npm failed:\n## npm error output\nERR!"), "npm failed: ## npm error output ERR!");
  assert.equal(checkpointLine("x".repeat(400)).length, 300);
});

test("checkpointLead frames the checkpoint as untrusted past-window data", () => {
  const cp = emptyCheckpoint();
  cp["Next Step"] = "Finish wiring the relaunch loop.";
  const lead = checkpointLead(cp);
  assert.ok(lead.includes(CHECKPOINT_DATA_AUTHORITY), "the framing sentence is the contract");
  assert.ok(lead.includes("CONTINUES"), "says the run continues, not starts over");
  assert.ok(lead.includes("Finish wiring the relaunch loop."), "carries the checkpoint content");
  assert.ok(lead.indexOf(CHECKPOINT_DATA_AUTHORITY) < lead.indexOf(CHECKPOINT_TITLE),
    "the framing comes BEFORE the untrusted content it frames");
});

// -- @scenario a driver run ending with open items → CHECKPOINT.md present,
//    parseable, Next Step = the next open item ---------------------------------

test("a driver run ending with open items writes a parseable checkpoint whose Next Step is the next open item", async () => {
  const { root, leo } = briefRepo(
    ["Wire the settings panel", "Ship the docs page"],
    "- max_failures: 3\n- max_iterations: 1\n", // stops after item 1 with item 2 open
  );
  setQuery(fakeSdk([]));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }

  const cp = readCheckpoint(path.join(leo, "CHECKPOINT.md"));
  assert.ok(cp, "CHECKPOINT.md is present and parseable");
  assert.match(cp!["Next Step"], /Ship the docs page/, "Next Step names the next open item");
  assert.match(cp!["Current Work"], /iteration_budget/, "the stop reason is recorded");
  const events = evLines(leo);
  assert.ok(events.some((e) => e.event === "checkpoint_written"), "the write is on the event stream");
  const stop = events.find((e) => e.event === "stop");
  assert.equal(stop?.reason, "iteration_budget");
});

test("a COMPLETED run archives its checkpoint — a dead run's state must not seed the next mission", async () => {
  // The old pin here asserted the opposite ("every stop reason writes the checkpoint"),
  // and it shipped a live-reproduced defect: a fresh brief's /leopold-run carried the
  // dead run's iteration=50 and stopped on turn 1 with iteration_budget. The hook's
  // allow_stop archives on plan_complete for exactly this reason; the driver mirrors it.
  const { root, leo } = briefRepo(["Only item"]);
  fs.writeFileSync(path.join(leo, "CHECKPOINT.md"), serializeCheckpoint(emptyCheckpoint()));
  setQuery(fakeSdk([]));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }
  assert.equal(fs.existsSync(path.join(leo, "CHECKPOINT.md")), false,
    "a finished run left its checkpoint in place — the next mission would inherit a dead run's state");
  const runsDir = path.join(leo, "runs");
  const archived = fs.existsSync(runsDir)
    && fs.readdirSync(runsDir).some((d) => fs.existsSync(path.join(runsDir, d, "CHECKPOINT.md")));
  assert.ok(archived, "the checkpoint was removed but not archived — run state must go WITH the run");
  const events = evLines(leo);
  assert.ok(events.some((e) => e.event === "checkpoint_archived"), "the archive is on the event stream");
});

// -- @scenario a driver run starting where an in-session window rolled → the
//    first worker's lead carries the checkpoint content, framed as data ---------

test("a present checkpoint seeds the FIRST dispatched item's lead, framed as data — and only the first", async () => {
  const { root, leo } = briefRepo(["First item", "Second item"]);
  const prior = emptyCheckpoint();
  prior["Learned Constraints"] = "- codex exec needs --skip-git-repo-check in temp dirs";
  prior["Next Step"] = "Finish wiring the relaunch loop.";
  writeCheckpoint(path.join(leo, "CHECKPOINT.md"), prior);

  const prompts: string[] = [];
  setQuery(fakeSdk(prompts));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }

  assert.equal(prompts.length, 2, "both items dispatched");
  assert.ok(prompts[0].includes(CHECKPOINT_DATA_AUTHORITY), "the first worker's lead frames the checkpoint as data");
  assert.ok(prompts[0].includes("Finish wiring the relaunch loop."), "…and carries its content");
  assert.ok(prompts[0].includes("codex exec needs --skip-git-repo-check"), "…the whole document, not one section");
  assert.ok(!prompts[1].includes(CHECKPOINT_DATA_AUTHORITY), "the second item runs without it — consumed once");
  assert.ok(evLines(leo).some((e) => e.event === "checkpoint_consumed"), "consumption is on the event stream");
});

test("a checkpoint that does not parse is loud, non-fatal, and replaced by a fresh one at run end", async () => {
  // An UNFINISHED stop (iteration budget with an item still open): the broken bytes are
  // kept aside and a fresh checkpoint is written. A COMPLETED run instead archives the
  // file as-is — dead run state goes with the run, parseable or not (covered below).
  const { root, leo } = briefRepo(
    ["Only item", "Still open"],
    "- max_failures: 3\n- max_iterations: 1\n",
  );
  fs.writeFileSync(path.join(leo, "CHECKPOINT.md"), "# Leopold Checkpoint\n\n## Next Step\nonly one section\n");
  const prompts: string[] = [];
  setQuery(fakeSdk(prompts));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }

  const events = evLines(leo);
  assert.ok(events.some((e) => e.event === "checkpoint_error" && e.phase === "read"), "the broken read is on the event stream");
  assert.ok(!prompts[0].includes(CHECKPOINT_DATA_AUTHORITY), "no lead was seeded from a broken checkpoint");
  // Run end: the unparseable bytes are kept beside the artifact, and a fresh one is written.
  assert.ok(fs.existsSync(path.join(leo, "CHECKPOINT.md.unparsed")), "the broken bytes are kept, never silently discarded");
  assert.ok(readCheckpoint(path.join(leo, "CHECKPOINT.md")), "a fresh, parseable checkpoint stands in its place");
});

// -- merge at run end: a prior window's still-true facts survive, nothing nests --

test("the run-end write MERGES a prior checkpoint: ledger lines kept, one flat document", async () => {
  const { root, leo } = briefRepo(
    ["First item", "Second item"],
    "- max_failures: 3\n- max_iterations: 1\n",
  );
  const prior = emptyCheckpoint();
  prior["Learned Constraints"] = "- the flaky test needs --runInBand";
  prior["Next Step"] = "stale next step from the old window";
  writeCheckpoint(path.join(leo, "CHECKPOINT.md"), prior);

  setQuery(fakeSdk([]));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }

  const text = fs.readFileSync(path.join(leo, "CHECKPOINT.md"), "utf8");
  assert.equal(text.split(CHECKPOINT_TITLE).length - 1, 1, "one title — merged, never nested");
  const cp = parseCheckpoint(text);
  assert.match(cp["Learned Constraints"], /--runInBand/, "the prior ledger line survives");
  assert.match(cp["Next Step"], /Second item/, "the stale Next Step is replaced by the real next open item");
  assert.ok(!cp["Next Step"].includes("stale next step"), "…and the old one is gone");
});

// -- @scenario an in-session reseed after a driver stop → continues from the
//    driver's checkpoint (hermetic: assert the seeded prompt content) -----------
// The in-session engine's reseed prompt IS skills/leopold-run/SKILL.md plus the
// checkpoint it instructs the window to read. Both halves are asserted: the file
// a driver stop wrote parses under the one contract (above), and the skill's
// seeding instruction carries the file's path, the continuation order, and the
// untrusted-data framing VERBATIM from the exported contract — a drift test in the
// exact shape of the hook's (checkpoint.test.ts).

test("the /leopold-run skill seeds the reseed from the driver's checkpoint, framed by the one contract", () => {
  const skillPath = path.resolve(HERE, "..", "..", "..", "skills", "leopold-run", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  const flat = skill.replace(/\s+/g, " ");
  assert.ok(flat.includes(".leopold/CHECKPOINT.md"), "the skill names the one artifact");
  assert.ok(flat.includes(CHECKPOINT_DATA_AUTHORITY.replace(/\s+/g, " ")),
    "the skill carries the untrusted-data framing verbatim from the exported contract");
  assert.ok(/pick up the plan from its `Next Step`/i.test(flat), "…and says to continue from Next Step");
  assert.ok(/MERGE into it/.test(flat), "…and to merge, never nest, on the next roll");
});

// -- @scenario a run with no checkpoint → driver behavior byte-identical --------

test("with no checkpoint the first worker prompt is byte-identical to the plain prompt", async () => {
  const { root } = briefRepo(["Only item"]);
  const prompts: string[] = [];
  setQuery(fakeSdk(prompts));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }
  assert.equal(prompts[0], buildWorkerPrompt("Only item", []),
    "no checkpoint → the exact prompt the driver always built (backward compatible)");
});

// --- the trace is per-item: concurrency cannot mispair a failure -----------------------
//
// One shared {inFlight, failureDetail} slot was a real bug under --parallel: item B's
// dispatch overwrote item A's in-flight mark, and B's SUCCESS then cleared A's failure
// detail — the checkpoint attributed A's failure to B or omitted it entirely, exactly
// when the next window needed it. pickTrace chooses from per-item state instead.
test("pickTrace pairs the failure with ITS item, and success elsewhere cannot erase it", () => {
  const open = new Map<string, string | undefined>();
  open.set("Item A", undefined);           // A dispatched
  open.set("Item B", undefined);           // B dispatched (would have overwritten the old slot)
  open.set("Item A", "A's tests fail on the boundary case");  // A fails (B still in flight)
  open.delete("Item B");                   // B SUCCEEDS (would have cleared A's detail)
  const t = pickTrace(open);
  assert.equal(t.inFlight, "Item A");
  assert.equal(t.failureDetail, "A's tests fail on the boundary case");

  // No failures: any open item, no invented detail.
  const plain = new Map<string, string | undefined>([["Only open", undefined]]);
  assert.deepEqual(pickTrace(plain), { inFlight: "Only open" });
  // Nothing open: nothing reported.
  assert.deepEqual(pickTrace(new Map()), {});
  // Two failures: the most recent one wins — that is the item the next window fixes.
  const two = new Map<string, string | undefined>([["A", "older"], ["B", "newer"]]);
  assert.deepEqual(pickTrace(two), { inFlight: "B", failureDetail: "newer" });
});
