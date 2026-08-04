// The worker's cost reporting — the only thing --budget-usd accumulates from.
//
// Regression: a live Codex run finished a one-item plan and wrote spent_usd: 0, with
// no `cost` event in the log. The cause was in the worker loop, not the provider, and
// it bit BOTH harnesses: when the conductor ended an item, the loop closed the input
// channel and `break`-ed immediately — so the `result` message, the only one carrying
// `total_cost_usd`, was never consumed. A worker that finished cleanly on its first
// turn reported nothing, and the budget silently never grew.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runItem } from "../src/worker.ts";
import { setQuery, resetQuery } from "../src/sdk.ts";
import type { Brief, DriverConfig } from "../src/types.ts";

function tmpBrief(): Brief {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-cost-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(leoDir);
  fs.writeFileSync(path.join(leoDir, "events.jsonl"), "");
  return { mission: "", charter: "", guardrails: "", planPath: "", root, leoDir };
}

const cfg = { maxTurnsPerItem: 10 } as DriverConfig;

/** A worker that closes one turn as done, then ends the session reporting a cost. */
function workerWithCost(item: string, usd: number) {
  const block = "```leopold-status\nSTATUS: done\nITEM: " + item +
    "\nSUMMARY: built it\nNEXT: none\nEVIDENCE: tests pass\n```";
  return (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
    yield { type: "result", result: block, total_cost_usd: usd };
  })();
}

test("an item that closes on its first turn still reports its cost", async () => {
  const brief = tmpBrief();
  const item = "Add the greeting";
  const costs: number[] = [];
  let turns = 0;

  setQuery((() => workerWithCost(item, 0.42)) as never);
  try {
    await runItem({
      brief, cfg, item, workerPrompt: "do it",
      onBlock: () => {},
      onTurn: async () => { turns += 1; return null; },   // conductor: done, end the item
      onCost: (usd) => costs.push(usd),
    });
  } finally { resetQuery(); }

  assert.equal(turns, 1, "the conductor judged exactly one turn");
  assert.deepEqual(costs, [0.42], "the item's cost reached the budget accounting");
});

test("the conductor's turn is not double-counted when the session ends", async () => {
  const brief = tmpBrief();
  const item = "Add the greeting";
  let turns = 0;

  setQuery((() => workerWithCost(item, 1)) as never);
  try {
    await runItem({
      brief, cfg, item, workerPrompt: "do it",
      onBlock: () => {},
      onTurn: async () => { turns += 1; return null; },
      onCost: () => {},
    });
  } finally { resetQuery(); }

  // The result branch re-reports only when there is UNJUDGED text left over. Here the
  // turn was already captured and judged, so it must not be handed to the conductor
  // a second time.
  assert.equal(turns, 1);
});

test("a multi-turn item accumulates one cost for the whole session", async () => {
  const brief = tmpBrief();
  const item = "Add the greeting";
  const costs: number[] = [];
  let turns = 0;

  const block = "```leopold-status\nSTATUS: done\nITEM: " + item +
    "\nSUMMARY: step\nNEXT: none\nEVIDENCE: ok\n```";
  setQuery((() => (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
    yield { type: "assistant", message: { content: [{ type: "text", text: block }] } };
    yield { type: "result", result: block, total_cost_usd: 2.5 };
  })()) as never);

  try {
    await runItem({
      brief, cfg, item, workerPrompt: "do it",
      onBlock: () => {},
      // Keep the worker going once, then end it.
      onTurn: async () => { turns += 1; return turns === 1 ? "keep going" : null; },
      onCost: (usd) => costs.push(usd),
    });
  } finally { resetQuery(); }

  assert.equal(turns, 2);
  assert.deepEqual(costs, [2.5], "one session, one cost report");
});
