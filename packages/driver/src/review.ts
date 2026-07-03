// Review gate: an independent adversarial pass over an item's diff before it can close.
//
// The worker says "done" after build/lint/test — but nothing has *reviewed* the
// change, and a single reviewer shares one failure mode with the worker: it can be
// plausible-and-wrong in the same direction. So the gate is a PANEL of skeptics,
// each with a DISTINCT lens and its own clean context (a fresh Claude Code session,
// so it can invoke the native /code-review and /security-review skills):
//
//   ordinary item   -> correctness
//   sensitive diff  -> correctness + security
//   critical item   -> correctness + security + does-it-actually-work
//
// Diversity beats redundancy: three identical reviewers re-find the same bugs;
// three different lenses catch failure modes the others structurally miss. Blocking
// findings are unioned (deduped) and handed back to the worker as the next
// instruction; a clean panel lets the item finish. Unparseable verdicts fail closed.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Brief, DriverConfig } from "./types.js";

export interface ReviewFinding {
  file: string;
  issue: string;
  severity: "blocking" | "minor";
}
export interface ReviewResult {
  ok: boolean;
  blocking: ReviewFinding[];
  summary: string;
}

export type ReviewLens = "correctness" | "security" | "does-it-work";

// Paths where a bug is a security incident, not just a defect.
const SENSITIVE = /(auth|login|session|password|credential|secret|token|oauth|jwt|crypto|encrypt|sign|security|permission|access|rbac|billing|payment|checkout|stripe|\.env)/i;

/** Which skeptics an item faces. Pure and unit-testable. */
export function lensesFor(opts: { sensitive: boolean; critical: boolean }): ReviewLens[] {
  if (opts.critical) return ["correctness", "security", "does-it-work"];
  if (opts.sensitive) return ["correctness", "security"];
  return ["correctness"];
}

const LENS_FOCUS: Record<ReviewLens, string> = {
  correctness:
    "Your lens is CORRECTNESS: logic bugs, broken edge cases, unhandled errors, off-by-one, wrong assumptions about inputs or state, regressions in behavior the surrounding code depends on. If the /code-review skill is available, invoke it on the diff and fold its findings in.",
  security:
    "Your lens is SECURITY: injection, authn/authz gaps, secret handling, data exposure, unsafe defaults, trust-boundary mistakes. If the /security-review skill is available, invoke it; otherwise apply that rigor yourself.",
  "does-it-work":
    "Your lens is DOES-IT-ACTUALLY-WORK: was the change genuinely verified, or only claimed? Check that the build/tests the item needed would actually pass (run them read-only if cheap), that new code is actually wired in and reachable, and that nothing was left a stub or placeholder.",
};

function reviewSystem(lens: ReviewLens): string {
  return `You are a Leopold review gate: a strict, independent senior reviewer on a panel of skeptics. You did NOT write this code. Review ONLY the current uncommitted diff and decide whether it is safe to close the work item.

Steps:
1. Run \`git --no-pager diff HEAD\` to see the change (and \`git --no-pager diff --stat HEAD\` for the file list). Read surrounding code with Read/Grep as needed.
2. ${LENS_FOCUS[lens]}
3. Classify each finding's severity. "blocking" = a real defect a maintainer would refuse to merge. "minor" = style/nit/suggestion. Be conservative: do not invent blockers; an empty blocking list is the right answer for a clean diff. Stay inside your lens — another panelist covers the rest.

You may read and run read-only shell commands. Do NOT edit files, commit, or push.

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"ok": true|false, "blocking": [{"file":"...","issue":"...","severity":"blocking"}], "summary":"one line"}
ok is true iff blocking is empty.`;
}

export function parseReview(text: string): ReviewResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const o = JSON.parse(raw) as Partial<ReviewResult>;
    const blocking: ReviewFinding[] = Array.isArray(o.blocking)
      ? o.blocking
        .filter((f): f is ReviewFinding => !!f && typeof f.issue === "string")
        .map((f): ReviewFinding => ({
          file: String(f.file ?? "?"),
          issue: String(f.issue),
          severity: f.severity === "blocking" ? "blocking" : "minor",
        }))
        .filter((f) => f.severity === "blocking")
      : [];
    return { ok: blocking.length === 0, blocking, summary: String(o.summary ?? "").slice(0, 300) };
  } catch {
    // A reviewer that produced no parseable verdict must not silently pass the gate.
    return { ok: false, blocking: [{ file: "?", issue: "reviewer returned no parseable verdict", severity: "blocking" }], summary: "unparseable review" };
  }
}

async function runOneReview(cfg: DriverConfig, brief: Brief, lens: ReviewLens, deepEffort: boolean): Promise<ReviewResult> {
  const q = query({
    prompt: "Review the current uncommitted diff now and return the JSON verdict.",
    options: {
      cwd: brief.worktreeRoot ?? brief.root,
      systemPrompt: reviewSystem(lens),
      allowedTools: ["Bash", "Read", "Grep", "Glob", "Skill"],
      disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      settingSources: ["user", "project"],
      permissionMode: "default",
      maxTurns: 8,
      effort: deepEffort ? "high" : "medium",
      ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
    } as never,
  });
  let text = "";
  for await (const msg of q as AsyncIterable<{ type: string; message?: { content?: Array<{ type: string; text?: string }> }; result?: string }>) {
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
    } else if (msg.type === "result") {
      if (!text && typeof msg.result === "string") text = msg.result;
    }
  }
  return parseReview(text);
}

/** Detect whether the item's diff touches security-sensitive paths. */
export function diffIsSensitive(diffStat: string): boolean {
  return SENSITIVE.test(diffStat);
}

/** Union N panel verdicts: blocking findings deduped by file+issue. Pure. */
export function unionReviews(results: ReviewResult[]): ReviewResult {
  const seen = new Set<string>();
  const blocking: ReviewFinding[] = [];
  for (const r of results) {
    for (const f of r.blocking) {
      const key = `${f.file}::${f.issue}`.toLowerCase();
      if (!seen.has(key)) { seen.add(key); blocking.push(f); }
    }
  }
  return {
    ok: blocking.length === 0,
    blocking,
    summary: results.map((r) => r.summary).filter(Boolean).join(" | ").slice(0, 300),
  };
}

/** Review the item's diff with a diverse-lens panel of independent skeptics. */
export async function reviewItem(
  cfg: DriverConfig,
  brief: Brief,
  opts: { sensitive: boolean; critical: boolean },
): Promise<ReviewResult> {
  const lenses = lensesFor(opts);
  const deep = opts.sensitive || opts.critical;
  const results = await Promise.all(lenses.map((lens) => runOneReview(cfg, brief, lens, deep)));
  return unionReviews(results);
}
