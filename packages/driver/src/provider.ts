// The adaptive layer: what Leopold knows about each agent harness it can run on.
//
// Leopold's brief (.leopold/MISSION, CHARTER, GUARDRAILS, PLAN, DECISIONS, state.json)
// is already harness-neutral — it is plain markdown plus a JSON state file. Only three
// things actually differ between Claude Code and Codex:
//
//   1. WHERE the harness keeps skills, settings and project memory.
//   2. WHICH hook events it exposes (this decides how a run stays autonomous).
//   3. HOW a headless session is driven (Agent SDK vs `codex exec`).
//
// This table is the single source of truth for (1) and (2); providers/ implements (3).
// Everything else in the driver stays provider-agnostic on purpose.
//
// The hook facts below are not guesses — they were checked against a live Codex CLI
// 0.146.0, and the answer is that Codex reimplemented Claude Code's hook contract:
//   - PreToolUse arrives with the same keys (`tool_name` is literally "Bash",
//     `tool_input.command`, `cwd`, `transcript_path`, `hook_event_name`), and a
//     {"hookSpecificOutput":{"permissionDecision":"deny",…}} reply blocks the call —
//     verified by watching Leopold's unmodified guard stop a `git commit` in Codex.
//   - Stop arrives with `cwd`, `transcript_path` and `stop_hook_active`, and a
//     {"decision":"block","reason":…} reply puts the agent back to work — verified by
//     blocking one stop and watching the session continue.
// So both of Leopold's hooks run on either harness, unmodified. The remaining
// difference is procedural: Codex will not run a hook declared in config.toml until
// you have trusted it once, which is why headless workers pass the trust bypass.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export type ProviderId = "claude" | "codex";

/** Hook events Leopold depends on, and whether the harness actually exposes them. */
export interface HookSupport {
  /** PreToolUse can answer "deny" and stop the tool call. This is the git lock. */
  preToolUseDeny: boolean;
  /** A turn-end hook can answer {"decision":"block","reason":…} and push the agent
   *  back into the loop. This is what makes an in-session autonomous run possible. */
  stopBlock: boolean;
  /** UserPromptSubmit can inject context before the model sees the prompt (the
   *  prompt enhancer rides on this). */
  userPromptSubmit: boolean;
  sessionStart: boolean;
}

/** How an autonomous run keeps going after each turn. */
export type Continuity =
  /** The harness's own Stop hook blocks the halt and re-injects "continue". */
  | "stop-hook"
  /** No blocking turn-end hook: an outside process re-invokes the agent per item. */
  | "driver-loop";

export interface Harness {
  id: ProviderId;
  label: string;
  /** Executable that must be on PATH for this harness to be usable. */
  cli: string;
  /** Env var that relocates the harness home (respected by both CLIs). */
  homeEnv: string;
  /** Default harness home when homeEnv is unset. */
  defaultHome: string;
  /** Skills directory, relative to the harness home. */
  skillsSubdir: string;
  /** Settings file, relative to the harness home, and how to parse it. */
  settingsFile: string;
  settingsFormat: "json" | "toml";
  /** Where hooks are declared inside that settings file. */
  hooksKey: string;
  /** Per-project memory file the harness auto-loads. */
  memoryFile: string;
  /** Plugin manifest directory Leopold ships for this harness. */
  pluginDir: string;
  hooks: HookSupport;
  continuity: Continuity;
  /** True when a hook declared in the settings file stays inert until the user
   *  trusts it once. Headless sessions have nobody to click "trust", so the driver
   *  has to arm its own workers explicitly. */
  hookTrustGate: boolean;
  /** Human-readable note about anything Leopold has to work around here. */
  caveat?: string;
}

export const HARNESSES: Record<ProviderId, Harness> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    cli: "claude",
    homeEnv: "CLAUDE_HOME",
    defaultHome: join(homedir(), ".claude"),
    skillsSubdir: "skills",
    settingsFile: "settings.json",
    settingsFormat: "json",
    hooksKey: "hooks",
    memoryFile: "CLAUDE.md",
    pluginDir: ".claude-plugin",
    hooks: { preToolUseDeny: true, stopBlock: true, userPromptSubmit: true, sessionStart: true },
    continuity: "stop-hook",
    hookTrustGate: false,
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    cli: "codex",
    homeEnv: "CODEX_HOME",
    defaultHome: join(homedir(), ".codex"),
    skillsSubdir: "skills",
    settingsFile: "config.toml",
    settingsFormat: "toml",
    hooksKey: "hooks",
    memoryFile: "AGENTS.md",
    pluginDir: ".codex-plugin",
    hooks: { preToolUseDeny: true, stopBlock: true, userPromptSubmit: true, sessionStart: true },
    continuity: "stop-hook",
    hookTrustGate: true,
    caveat:
      "Codex holds a hook declared in config.toml untrusted until you approve it once — " +
      "open Codex and accept the Leopold hooks, or install Leopold as a Codex plugin, and " +
      "the git lock plus autonomous continuity are armed in interactive sessions. Headless " +
      "workers started by `leopold run --provider codex` arm themselves.",
  },
};

/** Absolute harness home, honoring CLAUDE_HOME / CODEX_HOME. */
export function harnessHome(id: ProviderId, env: NodeJS.ProcessEnv = process.env): string {
  const h = HARNESSES[id];
  return env[h.homeEnv] || h.defaultHome;
}

export function skillsDir(id: ProviderId, env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessHome(id, env), HARNESSES[id].skillsSubdir);
}

export function settingsPath(id: ProviderId, env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessHome(id, env), HARNESSES[id].settingsFile);
}

/** Is this harness's CLI on PATH? Pure PATH scan — no spawning, so it is cheap
 *  enough to call from `doctor`, the installer, and provider auto-detection. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return dirs.some((d) => exts.some((e) => existsSync(join(d, cmd + e.toLowerCase())) || existsSync(join(d, cmd + e))));
}

export function isInstalled(id: ProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  return onPath(HARNESSES[id].cli, env) || existsSync(harnessHome(id, env));
}

/** Every harness present on this machine, in preference order. */
export function installedHarnesses(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  return (Object.keys(HARNESSES) as ProviderId[]).filter((id) => isInstalled(id, env));
}

/**
 * The Leopold asset home: where the installer put the harness-neutral half of
 * Leopold (hooks, templates, docs, scripts, extensions).
 *
 * Same precedence as install.sh and scripts/leopold-doctor.sh, in this order:
 *   1. LEOPOLD_HOME wins outright.
 *   2. An existing <CLAUDE_HOME>/leopold — Claude Code stays the asset home
 *      wherever it is in play, so existing installs never need a migration.
 *   3. An existing <CODEX_HOME>/leopold — a Codex-only machine gets its own.
 *   4. Nothing installed yet: predict where install.sh would put it. Claude Code
 *      unless Codex is the only harness on the machine, which mirrors the
 *      installer's `auto` harness detection.
 *
 * The result is always absolute, and the path is NOT required to exist — callers
 * that need the assets check for themselves and say so, rather than degrading.
 *
 * The documented no-CLI shell fallback (docs/reference/leopold-home.md) resolves
 * identically; the test suite runs it against this function.
 */
export function leopoldHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LEOPOLD_HOME) return resolve(env.LEOPOLD_HOME);
  const claude = join(harnessHome("claude", env), "leopold");
  const codex = join(harnessHome("codex", env), "leopold");
  if (existsSync(claude)) return claude;
  if (existsSync(codex)) return codex;
  return isInstalled("claude", env) || !isInstalled("codex", env) ? claude : codex;
}

export class UnknownProviderError extends Error {}

/** Normalize a user-supplied provider name. Throws on anything unknown so a typo
 *  fails loudly instead of silently conducting the run on the wrong harness. */
export function parseProvider(raw: string): ProviderId {
  const v = raw.trim().toLowerCase();
  if (v === "claude" || v === "claude-code" || v === "anthropic") return "claude";
  if (v === "codex" || v === "openai") return "codex";
  throw new UnknownProviderError(
    `unknown provider "${raw}". Use one of: ${Object.keys(HARNESSES).join(", ")}.`,
  );
}

/**
 * Which harness should conduct this run.
 *
 * Precedence: `--provider X` > LEOPOLD_PROVIDER > whatever is installed > claude.
 * Claude stays the tie-break default because it is what Leopold is developed
 * against; both harnesses support every surface Leopold uses.
 */
export function resolveProvider(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): ProviderId {
  const i = argv.indexOf("--provider");
  const flag = i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  if (flag) return parseProvider(flag);
  if (env.LEOPOLD_PROVIDER) return parseProvider(env.LEOPOLD_PROVIDER);
  const installed = installedHarnesses(env);
  if (installed.length === 1) return installed[0];
  return "claude";
}

/** One-line capability summary per harness, for `leopold doctor` / `harness`. */
export function describeHarness(id: ProviderId, env: NodeJS.ProcessEnv = process.env): string {
  const h = HARNESSES[id];
  const have = isInstalled(id, env) ? "present" : "not found";
  const hooks = [
    h.hooks.preToolUseDeny ? "PreToolUse(deny)" : null,
    h.hooks.stopBlock ? "Stop(block)" : null,
    h.hooks.userPromptSubmit ? "UserPromptSubmit" : null,
    h.hooks.sessionStart ? "SessionStart" : null,
  ].filter(Boolean).join(" ");
  const trust = h.hookTrustGate ? " (hooks need one trust approval)" : "";
  return `${h.label} [${have}] home=${harnessHome(id, env)} memory=${h.memoryFile} hooks: ${hooks}${trust} continuity=${h.continuity}`;
}
