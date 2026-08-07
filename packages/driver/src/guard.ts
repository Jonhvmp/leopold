// The git lock, in driver form. Used as the worker's canUseTool callback so the
// same policy as the in-session hook holds when the worker runs under the SDK.
//
// Scope is deliberately narrow: the ONLY thing the driver locks for a work node is
// git commit and git push (force-push included). Everything else — rm, find, reset,
// edits — is the worker's call. The guard only ever adds denials; it never loosens
// anything. Mirrors hooks/guard-irreversible.sh and is covered by test/guard.test.ts.
//
// One exception, opt-in per session: `readOnly` (a `@gate` / `@verify` / `@feedback`
// node) also denies every editing tool, so the node judging a diff cannot write to it —
// AND denies a shell command that writes under the run's own `.leopold/`. Without that
// second half the first is theatre: a feedback node's bounds (at most 3 added items,
// never delete, never touch a done item, never edit GUARDRAILS) are enforced on the
// PROPOSAL channel, so a node that can reach PLAN.md or GUARDRAILS.md through `sed -i`
// simply walks around all of them — and `.leopold/` is gitignored, so the tree-signature
// receipt never sees it. The bounds are enforced in code or they are not enforced.

import fs from "node:fs";
import path from "node:path";
import { EDIT_TOOLS } from "./kinds.js";

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

// --- the read-only node's brief lock ----------------------------------------------

/** The brief files, by basename. A read-only node may READ every one of them (a
 *  feedback node's whole job is reading `.leopold/`), and may write none. Matching on
 *  the basename as well as on the `.leopold/` path over-matches on purpose: a
 *  read-only node has no business writing ANY file with these names, anywhere. */
const BRIEF_BASENAMES = new Set([
  "PLAN.md", "GUARDRAILS.md", "MISSION.md", "CHARTER.md", "DECISIONS.md",
  "state.json", "events.jsonl", "STOP", "ALLOW_GIT", "ALLOW_PUSH",
]);

/** Utilities that write wherever they are pointed. */
const WRITE_CMDS = new Set([
  "tee", "cp", "mv", "rm", "rmdir", "ln", "install", "truncate", "dd", "touch",
  "mkdir", "patch", "ed", "ex", "sponge", "shred", "chmod", "chown", "mktemp",
]);

/** Utilities that write only in place, and only when told to (`sed -i`, `perl -pi`). */
const INPLACE_CMDS = new Set(["sed", "perl", "ruby"]);

/** `find` walks and reads, until one of these predicates turns it into a writer (or into
 *  a launcher for something the driver cannot read). */
const FIND_ACTIONS = /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(\s|$)/;

/** Anything that runs a program we cannot read. When one of these is pointed at a
 *  protected path we refuse rather than guess at the embedded script — a loud refusal
 *  the node can work around by reading the file directly beats a silent bypass. */
const INTERPRETERS = new Set([
  "python", "python2", "python3", "perl", "ruby", "node", "php", "bash", "sh", "zsh", "ksh", "dash", "env", "eval", "xargs",
]);

/** Strip a leading `opt=` and surrounding quotes/punctuation off a shell token. */
function bare(token: string): string {
  return token.replace(/^[^=\s]*=/, "").replace(/^['"`]+/, "").replace(/['"`,;)}\]]+$/, "");
}

// --- globs -------------------------------------------------------------------------
// A literal match alone is a one-character lock: the SHELL expands `.leo*/PLAN*` to the
// real `.leopold/PLAN.md` before the command ever runs, and the token the driver sees
// contains neither the string ".leopold" nor the basename "PLAN.md". So a wildcard token
// is matched by what it COULD EXPAND TO, not by its letters: the pattern is compiled to
// a regex and asked whether any brief path answers it. Over-matching is the intended
// direction — `rm -rf build/*` is refused to a read-only node because `*` could name a
// brief file, and a loud refusal it can rewrite (`rm -rf build`) beats a silent bypass.

/** What a shell EXPANDS. `*`, `?` and `[...]` are wildcards; a brace group only expands
 *  when it holds an alternation or a range, so a bare `{}` (find's placeholder) is not
 *  one and does not drag every `-exec` into the lock. */
const WILDCARD = /[*?[]/;
const BRACE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
const hasGlob = (s: string): boolean => WILDCARD.test(s) || BRACE.test(s);

/** Strip what a shell strips off a token, WITHOUT eating a glob's own punctuation —
 *  `bare()` drops a trailing `]`, which is exactly the character `.leopol[d]` needs. */
function bareGlob(token: string): string {
  return token.replace(/^[^=\s]*=/, "").replace(/^['"`]+/, "").replace(/['"`,;)]+$/, "");
}

/** Compile ONE path segment of a shell glob into a regex over the names it can match.
 *  `*` and `?` never cross a `/`; a `[...]` class is one character; an expanding brace
 *  group is widened to "anything", which can only ever over-match — the safe direction. */
function segmentToRegex(seg: string): RegExp {
  let out = "";
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i];
    if (ch === "*") { out += "[^/]*"; continue; }
    if (ch === "?") { out += "[^/]"; continue; }
    if (ch === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end > i) { out += "[^/]"; i = end; continue; }
    }
    if (ch === "{") {
      const end = seg.indexOf("}", i + 1);
      if (end > i && /,|\.\./.test(seg.slice(i + 1, end))) { out += "[^/]*"; i = end; continue; }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Could this glob segment expand to `name`? Honors the one shell rule that keeps this
 *  from refusing everything: a leading wildcard does not match a dotfile, so `*` alone
 *  is not a way to name `.leopold`. */
function segmentMatches(seg: string, name: string): boolean {
  if (name.startsWith(".") && WILDCARD.test(seg[0] ?? "")) return false;
  try { return segmentToRegex(seg).test(name); } catch { return true; }
}

/** Could this wildcard token expand onto a brief file — either through a directory
 *  segment that can name `.leopold`, or through a final segment that can name one of
 *  the brief's own filenames (the same deliberate over-match the literal rule makes)? */
function globCouldHitBrief(token: string): boolean {
  if (!hasGlob(token)) return false;
  for (const piece of bareGlob(token).split(/[^\w./\\*?[\]{},!^~-]+/)) {
    if (!piece || !hasGlob(piece)) continue;
    const segs = piece.split(/[/\\]/).filter(Boolean);
    for (let i = 0; i < segs.length; i += 1) {
      if (segmentMatches(segs[i], ".leopold")) return true;
      if (i === segs.length - 1) {
        for (const name of BRIEF_BASENAMES) if (segmentMatches(segs[i], name)) return true;
      }
    }
  }
  return false;
}

/** Does this token name a file the brief owns — anything under a `.leopold/`, or one of
 *  the brief's own filenames? Matched INSIDE the token, not just as the whole of it, so
 *  a path buried in a one-liner (`python -c "open('.leopold/PLAN.md','a')"`) counts —
 *  and matched through a wildcard as well as literally, so a glob the shell expands onto
 *  a brief file counts too, whatever its letters spell. */
function isProtectedPath(token: string): boolean {
  if (token.includes(".leopold")) return true;
  for (const piece of token.split(/[^\w./\\-]+/)) {
    if (piece && BRIEF_BASENAMES.has(piece.split(/[/\\]/).pop() ?? "")) return true;
  }
  return globCouldHitBrief(token);
}

/** Split a command into tokens with redirections and separators padded out, so `>file`
 *  and `2>>file` put their TARGET in a token of its own. */
function tokenize(cmd: string): string[] {
  return norm(cmd)
    .replace(/(\d*&?>>?|<)/g, " $1 ")
    .replace(/([;|]+)/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

/** The command word a token names, ignoring its path (`/usr/bin/sed` -> `sed`). */
function cmdName(token: string): string {
  return bare(token).split("/").pop() ?? "";
}

/** Why this shell command is refused to a READ-ONLY node, or null when it may run.
 *  Only ever asked about a `@gate` / `@verify` / `@feedback` session: a work node's
 *  shell is untouched by this, so no plan written before node kinds existed can hit it.
 *
 *  Reads are the point and stay allowed — `cat .leopold/events.jsonl`, `jq . state.json`,
 *  `grep`, `wc`, `git diff`. What is refused is a WRITE aimed at the brief: a redirect
 *  onto one of its files, an in-place editor, a copy/move/remove/touch, or an
 *  interpreter we cannot read that mentions one. */
export function briefWriteDenial(command: string): string | null {
  const toks = tokenize(command);
  const target = toks.find(isProtectedPath);
  if (!target) return null; // the brief is not mentioned at all — nothing to protect

  const refuse = (what: string): string =>
    `Leopold guard: this is a read-only node — ${what} is denied. ${bare(target)} belongs to the human and the driver: ` +
    `the plan is amended only through a \`leopold-amend\` block (the driver applies what clears the bounds), and GUARDRAILS.md is never amended by a run. Read it all you like; write nothing.`;

  for (let i = 0; i < toks.length; i += 1) {
    if (/^\d*&?>>?$/.test(toks[i]) && toks[i + 1] && isProtectedPath(toks[i + 1])) {
      return refuse(`redirecting output into ${bare(toks[i + 1])}`);
    }
  }
  for (const t of toks) {
    const name = cmdName(t);
    if (WRITE_CMDS.has(name)) return refuse(`\`${name}\` on a brief file`);
    if (name === "find" && FIND_ACTIONS.test(` ${toks.join(" ")} `)) {
      return refuse("`find` acting on a brief file (-delete / -exec is a write, whatever it runs)");
    }
    if (INPLACE_CMDS.has(name) && toks.some((o) => /^-{1,2}[a-zA-Z]*i/.test(o))) {
      return refuse(`\`${name}\` editing a brief file in place`);
    }
    if (INTERPRETERS.has(name)) {
      return refuse(`running \`${name}\` against a brief file (the driver cannot read what the script does)`);
    }
  }
  return null;
}

/** Why this shell command is locked, or null when it may run. ONE writer for the git
 *  lock: the worker's canUseTool below and the driver's own `@tool` node executor both
 *  ask this, so a command the guard refuses in a worker session cannot slip through by
 *  being written into a plan item instead.
 *
 *  `opts.readOnly` adds the brief lock on top of the git lock, and nothing else: with it
 *  absent — every work node, every `@tool` node, every plan that predates node kinds —
 *  the answer is byte-for-byte what it was before read-only nodes existed. */
export function bashDenial(leoDir: string, command: string, opts: GuardOpts = {}): string | null {
  const c = norm(command);
  if (opts.readOnly) {
    const brief = briefWriteDenial(c);
    if (brief) return brief;
  }
  switch (gitSubcommand(c)) {
    case "push":
      if (/(--force|--force-with-lease|(^|\s)-f(\s|$))/.test(c))
        return "Leopold guard: force-push is forbidden in autonomous mode.";
      if (!hasToken(leoDir, "ALLOW_PUSH"))
        return "Leopold guard: git push is locked. Report readiness instead. (touch .leopold/ALLOW_PUSH to allow pushing this run.)";
      return null;
    case "commit":
      if (!hasToken(leoDir, "ALLOW_GIT"))
        return "Leopold guard: git commit is locked. Stage and report; the user commits. (touch .leopold/ALLOW_GIT to allow commits this run.)";
      return null;
    default:
      return null;
  }
}

export interface GuardOpts {
  /** A read-only node (`@gate` / `@verify` / `@feedback`): every editing tool is denied,
   *  so the node that judges a diff structurally cannot become the node that writes it —
   *  and its shell may not write under the run's own `.leopold/`, so it cannot reach the
   *  brief through the one tool it still has. */
  readOnly?: boolean;
}

export function makeGuard(
  leoDir: string,
  onBlock: (tool: string, reason: string) => void,
  opts: GuardOpts = {},
) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const deny = (message: string): Deny => {
      onBlock(toolName, message);
      return { behavior: "deny", message };
    };

    if (opts.readOnly && (EDIT_TOOLS as readonly string[]).includes(toolName)) {
      return deny(`Leopold guard: this is a review-only node — ${toolName} is denied. Report what you found instead of fixing it.`);
    }

    if (toolName === "Bash") {
      const reason = bashDenial(leoDir, String((input as { command?: unknown }).command ?? ""), opts);
      if (reason) return deny(reason);
    }

    return { behavior: "allow", updatedInput: input };
  };
}
