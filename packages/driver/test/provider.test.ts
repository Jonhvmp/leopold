// Unit tests for the adaptive harness layer: which harness a run is conducted on,
// and what Leopold is allowed to assume about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HARNESSES, harnessHome, skillsDir, settingsPath, parseProvider, resolveProvider,
  installedHarnesses, describeHarness, UnknownProviderError,
} from "../src/provider.ts";

/** A machine with no harness at all: nothing on PATH, no harness home on disk. */
const NOTHING: NodeJS.ProcessEnv = {
  PATH: "/nonexistent-leopold-path",
  CLAUDE_HOME: "/nonexistent-home/.claude",
  CODEX_HOME: "/nonexistent-home/.codex",
};

test("both harnesses expose the two hooks Leopold is built on", () => {
  for (const h of [HARNESSES.claude, HARNESSES.codex]) {
    // PreToolUse deny is the git lock. Verified on both: Leopold's unmodified guard
    // stops a `git commit` in a Claude session and in a Codex session alike.
    assert.equal(h.hooks.preToolUseDeny, true, `${h.id} PreToolUse`);
    // Stop block+reason is the autonomous engine — it is what puts the agent back to
    // work instead of ending the turn. Verified on both.
    assert.equal(h.hooks.stopBlock, true, `${h.id} Stop`);
    assert.equal(h.continuity, "stop-hook", `${h.id} continuity`);
  }
});

test("the difference that survives is procedural, not a missing capability", () => {
  // Codex will not run a hook declared in config.toml until it has been trusted once.
  // Nothing else about the hook contract differs, so this is the only thing the
  // installer and the headless driver have to work around.
  assert.equal(HARNESSES.claude.hookTrustGate, false);
  assert.equal(HARNESSES.codex.hookTrustGate, true);
  assert.ok(HARNESSES.codex.caveat, "a harness with a trust gate must explain it");
  assert.match(String(HARNESSES.codex.caveat), /trust/i);
});

test("harness paths honor the relocation env vars", () => {
  const env = { CLAUDE_HOME: "/tmp/cc", CODEX_HOME: "/tmp/cx" } as NodeJS.ProcessEnv;
  assert.equal(harnessHome("claude", env), "/tmp/cc");
  assert.equal(harnessHome("codex", env), "/tmp/cx");
  assert.equal(skillsDir("codex", env), "/tmp/cx/skills");
  assert.equal(settingsPath("claude", env), "/tmp/cc/settings.json");
  assert.equal(settingsPath("codex", env), "/tmp/cx/config.toml");
});

test("each harness declares where it keeps settings and project memory", () => {
  assert.equal(HARNESSES.claude.settingsFormat, "json");
  assert.equal(HARNESSES.codex.settingsFormat, "toml");
  assert.equal(HARNESSES.claude.memoryFile, "CLAUDE.md");
  assert.equal(HARNESSES.codex.memoryFile, "AGENTS.md");
});

test("provider names normalize, and a typo is loud", () => {
  assert.equal(parseProvider("claude"), "claude");
  assert.equal(parseProvider("Claude-Code"), "claude");
  assert.equal(parseProvider("anthropic"), "claude");
  assert.equal(parseProvider(" CODEX "), "codex");
  assert.equal(parseProvider("openai"), "codex");
  assert.throws(() => parseProvider("gemini"), UnknownProviderError);
  assert.throws(() => parseProvider(""), UnknownProviderError);
});

test("--provider beats the env var, which beats detection", () => {
  const env = { ...NOTHING, LEOPOLD_PROVIDER: "codex" };
  assert.equal(resolveProvider(["--provider", "claude"], env), "claude");
  assert.equal(resolveProvider([], env), "codex");
  assert.equal(resolveProvider(["run", "--worktree"], env), "codex");
});

test("a bad --provider value throws instead of silently picking a harness", () => {
  assert.throws(() => resolveProvider(["--provider", "gpt"], NOTHING), UnknownProviderError);
});

test("with nothing installed and nothing set, Leopold defaults to Claude Code", () => {
  // Claude Code is the only harness where every Leopold surface works (it has the
  // Stop hook), so it is the safe default when detection cannot decide.
  assert.equal(installedHarnesses(NOTHING).length, 0);
  assert.equal(resolveProvider([], NOTHING), "claude");
});

test("describeHarness reports presence, paths and hook support", () => {
  const env = { ...NOTHING, CODEX_HOME: "/tmp/cx" };
  const line = describeHarness("codex", env);
  assert.match(line, /Codex CLI/);
  assert.match(line, /\/tmp\/cx/);
  assert.match(line, /AGENTS\.md/);
  assert.match(line, /PreToolUse\(deny\)/);
  assert.match(line, /Stop\(block\)/);
  assert.match(line, /trust approval/);
  assert.match(line, /continuity=stop-hook/);
});
