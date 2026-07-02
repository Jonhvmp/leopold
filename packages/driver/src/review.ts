// Review gate: an independent pass over an item's diff before it can close.
//
// The worker says "done" after build/lint/test — but nothing has *reviewed* the
// change. This spawns a fresh, read-only reviewer (its own Claude Code session,
// so it can invoke the native /code-review and /security-review skills) over the
// item's uncommitted diff. Blocking findings are handed back to the worker as the
// next instruction; clean diffs let the item finish. Critical items (per
// classify.ts) get a second independent reviewer and the union of their findings —
// the advisor analog, since the SDK has no advisor.

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

// Paths where a bug is a security incident, not just a defect.
const SENSITIVE = /(auth|login|session|password|credential|secret|token|oauth|jwt|crypto|encrypt|sign|security|permission|access|rbac|billing|payment|checkout|stripe|\.env)/i;

function reviewSystem(sensitive: boolean): string {
  return `You are a Leopold review gate: a strict, independent senior reviewer. You did NOT write this code. Review ONLY the current uncommitted diff and decide whether it is safe to close the work item.

Steps:
1. Run \`git --no-pager diff HEAD\` to see the change (and \`git --no-pager diff --stat HEAD\` for the file list). Read surrounding code with Read/Grep as needed.
2. If the /code-review skill is available, invoke it on the diff and fold its findings in. ${sensitive ? "This diff touches a security-sensitive area — also run /security-review (or apply that rigor): injection, authn/authz, secret handling, data exposure." : "Cover correctness bugs and obvious simplifications."}
3. Classify each finding's severity. "blocking" = a real correctness or security defect a maintainer would refuse to merge. "minor" = style/nit/suggestion. Be conservative: do not invent blockers; an empty blocking list is the right answer for a clean diff.

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

async function runOneReview(cfg: DriverConfig, brief: Brief, sensitive: boolean): Promise<ReviewResult> {
  const q = query({
    prompt: "Review the current uncommitted diff now and return the JSON verdict.",
    options: {
      cwd: brief.worktreeRoot ?? brief.root,
      systemPrompt: reviewSystem(sensitive),
      allowedTools: ["Bash", "Read", "Grep", "Glob", "Skill"],
      disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      settingSources: ["user", "project"],
      permissionMode: "default",
      maxTurns: 8,
      effort: sensitive ? "high" : "medium",
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

/** Review the item's diff. `secondOpinion` runs two independent reviewers in
 *  parallel and unions their blocking findings (used for critical items). */
export async function reviewItem(
  cfg: DriverConfig,
  brief: Brief,
  opts: { sensitive: boolean; secondOpinion: boolean },
): Promise<ReviewResult> {
  if (!opts.secondOpinion) return runOneReview(cfg, brief, opts.sensitive);

  const [a, b] = await Promise.all([
    runOneReview(cfg, brief, opts.sensitive),
    runOneReview(cfg, brief, opts.sensitive),
  ]);
  // Union blocking findings, de-duplicated by file+issue.
  const seen = new Set<string>();
  const blocking: ReviewFinding[] = [];
  for (const f of [...a.blocking, ...b.blocking]) {
    const key = `${f.file}::${f.issue}`.toLowerCase();
    if (!seen.has(key)) { seen.add(key); blocking.push(f); }
  }
  return {
    ok: blocking.length === 0,
    blocking,
    summary: [a.summary, b.summary].filter(Boolean).join(" | ").slice(0, 300),
  };
}
