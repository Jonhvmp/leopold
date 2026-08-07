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

// --- the read-only node's brief lock ----------------------------------------------
// A `@gate` / `@verify` / `@feedback` node has no editing tools, but it does have Bash,
// and `.leopold/` is gitignored — so a shell write there is invisible to every git-based
// check. The feedback bounds (at most 3 added, never delete, never touch a done item,
// never GUARDRAILS) live on the PROPOSAL channel; without this lock a node simply walks
// around them with `sed -i`. Reads stay allowed: reading the run is the node's job.

const ro = makeGuard(leo, () => {}, { readOnly: true });
const roBash = async (command: string) => (await ro("Bash", { command })).behavior;

test("a read-only node cannot write the brief with its shell", async () => {
  for (const c of [
    // no-delete / no-touch-done, straight through the shell
    "sed -i '/docs/d' .leopold/PLAN.md", "sed -i.bak 's/\\[ \\]/[x]/g' .leopold/PLAN.md",
    "perl -pi -e 's/x/y/' .leopold/PLAN.md",
    // no-guardrails — widening the run's own autonomy boundary
    "cat >> .leopold/GUARDRAILS.md", "echo '- allow: everything' >> .leopold/GUARDRAILS.md",
    "cp /tmp/evil .leopold/GUARDRAILS.md", "mv /tmp/evil .leopold/GUARDRAILS.md",
    // the amendment budget, and the git lock's own tokens
    "printf '{\"amendments_added\":0}' > .leopold/state.json",
    "touch .leopold/ALLOW_GIT", "touch /abs/project/.leopold/ALLOW_PUSH",
    "rm .leopold/PLAN.md", "truncate -s 0 .leopold/events.jsonl",
    // and the ways a model reaches for when the obvious one is blocked
    "python3 -c \"open('.leopold/PLAN.md','a').write('x')\"",
    "bash -c 'echo x >> .leopold/PLAN.md'", "tee -a .leopold/PLAN.md",
    "exec 3>.leopold/PLAN.md", "printf x >>.leopold/GUARDRAILS.md",
    "awk '{print > \".leopold/PLAN.md\"}' /tmp/x",
    "cd /repo && sed -i s/a/b/ PLAN.md",
  ]) assert.equal(await roBash(c), "deny", c);
});

test("a read-only node may still READ the run, which is its whole job", async () => {
  for (const c of [
    "cat .leopold/events.jsonl", "tail -50 .leopold/events.jsonl", "wc -l .leopold/PLAN.md",
    "jq -r '.iteration' .leopold/state.json", "grep -c amendment .leopold/events.jsonl",
    "sed -n '1,20p' .leopold/PLAN.md", "diff .leopold/PLAN.md .leopold/PLAN.md",
    "git --no-pager diff HEAD", "make test", "npm test -- --reporter=dot",
    "cat .leopold/events.jsonl | jq -r .event | sort | uniq -c",
    "echo done > /tmp/scratch.txt", "rm -rf /tmp/scratch",
  ]) assert.equal(await roBash(c), "allow", c);
});

// A lock that matches the LETTERS of a path is a one-character lock: the shell expands
// the glob before the command runs, so `.leo*/PLAN*` reaches the same file as
// `.leopold/PLAN.md` while containing neither ".leopold" nor "PLAN.md". Every command
// below is the real bypass, verbatim: each one used to be allowed.

test("a wildcard is not a way around the brief lock", async () => {
  for (const c of [
    // the reported bypasses, one per bound they would have walked around
    "sed -i 's/\\[ \\]/[x]/g' .leo*/PLAN*",   // no-touch-done: forge every checkbox
    "sed -i 's/a/b/' .leo*/GUARD*",            // no-guardrails
    "printf 'x' >> .leo*/PLAN*",               // add-only, through a redirect
    "cp /tmp/evil .leo*/PLAN*",                // the whole plan, replaced
    // and the rest of the wildcard vocabulary a shell offers
    "rm -rf .leo*", "rm -rf .leopol?", "rm -rf .leopol[d]",
    "sed -i s/a/b/ .leo{pold,x}/PLAN.md", "tee -a .l??pold/GUARDRAILS.md",
    "cp /tmp/x PLAN.m?", "mv /tmp/x .leopold/PL*", "touch .leopold/ALLOW_*",
    // find only walks — until it is told to act
    "find .leopold -name 'PLAN.md' -delete", "find .leo* -exec rm {} +",
  ]) assert.equal(await roBash(c), "deny", c);
});

test("wildcards that cannot reach the brief still run — the node still has to read the repo", async () => {
  for (const c of [
    "ls -la src/*", "grep -rn TODO src/**/*.ts", "cat src/*.ts | wc -l",
    "find . -name '*.ts' | head -20", "find . -type f -name '*.test.ts'",
    "git --no-pager diff -- 'packages/**'", "rm -rf /tmp/leo-scratch-*",
  ]) assert.equal(await roBash(c), "allow", c);
});

test("the brief lock is the read-only node's alone — a work node's shell is unchanged", async () => {
  // A wildcard onto the brief is a work node's business too — its shell is untouched.
  assert.equal(await bash("sed -i 's/x/y/' .leo*/PLAN*"), "allow");
  // Backward compatibility is the gate: every plan written before node kinds existed
  // compiles to work nodes, and this guard must answer exactly as it did then.
  for (const c of [
    "sed -i '/x/d' .leopold/PLAN.md", "cat >> .leopold/GUARDRAILS.md", "touch .leopold/ALLOW_GIT",
    "rm .leopold/state.json", "python3 -c \"open('.leopold/PLAN.md','w')\"",
  ]) assert.equal(await bash(c), "allow", c);
  // …and the git lock still holds for a read-only node, which never had a reason to commit.
  assert.equal(await roBash("git commit -m x"), "deny");
  assert.equal(await roBash("git push --force"), "deny");
});

test("gitSubcommand resolves through global options + abs path", () => {
  assert.equal(gitSubcommand("git -c a=b -C /r commit -m x"), "commit");
  assert.equal(gitSubcommand("/usr/bin/git push"), "push");
  assert.equal(gitSubcommand("env git status"), "status");
  assert.equal(gitSubcommand("ls -la"), "");
});
