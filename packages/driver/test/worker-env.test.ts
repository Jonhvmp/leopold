// The per-item flush policy's driver half: EVERY SDK session the driver spawns —
// per-item workers, review lenses, tournament judges, hypothesis and route sessions —
// is marked with LEOPOLD_SDK_WORKER=1 in its environment, injected at the one query
// seam (sdk.ts) every call site goes through. Hooks that inherit it (verified live —
// docs/reference/sdk-worker-hooks.md: all four hooks fire per worker and see the
// driver's env) can tell an ephemeral driver-spawned session from a real one. ovmem
// reads the marker to suppress per-item flushes; marking only worker.ts (the old
// shape) left reviewer/judge sessions — hooks equally live — dumping one untagged
// OV session each into the memory base on a default-config run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runItem } from "../src/worker.ts";
import { query, setQuery, resetQuery } from "../src/sdk.ts";
import type { Brief, DriverConfig } from "../src/types.ts";

function tmpBrief(): Brief {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-wenv-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(leoDir);
  fs.writeFileSync(path.join(leoDir, "events.jsonl"), "");
  return { mission: "", charter: "", guardrails: "", planPath: "", root, leoDir };
}

const cfg = { maxTurnsPerItem: 10 } as DriverConfig;

const DONE_BLOCK = "```leopold-status\nSTATUS: done\nITEM: x\nSUMMARY: ok\nNEXT: none\nEVIDENCE: n/a\n```";

function oneTurn() {
  return (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: DONE_BLOCK }] } };
    yield { type: "result", result: DONE_BLOCK };
  })();
}

test("every SDK worker is marked LEOPOLD_SDK_WORKER=1 in its env", async () => {
  const brief = tmpBrief();
  let seenEnv: Record<string, string | undefined> | undefined;

  setQuery(((args: { options?: { env?: Record<string, string | undefined> } }) => {
    seenEnv = args.options?.env;
    return oneTurn();
  }) as never);
  try {
    await runItem({
      brief, cfg, item: "x", workerPrompt: "do it",
      onBlock: () => {},
      onTurn: async () => null,
    });
  } finally { resetQuery(); }

  assert.ok(seenEnv, "the worker passed an env to the SDK");
  assert.equal(seenEnv?.LEOPOLD_SDK_WORKER, "1",
    "the per-item worker marker is set — ovmem's flush suppression keys on it");
});

test("the seam marks EVERY driver-spawned session, not just executor workers", () => {
  // Shaped like the reviewer/judge/hypothesis/route call sites: hooks live
  // (settingSources user+project) and NO env of their own — before the seam-level
  // marker these sessions inherited the driver's unmarked process.env and their
  // SessionEnd/PreCompact ovmem flushes were NOT suppressed.
  let seen: { options?: { env?: Record<string, string | undefined> } } | undefined;
  setQuery(((args: typeof seen) => {
    seen = args;
    return (async function* () {})();
  }) as never);
  try {
    query({
      prompt: "review the diff",
      options: { leopoldRole: "review", settingSources: ["user", "project"] } as never,
    } as never);
  } finally { resetQuery(); }

  assert.equal(seen?.options?.env?.LEOPOLD_SDK_WORKER, "1",
    "a hooks-live session with no env of its own is still marked at the seam");
});

test("the seam preserves a caller-provided env while adding the marker", () => {
  let seen: { options?: { env?: Record<string, string | undefined> } } | undefined;
  setQuery(((args: typeof seen) => {
    seen = args;
    return (async function* () {})();
  }) as never);
  try {
    query({
      prompt: "x",
      options: { env: { MY_SECRET: "s3cret" } } as never,
    } as never);
  } finally { resetQuery(); }

  assert.equal(seen?.options?.env?.LEOPOLD_SDK_WORKER, "1");
  assert.equal(seen?.options?.env?.MY_SECRET, "s3cret",
    "the seam augments the caller's env, never replaces it");
});

test("the marker never leaks into the driver's own process env", async () => {
  const brief = tmpBrief();
  assert.equal(process.env.LEOPOLD_SDK_WORKER, undefined, "clean before");

  setQuery((() => oneTurn()) as never);
  try {
    await runItem({
      brief, cfg, item: "x", workerPrompt: "do it",
      onBlock: () => {},
      onTurn: async () => null,
    });
  } finally { resetQuery(); }

  assert.equal(process.env.LEOPOLD_SDK_WORKER, undefined,
    "the conductor's process is not a worker: its env stays unmarked");
});

// The seam builds a FRESH request for the dispatch: mutating the caller's object made
// the env injection observable after the call — a call site reusing or inspecting its
// request found an env snapshot (plus the marker) it never set.
test("the seam never mutates the caller's request object", () => {
  const seen: unknown[] = [];
  setQuery(((req: unknown) => { seen.push(req); return (async function* () {})(); }) as never);
  try {
    const mine = { prompt: "x", options: { leopoldRole: "executor" as const } };
    void query(mine as never);
    assert.equal((mine.options as { env?: unknown }).env, undefined,
      "the caller's options gained an env it never set — the seam aliased the request");
    const dispatched = seen[0] as { options?: { env?: Record<string, string> } };
    assert.equal(dispatched.options?.env?.LEOPOLD_SDK_WORKER, "1",
      "the dispatched request must still carry the marker");
    assert.notEqual(dispatched, mine, "dispatch must receive a fresh object, not the caller's");
  } finally { resetQuery(); }
});
