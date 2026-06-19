// Red-team for the driver's canUseTool guard — mirrors scripts/test-guard.sh.
// Every documented bypass is a regression test here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { makeGuard, gitSubcommand, isRecursiveForceRm, isFindDelete } from "../src/guard.ts";

const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-guard-"));
const guard = makeGuard(leo, () => {});
const bash = async (command: string) => (await guard("Bash", { command })).behavior;
const edit = async (file_path: string) => (await guard("Edit", { file_path })).behavior;

test("blocks git-commit bypasses (global options, abs path, env, tabs)", async () => {
  for (const c of [
    "git commit -m x", "git -c user.name=foo commit", "git -C /r commit",
    "git --git-dir=/x commit", "git -c a=b -c c=d commit",
    "/usr/bin/git commit -m x", "env git commit -m x", "git\t-c\tx=y\tcommit",
  ]) assert.equal(await bash(c), "deny", c);
});

test("blocks recursive+force rm in any spelling", async () => {
  for (const c of ["rm -rf /x", "rm -fr /x", "rm -Rf x", "rm --recursive --force /x", "rm -r -f /x", "/bin/rm -rf /x"])
    assert.equal(await bash(c), "deny", c);
});

test("blocks find -delete / -exec rm", async () => {
  assert.equal(await bash("find . -delete"), "deny");
  assert.equal(await bash("find . -type f -delete"), "deny");
  assert.equal(await bash("find . -exec rm {} +"), "deny");
});

test("blocks push / destructive git / pr / publish", async () => {
  for (const c of ["git push", "git push origin main", "git push --force", "git push -f origin main",
    "git reset --hard", "git clean -fd", "git branch -D x", "gh pr create", "gh release create v1", "npm publish", "cargo publish"])
    assert.equal(await bash(c), "deny", c);
});

test("allows safe ops", async () => {
  for (const c of ["rm file.txt", "rm -i note.md", "git status", "git add -A", "git log --oneline", "git diff", "ls -la", "echo hi", "git fetch"])
    assert.equal(await bash(c), "allow", c);
});

test("honors ALLOW_GIT / ALLOW_PUSH tokens", async () => {
  fs.writeFileSync(path.join(leo, "ALLOW_GIT"), "");
  assert.equal(await bash("git commit -m ok"), "allow");
  fs.rmSync(path.join(leo, "ALLOW_GIT"));
  assert.equal(await bash("git commit -m x"), "deny");
  fs.writeFileSync(path.join(leo, "ALLOW_PUSH"), "");
  assert.equal(await bash("git push origin main"), "allow");
  fs.rmSync(path.join(leo, "ALLOW_PUSH"));
});

test("blocks edits to guardrails / settings / hooks / state, allows source", async () => {
  for (const p of ["/r/.leopold/GUARDRAILS.md", "/home/u/.claude/settings.json", "/x/leopold/hooks/y.sh", "/r/.leopold/state.json"])
    assert.equal(await edit(p), "deny", p);
  assert.equal(await edit("/r/src/main.ts"), "allow");
});

test("gitSubcommand resolves through global options + abs path", () => {
  assert.equal(gitSubcommand("git -c a=b -C /r commit -m x"), "commit");
  assert.equal(gitSubcommand("/usr/bin/git push"), "push");
  assert.equal(gitSubcommand("env git status"), "status");
  assert.equal(gitSubcommand("ls -la"), "");
});

test("detection helpers are exact", () => {
  assert.equal(isRecursiveForceRm("rm --recursive --force x"), true);
  assert.equal(isRecursiveForceRm("rm file.txt"), false);
  assert.equal(isFindDelete("find . -delete"), true);
  assert.equal(isFindDelete("find . -name x"), false);
});
