// USD budget hard-stop for the SDK driver. The Claude Code CLI already reports
// `total_cost_usd` per session, so we never need a model price map: accumulate the
// real cost per item and stop the run when it crosses the cap. Two checks, like
// paperclip's evaluateCostEvent + getInvocationBlock: preventive (before an item)
// and reactive (after each item's cost lands).

/** Parse a budget value (CLI flag / env) into a positive USD number, or undefined. */
export function parseBudgetUsd(raw?: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** True when spend has reached or passed the cap. A missing cap never trips. */
export function overBudget(spentUsd: number, capUsd?: number): boolean {
  return capUsd !== undefined && spentUsd >= capUsd;
}
