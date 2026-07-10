// End-to-end LOOP integration with ZERO model calls.
//
// The whole conductor ↔ worker ↔ review loop reaches Claude Code through the one
// seam in src/sdk.ts. Here we inject a deterministic fake (setQuery) that routes by
// system prompt — worker / conductor / review lens — and drive the real processItem.
// This proves the R1 conformance path executes for real: worker reports done → a
// scenario-bearing review BLOCKS → the fix comes back to the worker → it passes →
// the item closes. No SDK, no tokens, fully deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setQuery, resetQuery } from "../src/sdk.ts";
import { processItem, runDriver } from "../src/loop.ts";
import type { Brief, DriverConfig, RunState } from "../src/types.ts";

function sh(cwd: string, args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function tmpRepo(): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-loop-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo); fs.writeFileSync(path.join(leo, "events.jsonl"), "");
  return { root, leo };
}

/** A finished async stream of SDK messages carrying one assistant text + a result. */
function stream(text: string) {
  return (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    yield { type: "result", result: text, total_cost_usd: 0 };
  })();
}
/** A worker stream that yields N done-turns then a result (multi-turn, channel-blind). */
function workerStream(item: string, turns: number) {
  const block = "```leopold-status\nSTATUS: done\nITEM: " + item +
    "\nSUMMARY: implemented and verified\nNEXT: none\nEVIDENCE: build+test ok\n```";
  return (async function* () {
    for (let i = 0; i < turns; i++) yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
    yield { type: "result", result: block, total_cost_usd: 0 };
  })();
}

const cfg = {
  maxTurnsPerItem: 40, review: true, maxReviewRounds: 2, conformance: true,
  hypotheses: false, smartRouting: false, learnOnFinish: false, parallel: 1,
  literalReset: false, bestOfK: 1, sliceScope: false, worktree: false, dryRun: false,
} as DriverConfig;
const state = (): RunState =>
  ({ active: true, iteration: 1, max_iterations: 50, consecutive_failures: 0, max_failures: 3, started_at: "" });

test("R1 in the full item loop: a scenario blocks once, the fix comes back, then the item closes", async () => {
  const { root, leo } = tmpRepo();
  const brief = { mission: "", charter: "", guardrails: "", planPath: "", root, leoDir: leo } as Brief;
  const item = "Render the profile card";

  let conformanceCalls = 0;
  const sawFixInstruction: string[] = [];

  // Route each model call by its system prompt. Worker = the claude_code preset.
  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      return workerStream(item, 2); // two done-turns available (block → fix → pass)
    }
    const sys = typeof sp === "string" ? sp : "";
    if (sys.includes("the conductor")) return stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    if (sys.includes("Your lens is CONFORMANCE")) {
      conformanceCalls += 1;
      return conformanceCalls === 1
        ? stream('{"ok":false,"blocking":[{"file":"card.tsx","issue":"scenario \\"empty name → placeholder\\" unmet: renders nothing","severity":"blocking"}],"summary":"1 scenario unmet"}')
        : stream('{"ok":true,"blocking":[],"summary":"all scenarios satisfied"}');
    }
    if (sys.includes("review gate")) return stream('{"ok":true,"blocking":[],"summary":"clean"}'); // correctness lens
    return stream('{"ok":true}');
  }) as never);

  try {
    // Wrap onTurn indirectly: processItem drives it; we observe via the fix returning
    // to the worker (the second worker turn only happens if the block was pushed back).
    const orig = console.log;
    console.log = (...a: unknown[]) => { const s = a.join(" "); if (/review ->/.test(s)) sawFixInstruction.push(s); };
    const outcome = await processItem(brief, cfg, state(), [], item, ["empty name → placeholder"], root);
    console.log = orig;

    assert.equal(outcome.done, true, "the item closes after the fix");
    assert.equal(outcome.escalated, false);
    assert.equal(conformanceCalls, 2, "conformance ran twice: blocked once, then passed");
    assert.ok(sawFixInstruction.some((s) => /blocking/.test(s)), "a blocking review round happened before it closed");
  } finally {
    resetQuery();
  }
});

test("an item with NO scenarios never invokes the conformance lens (backward compatible)", async () => {
  const { root, leo } = tmpRepo();
  const brief = { mission: "", charter: "", guardrails: "", planPath: "", root, leoDir: leo } as Brief;
  const item = "Tidy the header spacing";
  let conformanceCalls = 0;

  setQuery(((input: { options?: { systemPrompt?: unknown } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") return workerStream(item, 1);
    const sys = typeof sp === "string" ? sp : "";
    if (sys.includes("the conductor")) return stream('{"action":"finish","classification":"n/a","charterBasis":"done"}');
    if (sys.includes("Your lens is CONFORMANCE")) { conformanceCalls += 1; return stream('{"ok":true,"blocking":[]}'); }
    if (sys.includes("review gate")) return stream('{"ok":true,"blocking":[],"summary":"clean"}');
    return stream('{"ok":true}');
  }) as never);

  try {
    const outcome = await processItem(brief, cfg, state(), [], item, [], root); // no scenarios
    assert.equal(outcome.done, true);
    assert.equal(conformanceCalls, 0, "no scenarios → conformance lens never runs (unchanged behavior)");
  } finally {
    resetQuery();
  }
});

// --- R2: the literal fresh restart firing in the real runDriver serial loop ---

function briefRepo(item: string): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-r2-"));
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
  fs.writeFileSync(path.join(leo, "PLAN.md"), `# Plan\n\n- [ ] ${item}\n`);
  return { root, leo };
}
const evLines = (leo: string): Array<Record<string, unknown>> =>
  fs.readFileSync(path.join(leo, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("R2 in runDriver: item fails once, literal reset discards the dead-end diff, retry closes it", async () => {
  const item = "Wire the settings panel";
  const { root, leo } = briefRepo(item);
  let workerCalls = 0;
  let worktreeCwd = "";

  setQuery(((input: { prompt?: unknown; options?: { systemPrompt?: unknown; cwd?: string } }) => {
    const sp = input.options?.systemPrompt;
    if (sp && typeof sp === "object" && (sp as { type?: string }).type === "preset") {
      // Worker. First attempt: leave a dead-end file and report blocked (→ fails).
      workerCalls += 1;
      const cwd = input.options?.cwd ?? "";
      const done = "```leopold-status\nSTATUS: done\nITEM: " + item + "\nSUMMARY: done\nNEXT: none\nEVIDENCE: ok\n```";
      const blocked = "```leopold-status\nSTATUS: blocked\nITEM: " + item + "\nSUMMARY: stuck\nNEXT: ?\nEVIDENCE: \n```";
      if (workerCalls === 1) {
        worktreeCwd = cwd;
        fs.writeFileSync(path.join(cwd, "dead-end.txt"), "the failed approach\n");
        return stream(blocked);
      }
      return stream(done);
    }
    const sys = typeof sp === "string" ? sp : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (sys.includes("the conductor")) {
      return /STATUS:\s*blocked/i.test(prompt)
        ? stream('{"action":"answer","reply":"take a different approach"}')
        : stream('{"action":"finish","classification":"n/a","charterBasis":"worker reported done"}');
    }
    if (sys.includes("review gate")) return stream('{"ok":true,"blocking":[],"summary":"clean"}');
    return stream('{"ok":true}');
  }) as never);

  const origLog = console.log; const origWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {}; process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runDriver(root, ["--worktree", "--no-hypotheses"]); // isolated run → literal reset can fire
  } finally {
    console.log = origLog; process.stdout.write = origWrite; resetQuery();
  }

  const events = evLines(leo);
  const kinds = events.map((e) => e.event);
  const iFail = kinds.indexOf("item_incomplete");
  const iReset = events.findIndex((e) => e.event === "literal_reset");
  const iDone = kinds.indexOf("item_done");

  assert.ok(iFail >= 0, "the first attempt was recorded as incomplete");
  assert.ok(iReset >= 0, "a literal_reset fired on the retry");
  assert.equal(events[iReset].ok, true, "the restore succeeded");
  assert.ok(iDone >= 0, "the item eventually completed");
  assert.ok(iFail < iReset && iReset < iDone, "sequence: fail → literal reset → done");
  assert.ok(kinds.includes("stop"), "the run stopped cleanly");
  // the dead-end diff the first attempt left behind was discarded by the restore
  assert.equal(fs.existsSync(path.join(worktreeCwd, "dead-end.txt")), false, "the failed diff is gone");
  // the plan item is checked off
  assert.match(fs.readFileSync(path.join(leo, "PLAN.md"), "utf8"), /- \[x\] Wire the settings panel/);
});
