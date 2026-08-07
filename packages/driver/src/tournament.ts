// Best-of-k tournament for a hard/critical item (R3).
//
// Ed's point on RLHF flattening creativity: for a hard problem, generate several
// independent attempts and keep the best, rather than iterating one. This module
// fans out K attempts of a single plan item — each in its own worktree off HEAD, so
// they cannot see or clobber each other — judges every attempt's diff against the
// item (and its @scenario acceptance lines), and returns the winner's diff for the
// caller to stage. Opt-in and off by default (it costs K× a normal attempt).
//
// The attempt runner is injected so this module stays decoupled from the loop (no
// circular import): the loop passes a closure that runs its normal per-item engine
// in the given worktree. Everything here is orchestration + a PURE winner pick.

import { query } from "./sdk.js";
import { createWorktree, type Worktree } from "./worktree.js";
import { applyStaged, snapshotTree, git } from "./git.js";
import { logEvent } from "./log.js";
import type { Brief, DriverConfig } from "./types.js";

/** One tournament attempt: the diff it produced and whether it reported success. */
export interface Attempt {
  index: number;
  ok: boolean;      // the attempt's engine reported done + review clean
  patch: string;    // its diff vs the shared base (empty if it changed nothing)
  detail: string;   // last status summary (for logging / the judge)
}
export interface Judged extends Attempt {
  score: number;    // 0-10, a judge's rating (meaningful only when ok)
  why: string;
}

/** The runner the loop injects: run ONE attempt of the item in `cwd`, returning
 *  whether it succeeded and its last status detail. The patch is captured here. */
export type RunAttempt = (cwd: string, index: number) => Promise<{ ok: boolean; detail: string }>;

/** Scores one attempt's diff (present in `cwd`) 0-10. Injectable so the whole
 *  tournament orchestration is integration-testable without the SDK; defaults to
 *  the real LLM judge. */
export type Judge = (cwd: string, index: number) => Promise<{ score: number; why: string }>;

/** Pick the winning attempt's index: the highest score among attempts that both
 *  succeeded AND produced a non-empty diff. Ties resolve to the lowest index
 *  (stable, deterministic). Returns -1 when no attempt qualifies. Pure — this is
 *  the heart of best-of-k and is unit-tested directly. */
export function pickWinner(judged: Judged[]): number {
  let winner = -1;
  let best = -Infinity;
  for (const j of judged) {
    if (!j.ok || !j.patch.trim()) continue;
    if (j.score > best) { best = j.score; winner = j.index; }
  }
  return winner;
}

function judgeSystem(item: string, scenarios: string[]): string {
  const scen = scenarios.length
    ? `\n\nThe item's acceptance scenarios (a strong attempt satisfies EVERY one):\n` +
      scenarios.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
    : "";
  return `You are a judge on a Leopold best-of-k tournament. Several engineers independently implemented the SAME plan item; you are scoring ONE attempt's diff in isolation. Rate how completely and correctly it delivers the item's intended behavior — wiring actually done, edge cases handled, no stubs/placeholders, and (if scenarios are given) every scenario satisfied. Simpler is better when correctness is equal. You are NOT comparing to the others; score this one on its own merits.

The plan item:
  ${item}${scen}

Read the diff read-only (\`git --no-pager diff HEAD\`) and the surrounding code as needed. Do NOT edit, commit, or push.

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"score": 0-10, "why": "one line"}`;
}

export function parseScore(text: string): { score: number; why: string } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const o = JSON.parse(raw) as { score?: unknown; why?: unknown };
    const n = Number(o.score);
    // An unparseable / out-of-range score fails LOW so a dubious attempt can't win.
    return { score: Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0, why: String(o.why ?? "").slice(0, 200) };
  } catch {
    return { score: 0, why: "unparseable judge verdict" };
  }
}

async function judgeAttempt(cfg: DriverConfig, cwd: string, item: string, scenarios: string[]): Promise<{ score: number; why: string }> {
  const q = query({
    prompt: "Judge the current diff now and return the JSON score.",
    options: {
      cwd,
      leopoldRole: "review",
      systemPrompt: judgeSystem(item, scenarios),
      allowedTools: ["Bash", "Read", "Grep", "Glob"],
      disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      settingSources: ["user", "project"],
      permissionMode: "default",
      maxTurns: 6,
      effort: "medium",
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
  return parseScore(text);
}

/** Force-remove a throwaway tournament worktree even if dirty — the winner's patch
 *  is already captured, so losing attempts are pure waste to keep. */
function scrap(baseRoot: string, wt: Worktree | null, leoDir: string): void {
  if (!wt) return;
  git(baseRoot, ["worktree", "remove", "--force", wt.path]);
  git(baseRoot, ["branch", "-D", wt.branch]);
  logEvent(leoDir, { event: "tournament_worktree_scrapped", path: wt.path });
}

export interface TournamentResult {
  /** Winning attempt's diff to stage onto the caller's tree, or null if none won. */
  patch: string | null;
  winner: number;      // winning attempt index, or -1
  attempts: number;    // how many attempts actually ran
  scores: number[];    // each attempt's score, by index (for logging)
}

/** Run a best-of-k tournament for one item: fan out K isolated attempts, judge each
 *  in place, and return the winner's diff. Returns patch=null when no attempt
 *  qualifies (the caller then falls back to its single-attempt path). Each attempt
 *  runs in a throwaway worktree off HEAD; nothing is ever committed or pushed. */
export async function runTournament(
  cfg: DriverConfig,
  brief: Brief,
  item: string,
  scenarios: string[],
  k: number,
  baseRoot: string,
  runAttempt: RunAttempt,
  basePatch = "",
  judge?: Judge,
): Promise<TournamentResult> {
  const K = Math.max(2, Math.min(k, 6)); // sane bounds; best-of-1 is not a tournament
  const judgeFn: Judge = judge ?? ((cwd) => judgeAttempt(cfg, cwd, item, scenarios));
  logEvent(brief.leoDir, { event: "tournament_start", item, k: K });

  const judged: Judged[] = await Promise.all(
    Array.from({ length: K }, async (_, index): Promise<Judged> => {
      const wt = createWorktree(baseRoot, brief.leoDir, `bok${index}`);
      const cwd = wt?.path ?? baseRoot;
      try {
        // Seed the attempt with the caller's current uncommitted state (prior items'
        // work) so each attempt starts where the real run is, not a bare HEAD. The
        // captured patch is still vs HEAD, so it carries that seed forward.
        if (basePatch.trim()) applyStaged(cwd, basePatch);
        const { ok, detail } = await runAttempt(cwd, index);
        // Capture the FULL diff incl. untracked new files (git diff HEAD alone would
        // miss any file the attempt created — which is most real work). snapshotTree
        // stages -A then diffs vs HEAD; the worktree forks off HEAD, so this is the
        // attempt's complete change set (plus the seeded basePatch, carried forward).
        const patch = snapshotTree(cwd);
        if (!ok || !patch.trim()) return { index, ok, patch, detail, score: 0, why: "no successful diff" };
        // Judge in place — the attempt's diff is live in this worktree.
        const { score, why } = await judgeFn(cwd, index);
        return { index, ok, patch, detail, score, why };
      } catch (e) {
        return { index, ok: false, patch: "", detail: String((e as Error).message ?? e), score: 0, why: "attempt threw" };
      } finally {
        scrap(baseRoot, wt, brief.leoDir); // patch captured above; drop the worktree
      }
    }),
  );

  const winner = pickWinner(judged);
  const scores = judged.map((j) => j.score);
  logEvent(brief.leoDir, { event: "tournament_done", item, k: K, winner, scores });
  return { patch: winner >= 0 ? judged[winner].patch : null, winner, attempts: K, scores };
}
