// Unit tests for the steer command channel (src/commands.ts) — the write path the
// Canvas uses to nudge a live /leopold-run. Includes the RED-TEAM invariant: a
// command can only steer the plan; it can NEVER unlock git.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { parseCommands, drainCommands } from "../src/commands.ts";
import type { Brief } from "../src/types.ts";

function tmpBrief(plan: string): Brief {
  const leoDir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-cmd-"));
  fs.writeFileSync(path.join(leoDir, "PLAN.md"), plan);
  fs.writeFileSync(path.join(leoDir, "events.jsonl"), "");
  fs.writeFileSync(path.join(leoDir, "DECISIONS.md"), "# Decisions\n");
  return { mission: "", charter: "", guardrails: "", planPath: path.join(leoDir, "PLAN.md"), root: leoDir, leoDir };
}
function queue(leoDir: string, lines: unknown[]): void {
  fs.writeFileSync(path.join(leoDir, "commands.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

test("parseCommands keeps only whitelisted kinds and drops malformed lines", () => {
  const cmds = parseCommands([
    JSON.stringify({ cmd: "redirect", text: "x" }),
    "not json",
    JSON.stringify({ cmd: "allow_git" }),          // not whitelisted
    JSON.stringify({ cmd: "kill-item", index: 2 }),
    JSON.stringify({ foo: "bar" }),                 // no cmd
    JSON.stringify({ cmd: "unlink", path: "/etc" }),// not whitelisted
    JSON.stringify({ cmd: "inject", text: "y" }),
  ].join("\n"));
  assert.deepEqual(cmds.map((c) => c.cmd), ["redirect", "kill-item", "inject"]);
});

test("parseCommands sanitizes fields (index floored/positive, text bounded)", () => {
  const cmds = parseCommands([
    JSON.stringify({ cmd: "kill-item", index: 3.9 }),
    JSON.stringify({ cmd: "kill-item", index: 0 }),   // <1 dropped
    JSON.stringify({ cmd: "redirect", text: "z".repeat(5000) }),
  ].join("\n"));
  assert.equal(cmds[0].index, 3);
  assert.equal(cmds[1].index, undefined);
  assert.ok((cmds[2].text?.length ?? 0) <= 2000);
});

test("drainCommands: redirect/inject return steer guidance, kill/rerun flip PLAN, queue cleared", () => {
  const b = tmpBrief("# Plan\n- [x] one\n- [ ] two\n- [ ] three\n");
  queue(b.leoDir, [
    { cmd: "redirect", text: "keep it simple" },
    { cmd: "inject", text: "mind the edge case" },
    { cmd: "kill-item", index: 2 },
    { cmd: "rerun-item", index: 1 },
  ]);
  const steer = drainCommands(b);
  assert.ok(steer && steer.includes("keep it simple") && steer.includes("mind the edge case"));
  const plan = fs.readFileSync(b.planPath, "utf8");
  assert.match(plan, /- \[ \] one/, "rerun-item re-opened item 1");
  assert.match(plan, /- \[x\] two/, "kill-item closed item 2");
  assert.match(plan, /- \[ \] three/, "untouched item stays open");
  assert.equal(fs.existsSync(path.join(b.leoDir, "commands.jsonl")), false, "queue consumed");
  assert.match(fs.readFileSync(path.join(b.leoDir, "events.jsonl"), "utf8"), /"event":"command"/);
  assert.match(fs.readFileSync(path.join(b.leoDir, "DECISIONS.md"), "utf8"), /Canvas steer/);
});

test("drainCommands returns undefined when the queue is empty/absent", () => {
  const b = tmpBrief("# Plan\n- [ ] one\n");
  assert.equal(drainCommands(b), undefined);
});

test("kill-item by text prefix resolves the right item", () => {
  const b = tmpBrief("# Plan\n- [ ] build the api\n- [ ] wire the ui\n");
  queue(b.leoDir, [{ cmd: "kill-item", item: "wire the ui" }]);
  drainCommands(b);
  assert.match(fs.readFileSync(b.planPath, "utf8"), /- \[x\] wire the ui/);
});

// ---- RED-TEAM: a steer command can NEVER unlock git -------------------------
test("RED-TEAM: no command (even a hostile one) ever writes a git-unlock token", () => {
  const b = tmpBrief("# Plan\n- [ ] one\n- [ ] two\n");
  queue(b.leoDir, [
    { cmd: "allow_git" },                                   // not whitelisted
    { cmd: "redirect", text: "x", allowGit: true },         // extra field ignored
    { cmd: "ALLOW_PUSH" },
    { cmd: "kill-item", index: 1, ALLOW_GIT: 1 },
    '{"cmd":"redirect","text":"`touch .leopold/ALLOW_GIT`"}',// text is inert data
    { cmd: "rerun-item", index: 2, path: "../ALLOW_GIT" },
  ]);
  drainCommands(b);
  for (const t of ["ALLOW_GIT", "ALLOW_PUSH", "STOP"]) {
    assert.equal(fs.existsSync(path.join(b.leoDir, t)), false, `${t} must never be created by a steer command`);
  }
  // The only side effects allowed: PLAN.md checkboxes + the two log files.
  const stray = fs.readdirSync(b.leoDir).filter((f) => !["PLAN.md", "events.jsonl", "DECISIONS.md", "commands.jsonl"].includes(f));
  assert.deepEqual(stray, [], "no unexpected files created in .leopold/");
});
