// The parallel scheduler's merge mechanic against a real temp git repo: an item's
// worktree diff is replayed onto the main tree as a STAGED patch (never committed).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree } from "../src/worktree.ts";
import { headSha, diffAgainst, applyStaged, git } from "../src/git.ts";

function sh(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
function tmpRepo(): { root: string; leo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-git-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@example.com"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "a.txt"), "base\n");
  fs.writeFileSync(path.join(root, "b.txt"), "base\n");
  sh(root, ["add", "-A"]);
  sh(root, ["commit", "-qm", "init"]);
  const leo = path.join(root, ".leopold");
  fs.mkdirSync(leo);
  return { root, leo };
}

test("an item's worktree diff replays onto the main tree, staged (not committed)", () => {
  const { root, leo } = tmpRepo();
  const base = headSha(root);
  const wt = createWorktree(root, leo, "i1")!;

  // The "worker" edits a file inside its isolated worktree.
  fs.writeFileSync(path.join(wt.path, "a.txt"), "changed by item 1\n");
  const patch = diffAgainst(wt.path, base);
  assert.match(patch, /changed by item 1/);

  const res = applyStaged(root, patch);
  assert.equal(res.ok, true, res.err);

  // Main tree now carries the change, staged, with no new commit.
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "changed by item 1\n");
  assert.match(git(root, ["diff", "--cached", "--name-only"]).out, /a\.txt/);
  assert.equal(headSha(root), base, "nothing should have been committed");
});

test("two independent items both land on the main tree", () => {
  const { root, leo } = tmpRepo();
  const base = headSha(root);
  const w1 = createWorktree(root, leo, "p1")!;
  const w2 = createWorktree(root, leo, "p2")!;

  fs.writeFileSync(path.join(w1.path, "a.txt"), "from one\n");
  fs.writeFileSync(path.join(w2.path, "b.txt"), "from two\n");

  // Serialized apply (what the scheduler does).
  assert.equal(applyStaged(root, diffAgainst(w1.path, base)).ok, true);
  assert.equal(applyStaged(root, diffAgainst(w2.path, base)).ok, true);

  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "from one\n");
  assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "from two\n");
});

test("a conflicting patch is reported (ok:false) so the worktree is preserved", () => {
  const { root, leo } = tmpRepo();
  const base = headSha(root);
  const wt = createWorktree(root, leo, "c1")!;

  // Main tree already diverged on the same line the item also rewrites.
  fs.writeFileSync(path.join(root, "a.txt"), "main moved this line\n");
  git(root, ["add", "a.txt"]);

  fs.writeFileSync(path.join(wt.path, "a.txt"), "item rewrote the same line\n");
  const res = applyStaged(root, diffAgainst(wt.path, base));
  assert.equal(res.ok, false, "a real conflict must not silently apply");
});

test("an empty patch is a clean no-op", () => {
  const { root } = tmpRepo();
  assert.equal(applyStaged(root, "").ok, true);
  assert.equal(applyStaged(root, "   \n").ok, true);
});
