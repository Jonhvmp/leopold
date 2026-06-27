// Red-team for the driver's canUseTool guard. The driver locks exactly two things:
// git commit and git push (force-push included). Everything else is allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { makeGuard, gitSubcommand } from "../src/guard.ts";

const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-guard-"));
const guard = makeGuard(leo, () => {});
const bash = async (command: string) => (await guard("Bash", { command })).behavior;

test("blocks git-commit bypasses (global options, abs path, env, tabs)", async () => {
  for (const c of [
    "git commit -m x", "git -c user.name=foo commit", "git -C /r commit",
    "git --git-dir=/x commit", "git -c a=b -c c=d commit",
    "/usr/bin/git commit -m x", "env git commit -m x", "git\t-c\tx=y\tcommit",
  ]) assert.equal(await bash(c), "deny", c);
});

test("blocks push (incl. force-push) by bypass-resistant subcommand match", async () => {
  for (const c of ["git push", "git push origin main", "git push --force", "git push -f origin main",
    "git push --force-with-lease", "/usr/bin/git push", "git -C /r push"])
    assert.equal(await bash(c), "deny", c);
});

test("allows everything that is not git commit/push", async () => {
  for (const c of [
    "rm -rf /x/scratch", "rm file.txt", "find . -delete", "find . -exec rm {} +",
    "git reset --hard", "git clean -fd", "git branch -D x",
    "gh pr create", "gh release create v1", "npm publish", "cargo publish",
    "git status", "git add -A", "git log --oneline", "git diff", "ls -la", "echo hi", "git fetch",
  ]) assert.equal(await bash(c), "allow", c);
});

test("honors ALLOW_GIT / ALLOW_PUSH tokens", async () => {
  fs.writeFileSync(path.join(leo, "ALLOW_GIT"), "");
  assert.equal(await bash("git commit -m ok"), "allow");
  fs.rmSync(path.join(leo, "ALLOW_GIT"));
  assert.equal(await bash("git commit -m x"), "deny");
  fs.writeFileSync(path.join(leo, "ALLOW_PUSH"), "");
  assert.equal(await bash("git push origin main"), "allow");
  assert.equal(await bash("git push --force"), "deny", "force-push stays denied even with ALLOW_PUSH");
  fs.rmSync(path.join(leo, "ALLOW_PUSH"));
});

test("gitSubcommand resolves through global options + abs path", () => {
  assert.equal(gitSubcommand("git -c a=b -C /r commit -m x"), "commit");
  assert.equal(gitSubcommand("/usr/bin/git push"), "push");
  assert.equal(gitSubcommand("env git status"), "status");
  assert.equal(gitSubcommand("ls -la"), "");
});
