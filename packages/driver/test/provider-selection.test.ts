// Which harness answers, and who decided — issue #54.
//
// `leopold workflow --run` started the Claude Agent SDK inside a Codex session. The
// resolver's precedence ended at "both installed → Claude", so a two-harness machine
// silently picked the wrong one, and nothing in the audit trail said which had run.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveProvider, enclosingHarness, resolveRoleProviders, UnknownProviderError,
} from "../src/provider.ts";

/** Both CLIs on PATH, neither session marker set — the ambiguous case. */
const BOTH: NodeJS.ProcessEnv = {
  PATH: "/nonexistent",
  CLAUDE_HOME: "/tmp/leo-both/.claude",
  CODEX_HOME: "/tmp/leo-both/.codex",
};
import fs from "node:fs";
fs.mkdirSync("/tmp/leo-both/.claude", { recursive: true });
fs.mkdirSync("/tmp/leo-both/.codex", { recursive: true });

test("the enclosing session is detected from the marker each CLI exports", () => {
  // Verified against the live binaries: a `codex exec` child carries CODEX_THREAD_ID
  // (and CODEX_CI); a Claude Code session carries CLAUDECODE / CLAUDE_CODE_SESSION_ID.
  assert.equal(enclosingHarness({ CODEX_THREAD_ID: "019f-abc" }), "codex");
  assert.equal(enclosingHarness({ CODEX_CI: "1" }), "codex");
  assert.equal(enclosingHarness({ CLAUDECODE: "1" }), "claude");
  assert.equal(enclosingHarness({ CLAUDE_CODE_SESSION_ID: "abc" }), "claude");
  assert.equal(enclosingHarness({}), undefined, "no marker → do not guess");
});

test("with both installed, the harness we were launched FROM wins", () => {
  // This is the bug: `workflow --run` from a Codex session used to resolve to Claude.
  assert.equal(resolveProvider([], { ...BOTH, CODEX_THREAD_ID: "019f-abc" }), "codex");
  assert.equal(resolveProvider([], { ...BOTH, CLAUDECODE: "1" }), "claude");
});

test("an explicit choice still outranks the enclosing session", () => {
  const inCodex = { ...BOTH, CODEX_THREAD_ID: "019f-abc" };
  assert.equal(resolveProvider(["--provider", "claude"], inCodex), "claude");
  assert.equal(resolveProvider([], { ...inCodex, LEOPOLD_PROVIDER: "claude" }), "claude");
});

test("with no marker at all, the Claude tie-break is unchanged", () => {
  // The fallback only fires when the session is genuinely unknowable, so no existing
  // setup changes behavior.
  assert.equal(resolveProvider([], BOTH), "claude");
});

test("`--provider hybrid` names a strategy, not a harness, and still resolves a base", () => {
  // parseProvider would reject "hybrid"; resolveProvider must fall through to the rest
  // of the precedence so unassigned roles have something to inherit.
  assert.equal(resolveProvider(["--provider", "hybrid"], { ...BOTH, CODEX_THREAD_ID: "x" }), "codex");
  assert.equal(resolveProvider(["--provider", "hybrid"], BOTH), "claude");
  assert.throws(() => resolveProvider(["--provider", "gemini"], BOTH), UnknownProviderError);
});

test("a run with no hybrid flags gets no role assignment at all", () => {
  // undefined is what keeps a single-provider run byte-for-byte unchanged: every role
  // falls to the process default without the seam consulting a map.
  assert.equal(resolveRoleProviders([], "claude", {}), undefined);
  assert.equal(resolveRoleProviders(["--worktree", "--parallel", "3"], "codex", {}), undefined);
});

test("hybrid assigns per role, and an unset role inherits the base", () => {
  const r = resolveRoleProviders(
    ["--provider", "hybrid", "--executor-provider", "codex", "--review-provider", "claude"],
    "codex", {},
  );
  assert.deepEqual(r, { executor: "codex", review: "claude", conductor: "codex" });
});

test("a per-role flag alone is enough — no --provider hybrid required", () => {
  const r = resolveRoleProviders(["--review-provider", "claude"], "codex", {});
  assert.deepEqual(r, { executor: "codex", review: "claude", conductor: "codex" });
});

test("the env equivalents work, and a typo in one is loud", () => {
  const r = resolveRoleProviders([], "claude", { LEOPOLD_EXECUTOR_PROVIDER: "codex" });
  assert.deepEqual(r, { executor: "codex", review: "claude", conductor: "claude" });
  assert.throws(
    () => resolveRoleProviders([], "claude", { LEOPOLD_REVIEW_PROVIDER: "gemini" }),
    UnknownProviderError,
  );
});

test("a flag beats the env for the same role", () => {
  const r = resolveRoleProviders(
    ["--executor-provider", "claude"], "claude", { LEOPOLD_EXECUTOR_PROVIDER: "codex" },
  );
  assert.equal(r?.executor, "claude");
});
