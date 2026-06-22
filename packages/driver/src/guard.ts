// The git lock, in driver form. Used as the worker's canUseTool callback so the
// same policy as the in-session hook holds when the worker runs under the SDK.
// It only adds denials; it never loosens anything. Detection mirrors the hardened
// bash guard (hooks/guard-irreversible.sh) and is covered by test/guard.test.ts.

import fs from "node:fs";
import path from "node:path";

interface Allow { behavior: "allow"; updatedInput: Record<string, unknown>; }
interface Deny { behavior: "deny"; message: string; }
export type PermissionResult = Allow | Deny;

const GH_PR = /(^|[^\w-])gh(\s.*)?\s(pr\s+(create|merge)|release\s+create)/i;
const PUBLISH = /(npm|pnpm|yarn)\s+publish|cargo\s+publish|twine\s+upload|pip\s+.*upload/i;
const PROTECTED_PATH = /(GUARDRAILS\.md|settings\.json|settings\.local\.json|leopold\/hooks\/|\.leopold\/state\.json|secrets\.key|secrets\.env)/;
// The secret vault (.leopold/secrets.env) and master key (~/.claude/leopold/secrets.key)
// are off-limits to the worker — secrets reach it only as $NAME env vars.
const SECRET_FILE = /secrets\.key|secrets\.env/;

// git global options that consume the following token as their value.
const GIT_VALUE_OPTS = new Set([
  "-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env",
]);

/** Collapse whitespace so tab/space evasion does not change matching. */
function norm(s: string): string {
  return s.replace(/[\t\n]+/g, " ").replace(/ +/g, " ").trim();
}

/** Resolve the git subcommand, skipping global options + their values, by basename. */
export function gitSubcommand(cmd: string): string {
  const toks = norm(cmd).split(" ");
  let i = toks.findIndex((t) => t.split("/").pop() === "git");
  if (i === -1) return "";
  i += 1;
  while (i < toks.length) {
    const t = toks[i];
    if (GIT_VALUE_OPTS.has(t)) { i += 2; continue; }
    if (t.startsWith("-")) { i += 1; continue; }
    return t;
  }
  return "";
}

/** Recursive AND forced rm, in any spelling (--recursive --force, -r -f, -rf, /bin/rm -rf). */
export function isRecursiveForceRm(cmd: string): boolean {
  const c = norm(cmd);
  if (!/(^|[^\w-])rm(\s|$)/i.test(c)) return false;
  const recursive = /(--recursive|(^|\s)-[a-z]*r)/i.test(c);
  const force = /(--force|(^|\s)-[a-z]*f)/i.test(c);
  return recursive && force;
}

/** find ... -delete or find ... -exec rm. */
export function isFindDelete(cmd: string): boolean {
  const c = norm(cmd);
  if (!/(^|[^\w-])find(\s|$)/i.test(c)) return false;
  return /\s-delete(\s|$)/i.test(c) || /-exec\s+rm(\s|$)/i.test(c);
}

function hasToken(leoDir: string, name: string): boolean {
  return fs.existsSync(path.join(leoDir, name));
}

export function makeGuard(
  leoDir: string,
  onBlock: (tool: string, reason: string) => void,
) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const deny = (message: string): Deny => {
      onBlock(toolName, message);
      return { behavior: "deny", message };
    };

    if (toolName === "Read") {
      const p = String((input as { file_path?: unknown }).file_path ?? "");
      if (SECRET_FILE.test(p))
        return deny("Leopold guard: reading the secret vault or master key is forbidden. Secrets are pre-loaded as $NAME env vars.");
    }

    if (toolName === "Bash") {
      const c = norm(String((input as { command?: unknown }).command ?? ""));

      if (SECRET_FILE.test(c))
        return deny("Leopold guard: touching the secret vault/key via shell is forbidden. Secrets are pre-loaded as $NAME env vars.");
      if (isRecursiveForceRm(c))
        return deny("Leopold guard: recursive+forced rm is forbidden in autonomous mode.");
      if (isFindDelete(c))
        return deny("Leopold guard: 'find -delete' / 'find -exec rm' is forbidden in autonomous mode.");

      switch (gitSubcommand(c)) {
        case "reset":
          if (/(^|\s)--hard(\s|$)/.test(c))
            return deny("Leopold guard: 'git reset --hard' is forbidden in autonomous mode.");
          break;
        case "clean":
          if (/(--force|(^|\s)-[a-z]*f)/i.test(c))
            return deny("Leopold guard: 'git clean -f' is forbidden in autonomous mode.");
          break;
        case "branch":
          if (/(^|\s)-D(\s|$)/.test(c))
            return deny("Leopold guard: 'git branch -D' is forbidden in autonomous mode.");
          break;
        case "push":
          if (/(--force|--force-with-lease|(^|\s)-f(\s|$))/.test(c))
            return deny("Leopold guard: force-push is forbidden in autonomous mode.");
          if (!hasToken(leoDir, "ALLOW_PUSH"))
            return deny("Leopold guard: git push is locked. Report readiness instead.");
          break;
        case "commit":
          if (!hasToken(leoDir, "ALLOW_GIT"))
            return deny("Leopold guard: git commit is locked. Stage and report; the user commits. (touch .leopold/ALLOW_GIT to allow commits this run.)");
          break;
      }

      if (GH_PR.test(c) && !hasToken(leoDir, "ALLOW_PUSH"))
        return deny("Leopold guard: opening or merging PRs and creating releases is locked.");
      if (PUBLISH.test(c) && !hasToken(leoDir, "ALLOW_PUBLISH"))
        return deny("Leopold guard: publishing packages is locked in autonomous mode.");
    }

    if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      const p = String((input as { file_path?: unknown; path?: unknown }).file_path ?? (input as { path?: unknown }).path ?? "");
      if (PROTECTED_PATH.test(p))
        return deny("Leopold guard: editing guardrails, settings, hooks, or run state is forbidden in autonomous mode.");
    }

    return { behavior: "allow", updatedInput: input };
  };
}
