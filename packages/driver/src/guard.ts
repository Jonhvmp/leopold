// The git lock, in driver form. Used as the worker's canUseTool callback so the
// same policy as the in-session hook holds when the worker runs under the SDK.
// It only adds denials; it never loosens anything.

import fs from "node:fs";
import path from "node:path";

interface Allow { behavior: "allow"; updatedInput: Record<string, unknown>; }
interface Deny { behavior: "deny"; message: string; }
export type PermissionResult = Allow | Deny;

const DESTRUCTIVE_RM = /rm\s+-[a-z]*(rf|fr)/i;
const DESTRUCTIVE_GIT = /git\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)/;
const FORCE_PUSH = /git\s+push\s+.*(--force|--force-with-lease|-f(\s|$))/;
const GIT_COMMIT = /git\s+(-[^\s]+\s+)*commit/;
const GIT_PUSH = /git\s+push/;
const GH_PR = /gh\s+(pr\s+(create|merge)|release\s+create)/;
const PUBLISH = /(npm|pnpm|yarn)\s+publish|cargo\s+publish|twine\s+upload|pip\s+.*upload/;
const PROTECTED_PATH = /(GUARDRAILS\.md|settings\.json|settings\.local\.json|leopold\/hooks\/)/;

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
      const cmd = String((input as { command?: unknown }).command ?? "");
      if (DESTRUCTIVE_RM.test(cmd))
        return deny("Leopold guard: 'rm -rf' style deletion is forbidden in autonomous mode.");
      if (DESTRUCTIVE_GIT.test(cmd))
        return deny("Leopold guard: destructive git op (reset --hard / clean -f / branch -D) is forbidden.");
      if (FORCE_PUSH.test(cmd))
        return deny("Leopold guard: force-push is forbidden in autonomous mode.");
      if (GIT_COMMIT.test(cmd) && !hasToken(leoDir, "ALLOW_GIT"))
        return deny("Leopold guard: git commit is locked. Stage and report; the user commits. (touch .leopold/ALLOW_GIT to allow commits this run.)");
      if (GIT_PUSH.test(cmd) && !hasToken(leoDir, "ALLOW_PUSH"))
        return deny("Leopold guard: git push is locked. Report readiness instead.");
      if (GH_PR.test(cmd) && !hasToken(leoDir, "ALLOW_PUSH"))
        return deny("Leopold guard: opening or merging PRs and creating releases is locked.");
      if (PUBLISH.test(cmd) && !hasToken(leoDir, "ALLOW_PUBLISH"))
        return deny("Leopold guard: publishing packages is locked in autonomous mode.");
    }

    if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      const p = String((input as { file_path?: unknown; path?: unknown }).file_path ?? (input as { path?: unknown }).path ?? "");
      if (PROTECTED_PATH.test(p))
        return deny("Leopold guard: editing guardrails, settings, or hooks is forbidden in autonomous mode.");
    }

    return { behavior: "allow", updatedInput: input };
  };
}
