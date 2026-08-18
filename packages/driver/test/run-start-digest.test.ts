// The run-start digest: a driver run starts knowing what this project already
// decided. digestOf() (unit-covered in recall.test.ts) rides the same first-lead
// seam as the 0.18.0 checkpoint — these tests pin the SEAM: the digest lands in the
// FIRST dispatched worker's prompt, framed as untrusted past-run data, after the
// checkpoint lead when both exist, and a project with NO archived runs starts
// byte-identically to a digest-less build.
//
// All hermetic: temp repos, the fake SDK seam from sdk.ts, zero model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { runDriver, firstLead, buildWorkerPrompt } from "../src/loop.ts";
import { PAST_RUN_DATA_AUTHORITY } from "../src/recall.ts";
import { CHECKPOINT_DATA_AUTHORITY, emptyCheckpoint, writeCheckpoint, checkpointLead } from "../src/checkpoint.ts";

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

function briefRepo(items: string[]): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-digest-"));
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
  fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- max_failures: 3\n- max_iterations: 50\n");
  fs.writeFileSync(path.join(leo, "PLAN.md"), `# Plan\n\n${items.map((i) => `- [ ] ${i}`).join("\n")}\n`);
  return { root, leo };
}

/** One archived run with one decision — enough for a real digest. */
function archiveRun(leo: string, name: string, decision: string, reversal: string): void {
  const dir = path.join(leo, "runs", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "DECISIONS.md"),
    `# Decisions\n\n## D1 — a past call   (turn 1, 2026-01-01T00:00:00Z)\n` +
    `Fork:        a fork\nClass:       reversible\nCharter:     simplicity\n` +
    `Decision:    ${decision}\nWhy:         because\nReversal:    ${reversal}\n`);
}

const evLines = (leo: string): Array<Record<string, unknown>> =>
  fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** A fake SDK: workers report done, the conductor finishes, reviews pass.
 *  Captures every worker prompt in order. (Same shape as driver-checkpoint's.) */
function fakeSdk(workerPrompts: string[]) {
  return ((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
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

// -- the composer, as a unit ----------------------------------------------------

test("firstLead: digest alone, checkpoint alone, both (checkpoint first), neither (undefined)", () => {
  assert.equal(firstLead(undefined, ""), undefined);
  assert.equal(firstLead("cp", ""), "cp");
  assert.equal(firstLead(undefined, "digest"), "digest");
  assert.equal(firstLead("cp", "digest"), "cp\n\ndigest");
});

// -- the seam, live against the driver loop -------------------------------------

test("an archived decision reaches the FIRST worker's prompt, framed as untrusted past-run data — and only the first", async () => {
  const { root, leo } = briefRepo(["First item", "Second item"]);
  archiveRun(leo, "20260101T000000Z-past", "sqlite via the stdlib driver", "swap the storage adapter");

  const prompts: string[] = [];
  setQuery(fakeSdk(prompts));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }

  assert.equal(prompts.length, 2, "both items dispatched");
  assert.ok(prompts[0].includes(PAST_RUN_DATA_AUTHORITY), "the digest carries the framing sentence verbatim");
  assert.ok(prompts[0].includes("sqlite via the stdlib driver"), "…and the decision");
  assert.ok(prompts[0].includes("Reversal: swap the storage adapter"), "…with its Reversal");
  assert.ok(!prompts[1].includes(PAST_RUN_DATA_AUTHORITY), "the second item runs without it — seeded once");
  assert.ok(evLines(leo).some((e) => e.event === "digest_seeded"), "the seeding is on the event stream");
});

test("@scenario no archived runs → NO digest block; the first worker prompt is byte-identical to 0.18.x", async () => {
  const { root, leo } = briefRepo(["Only item"]);
  const prompts: string[] = [];
  setQuery(fakeSdk(prompts));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }

  assert.equal(prompts.length, 1);
  // Byte-identical to the digest-less build: exactly the bare worker prompt, no lead.
  assert.equal(prompts[0], buildWorkerPrompt("Only item", []));
  assert.ok(!prompts[0].includes(PAST_RUN_DATA_AUTHORITY));
  assert.ok(!evLines(leo).some((e) => e.event === "digest_seeded"), "nothing seeded, nothing logged");
});

test("checkpoint AND archive: the first lead carries the checkpoint lead first, then the digest", async () => {
  const { root, leo } = briefRepo(["First item"]);
  const prior = emptyCheckpoint();
  prior["Next Step"] = "Finish wiring the relaunch loop.";
  writeCheckpoint(path.join(leo, "CHECKPOINT.md"), prior);
  archiveRun(leo, "20260101T000000Z-past", "plain voice everywhere", "revert the docs commit");

  const prompts: string[] = [];
  setQuery(fakeSdk(prompts));
  try { await quietRun(root, ["--no-hypotheses"]); } finally { resetQuery(); }

  const p = prompts[0];
  assert.ok(p.includes(CHECKPOINT_DATA_AUTHORITY), "the checkpoint lead is there");
  assert.ok(p.includes(PAST_RUN_DATA_AUTHORITY), "…and the digest");
  assert.ok(p.indexOf(CHECKPOINT_DATA_AUTHORITY) < p.indexOf(PAST_RUN_DATA_AUTHORITY),
    "this run's continuation outranks the project's history — checkpoint first");
  // Exactly firstLead(checkpointLead(prior), digest) rode the seam: the composed
  // lead is one contiguous block in the prompt.
  assert.ok(p.includes(`${checkpointLead(prior)}\n\n`), "the checkpoint lead is contiguous with what follows");
});
