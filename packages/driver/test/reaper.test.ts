// Orphan reaper: PID-liveness reaping of a crashed run, and the safety rule that
// a live (or pid-less, in-session) run is never clobbered.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { isProcessAlive, reapOrphan } from "../src/reaper.ts";

const DEAD_PID = 0x7fffffff; // 2147483647 — effectively never a live pid

function tmpLeo(state?: Record<string, unknown>): string {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-reap-"));
  if (state) fs.writeFileSync(path.join(leo, "state.json"), JSON.stringify(state));
  return leo;
}
const readState = (leo: string) => JSON.parse(fs.readFileSync(path.join(leo, "state.json"), "utf8"));

test("isProcessAlive: own pid alive, absurd pid dead", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
});

test("reaps an active run whose pid is dead", () => {
  const leo = tmpLeo({ active: true, orchestrator_pid: DEAD_PID, started_at: "2026-01-01T00:00:00Z" });
  reapOrphan(os.tmpdir(), leo);
  const s = readState(leo);
  assert.equal(s.active, false);
  assert.equal(s.stopped_reason, "reaped_orphan");
});

test("leaves a live run untouched (own pid)", () => {
  const leo = tmpLeo({ active: true, orchestrator_pid: process.pid });
  reapOrphan(os.tmpdir(), leo);
  assert.equal(readState(leo).active, true);
});

test("never clobbers an active run with no pid (in-session Path B)", () => {
  const leo = tmpLeo({ active: true });
  reapOrphan(os.tmpdir(), leo);
  assert.equal(readState(leo).active, true);
});

test("no-op when already inactive, and no throw when state.json is missing", () => {
  const leo = tmpLeo({ active: false, orchestrator_pid: DEAD_PID });
  reapOrphan(os.tmpdir(), leo);
  assert.equal(readState(leo).active, false);
  assert.doesNotThrow(() => reapOrphan(os.tmpdir(), tmpLeo()));
});
