// Consumer 2: review findings, deduped and triaged by meaning instead of by string.
//
// `unionReviews()` dedupes on `file + issue` exactly, so two lenses describing ONE defect in
// different words reach the worker as two blockers and cost two turns chasing one bug. This asks
// whether they are the same defect, and whether a finding is a defect at all.
//
// IT FAILS CLOSED, IN BOTH DIRECTIONS. A merge needs a confident yes; a demotion from blocking
// needs a confident yes. Anything else — a low answer, a failure, a timeout, no provider — leaves
// the finding exactly where `unionReviews()` put it. Keeping a duplicate costs a turn; dropping a
// real blocker costs a bug, so the two errors are not weighed the same.
//
// ONE QUESTION PER CALL, deliberately. The catalog is static (that is what makes it reviewable by
// a human), and these questions are about PAIRS built at runtime, so each pair goes in its own
// `state`. A review panel produces a handful of findings, so the call count is small and the
// questions run concurrently.

import { ask } from "./ask.js";
import { loadCatalog } from "./config.js";
import type { Catalog, NoulAnswer } from "./contract.js";
import type { DecisionEvent } from "./events.js";
import type { Provider } from "./provider.js";
import type { ReviewFinding, ReviewResult } from "../review.js";

export interface RefineOptions {
  leoDir: string;
  catalogName?: string;
  provider?: Provider;
  emit?: (event: DecisionEvent) => void;
  env?: NodeJS.ProcessEnv;
}

interface Verdict {
  noul: number;
  usable: boolean;
}

async function askNoul(
  catalog: Catalog,
  question: string,
  state: unknown,
  opts: RefineOptions,
): Promise<Verdict> {
  const r = await ask<null>({
    catalog,
    questions: [question],
    state,
    fallback: null,
    provider: opts.provider,
    leoDir: opts.leoDir,
    env: opts.env,
    emit: opts.emit,
  });
  const a = r.answers[question];
  const ok = a && a.ok === true && a.type === "noul";
  return { noul: ok ? (a as NoulAnswer).noul : 0, usable: r.usable && ok === true };
}

/** Refine a unioned panel verdict. Returns the input unchanged when nothing can be established. */
export async function refineReviews(base: ReviewResult, opts: RefineOptions): Promise<ReviewResult> {
  if (base.blocking.length === 0) return base;
  const raw = loadCatalog(opts.leoDir, opts.catalogName ?? "review");
  if (raw === null) return base;
  const catalog = raw as Catalog;

  const findings = base.blocking;

  // 1. Merge duplicates. Every unordered pair is asked once; a confident yes folds the later
  //    finding into the earlier one.
  const merged = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) pairs.push([i, j]);
  }
  const pairVerdicts = await Promise.all(
    pairs.map(async ([i, j]) => ({
      i,
      j,
      v: await askNoul(catalog, "same_defect", { a: findings[i], b: findings[j] }, opts),
    })),
  );
  for (const { i, j, v } of pairVerdicts) {
    if (merged.has(i) || merged.has(j)) continue;
    if (v.usable && v.noul >= 0.5) merged.add(j);
  }

  // 2. Demote style-only findings. Only a confident "this is NOT a defect" demotes; everything
  //    else stays blocking, including every failure mode.
  const survivors: ReviewFinding[] = [];
  const kept = findings.map((_, k) => k).filter((k) => !merged.has(k));
  const defectVerdicts = await Promise.all(
    kept.map(async (k) => ({ k, v: await askNoul(catalog, "is_defect", { finding: findings[k] }, opts) })),
  );
  for (const { k, v } of defectVerdicts) {
    // usable && confidently "not a defect" -> demote. Anything else keeps it blocking.
    if (v.usable && v.noul < 0.5) continue;
    survivors.push(findings[k]);
  }

  const note = [
    merged.size > 0 ? `${merged.size} duplicate finding(s) merged` : "",
    findings.length - merged.size - survivors.length > 0
      ? `${findings.length - merged.size - survivors.length} style-only finding(s) demoted`
      : "",
  ]
    .filter(Boolean)
    .join("; ");

  return {
    ok: survivors.length === 0,
    blocking: survivors,
    summary: note ? `${base.summary} [${note}]` : base.summary,
  };
}
