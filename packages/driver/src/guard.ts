// The git lock, in driver form. Used as the worker's canUseTool callback so the
// same policy as the in-session hook holds when the worker runs under the SDK.
//
// Scope is deliberately narrow: the ONLY thing the driver locks is git commit and
// git push (force-push included). Everything else — rm, find, reset, edits — is the
// worker's call. The guard only ever adds denials for those two; it never loosens
// anything. Mirrors hooks/guard-irreversible.sh and is covered by test/guard.test.ts.

import fs from "node:fs";
import path from "node:path";

interface Allow { behavior: "allow"; updatedInput: Record<string, unknown>; }
interface Deny { behavior: "deny"; message: string; }
export type PermissionResult = Allow | Deny;

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

    if (toolName === "Bash") {
      const c = norm(String((input as { command?: unknown }).command ?? ""));

      switch (gitSubcommand(c)) {
        case "push":
          if (/(--force|--force-with-lease|(^|\s)-f(\s|$))/.test(c))
            return deny("Leopold guard: force-push is forbidden in autonomous mode.");
          if (!hasToken(leoDir, "ALLOW_PUSH"))
            return deny("Leopold guard: git push is locked. Report readiness instead. (touch .leopold/ALLOW_PUSH to allow pushing this run.)");
          break;
        case "commit":
          if (!hasToken(leoDir, "ALLOW_GIT"))
            return deny("Leopold guard: git commit is locked. Stage and report; the user commits. (touch .leopold/ALLOW_GIT to allow commits this run.)");
          break;
      }
    }

    return { behavior: "allow", updatedInput: input };
  };
}
