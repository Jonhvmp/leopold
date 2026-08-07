// The seam routes each call to the right harness — issue #54.
//
// The issue's first ask: prove that the Codex path uses `codexQuery` and NEVER the
// Agent SDK. These tests assert it at the seam every model call in the driver goes
// through, so no call site can drift without failing here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setProvider, setRoleProviders, providerForRole, roleProviders, currentProvider } from "../src/sdk.ts";

test("without a hybrid assignment every role is the process default", () => {
  setRoleProviders(undefined);
  setProvider("codex");
  for (const r of ["executor", "review", "conductor"] as const) {
    assert.equal(providerForRole(r), "codex", `${r} follows the default`);
  }
  assert.equal(providerForRole(), "codex", "an untagged call too");
  assert.equal(currentProvider(), "codex");
  assert.equal(roleProviders(), undefined);
});

test("a Codex run keeps EVERY role on Codex — the Agent SDK is never reached", () => {
  // The exact regression from #54: a workflow run resolved to Codex must not put any
  // agent — worker, reviewer or conductor — on the Claude Agent SDK.
  setRoleProviders(undefined);
  setProvider("codex");
  const used = new Set(
    (["executor", "review", "conductor"] as const).map((r) => providerForRole(r)),
  );
  assert.deepEqual([...used], ["codex"]);
  assert.ok(!used.has("claude"), "no role fell through to the Agent SDK");
});

test("hybrid sends each role to its own harness", () => {
  setProvider("codex");
  setRoleProviders({ executor: "codex", review: "claude", conductor: "codex" });
  assert.equal(providerForRole("executor"), "codex");
  assert.equal(providerForRole("review"), "claude");
  assert.equal(providerForRole("conductor"), "codex");
  // An untagged call has no role, so it takes the process default rather than
  // silently borrowing another role's harness.
  assert.equal(providerForRole(), "codex");
  setRoleProviders(undefined);
});

test("clearing the assignment restores single-provider behavior", () => {
  setProvider("claude");
  setRoleProviders({ executor: "codex", review: "codex", conductor: "codex" });
  assert.equal(providerForRole("executor"), "codex");
  setRoleProviders(undefined);
  assert.equal(providerForRole("executor"), "claude");
});
