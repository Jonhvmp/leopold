// Unit tests for the adaptive harness layer: which harness a run is conducted on,
// and what Leopold is allowed to assume about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESSES, harnessHome, skillsDir, settingsPath, parseProvider, resolveProvider,
  installedHarnesses, describeHarness, leopoldHome, UnknownProviderError,
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

// ---------------------------------------------------------------------------
// The Leopold asset home: `leopold home`, and the shell fallback that has to
// agree with it. Skills and hooks run in shells that may not have the driver on
// PATH, so the documented one-liner is part of the product — it is extracted
// from the docs and executed here, not trusted.
// ---------------------------------------------------------------------------

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOME_DOC = join(REPO, "docs", "reference", "leopold-home.md");

/** The fallback snippet exactly as docs/reference/leopold-home.md publishes it. */
function documentedFallback(): string {
  const doc = readFileSync(HOME_DOC, "utf8");
  const marker = doc.indexOf("<!-- leopold-home:fallback -->");
  assert.ok(marker >= 0, "the fallback block must stay marked in the docs");
  const open = doc.indexOf("```sh", marker);
  const start = doc.indexOf("\n", open) + 1;
  const end = doc.indexOf("```", start);
  assert.ok(open >= 0 && end > start, "the marked fallback block must be a ```sh fence");
  return doc.slice(start, end);
}

/** Run the documented shell fallback under exactly this environment. The shell is
 *  spawned by absolute path so the test can hand it a PATH with no harness on it —
 *  the snippet's `command -v claude` has to see the same machine leopoldHome() does. */
function shellHome(env: NodeJS.ProcessEnv): string {
  return execFileSync("/bin/bash", ["-c", `${documentedFallback()}\nleopold_home`], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  }).trim();
}

/** Assert `leopold home` and the documented fallback agree, and return the path. */
function agreedHome(env: NodeJS.ProcessEnv): string {
  const fromDriver = leopoldHome(env);
  assert.equal(shellHome(env), fromDriver, "the documented shell fallback drifted from leopoldHome()");
  assert.ok(fromDriver.startsWith("/"), `expected an absolute path, got ${fromDriver}`);
  return fromDriver;
}

/** A temp harness layout. `dirs` are created; anything else stays absent. */
function layout(dirs: string[]): { root: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "leopold-home-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  return {
    root,
    env: {
      PATH: "/nonexistent-leopold-path",
      HOME: root,
      CLAUDE_HOME: join(root, ".claude"),
      CODEX_HOME: join(root, ".codex"),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("LEOPOLD_HOME wins outright, on either harness layout", () => {
  for (const dirs of [[".claude/leopold"], [".codex/leopold"], []]) {
    const { env, cleanup } = layout(dirs);
    try {
      assert.equal(agreedHome({ ...env, LEOPOLD_HOME: "/tmp/leo" }), "/tmp/leo");
    } finally {
      cleanup();
    }
  }
});

test("no override and $CLAUDE_HOME/leopold exists -> that path", () => {
  const { root, env, cleanup } = layout([".claude/leopold"]);
  try {
    assert.equal(agreedHome(env), join(root, ".claude/leopold"));
  } finally {
    cleanup();
  }
});

test("Claude Code keeps the asset home when both harnesses are installed", () => {
  // No migration for existing installs: a machine that grows a Codex install
  // must keep reading its hooks from where they already are.
  const { root, env, cleanup } = layout([".claude/leopold", ".codex/leopold"]);
  try {
    assert.equal(agreedHome(env), join(root, ".claude/leopold"));
  } finally {
    cleanup();
  }
});

test("no override and only $CODEX_HOME exists -> $CODEX_HOME/leopold", () => {
  // A Codex-only machine, before and after the installer has run.
  for (const dirs of [[".codex"], [".codex/leopold"]]) {
    const { root, env, cleanup } = layout(dirs);
    try {
      assert.equal(agreedHome(env), join(root, ".codex/leopold"));
    } finally {
      cleanup();
    }
  }
});

test("a bare machine predicts the Claude path, like install.sh --harness auto", () => {
  const { root, env, cleanup } = layout([]);
  try {
    assert.equal(agreedHome(env), join(root, ".claude/leopold"));
  } finally {
    cleanup();
  }
});

test("`leopold home` prints one absolute line and exits 0", () => {
  const { root, env, cleanup } = layout([".codex/leopold"]);
  const cli = join(REPO, "packages", "driver", "src", "index.ts");
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", cli, "home"], {
      env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    assert.equal(out, `${join(root, ".codex/leopold")}\n`);
  } finally {
    cleanup();
  }
});
