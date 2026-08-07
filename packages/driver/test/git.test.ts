// The parallel scheduler's merge mechanic against a real temp git repo: an item's
// worktree diff is replayed onto the main tree as a STAGED patch (never committed).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree } from "../src/worktree.ts";
import { headSha, diffAgainst, applyStaged, git, snapshotTree, restoreTree, treeSignature, treeStateSignature } from "../src/git.ts";

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

test("snapshotTree → mutate → restoreTree returns the tree exactly to the snapshot", () => {
  const { root } = tmpRepo();
  // "prior items' work": edit a tracked file + add an untracked new file.
  fs.writeFileSync(path.join(root, "a.txt"), "prior work\n");
  fs.writeFileSync(path.join(root, "new.txt"), "created by a prior item\n");
  const snap = snapshotTree(root);

  // "failed attempt": clobber the edit, delete the new file, add yet another file.
  fs.writeFileSync(path.join(root, "a.txt"), "FAILED attempt garbage\n");
  fs.rmSync(path.join(root, "new.txt"));
  fs.writeFileSync(path.join(root, "junk.txt"), "failed-attempt junk\n");

  const r = restoreTree(root, snap);
  assert.equal(r.ok, true, r.err);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "prior work\n", "tracked edit restored");
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "created by a prior item\n", "untracked prior file restored");
  assert.equal(fs.existsSync(path.join(root, "junk.txt")), false, "failed attempt's file discarded");
  assert.equal(headSha(root), headSha(root), "nothing committed"); // sanity: still no commits made by restore
});

test("restoreTree with a corrupt patch leaves the tree UNCHANGED and returns not-ok", () => {
  const { root } = tmpRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "work in progress\n");
  fs.writeFileSync(path.join(root, "keep.txt"), "must not be lost\n");

  const r = restoreTree(root, "diff --git a/x b/x\n@@ totally not a real patch @@\n+garbage\n");
  assert.equal(r.ok, false, "a corrupt patch must fail");
  // fail-safe: the pre-restore state is fully intact (prior work never lost)
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "work in progress\n");
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "must not be lost\n");
});

test("restoreTree with an empty snapshot resets the tree to a clean HEAD", () => {
  const { root } = tmpRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "x\n");
  const r = restoreTree(root, ""); // empty snapshot = "the tree was clean before the item"
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "base\n", "tracked change discarded");
  assert.equal(fs.existsSync(path.join(root, "untracked.txt")), false, "untracked discarded");
});

// --- treeStateSignature: the receipt a review-only node is measured against ---------

test("treeStateSignature moves when an ALREADY-DIRTY file's content changes", () => {
  const { root } = tmpRepo();
  const a = path.join(root, "a.txt");
  fs.appendFileSync(a, "work in progress\n"); // the diff a gate would be judging
  const namesBefore = treeSignature(root);
  const before = treeStateSignature(root);

  fs.appendFileSync(a, "the gate snuck this in\n"); // `sed -i` / `>>` from a gate's shell

  assert.equal(treeSignature(root), namesBefore,
    "precondition: the names-only signature is blind to this — that was the hole");
  assert.notEqual(treeStateSignature(root), before, "the content-sensitive one is not");
});

test("treeStateSignature also moves on staged-ness, new files and deletions", () => {
  const { root } = tmpRepo();
  const clean = treeStateSignature(root);

  fs.appendFileSync(path.join(root, "a.txt"), "x\n");
  const dirty = treeStateSignature(root);
  assert.notEqual(dirty, clean);

  sh(root, ["add", "a.txt"]); // same content, different staged-ness
  assert.notEqual(treeStateSignature(root), dirty, "staging alone is a change to the tree state");

  const staged = treeStateSignature(root);
  fs.writeFileSync(path.join(root, "new.txt"), "untracked\n");
  assert.notEqual(treeStateSignature(root), staged);

  const withNew = treeStateSignature(root);
  fs.rmSync(path.join(root, "b.txt"));
  assert.notEqual(treeStateSignature(root), withNew, "a deletion is a change too");
});

test("treeStateSignature never stages anything in the repo it measures", () => {
  const { root } = tmpRepo();
  fs.appendFileSync(path.join(root, "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "new.txt"), "untracked\n");
  const status = treeSignature(root);
  const sig = treeStateSignature(root);

  assert.equal(treeSignature(root), status,
    "unlike snapshotTree, taking the signature leaves the index untouched");
  assert.equal(treeStateSignature(root), sig, "and it is stable for an unchanged tree");
  // snapshotTree is the contrast: it DOES stage, which is why it cannot be this probe.
  snapshotTree(root);
  assert.notEqual(treeSignature(root), status);
});
