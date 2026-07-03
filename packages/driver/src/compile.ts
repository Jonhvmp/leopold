// Compile a brief into the `args` a dynamic workflow consumes.
//
// The /leopold-workflow SKILL describes this compilation in prose and leans on the
// model to do it by hand. Here it is deterministic code instead: parse PLAN.md into
// dependency waves, risk-classify each item with the same keyword rules the driver
// uses everywhere, and emit the exact `args` shape the canonical
// leopold-run.workflow.js expects. Pure and unit-tested — the compilation no longer
// depends on a model getting the wave math right.

import { classifyItem, type Effort } from "./classify.js";
import { diffIsSensitive } from "./review.js";
import { parsePlan, type PlanItem } from "./plan.js";

export interface WorkflowItem {
  id: string;
  text: string;
  effort: Effort;
  critical: boolean;
  sensitive: boolean;
}

export interface CompiledWorkflow {
  mission: string;
  charter: string;
  maxReviewRounds: number;
  waves: WorkflowItem[][];
}

/** Layer open plan items into dependency waves: wave 1 is everything with no unmet
 *  dependency, wave 2 is everything whose deps are all in wave 1, and so on. Throws
 *  on a cycle or a dependency that can never be satisfied. Done items are skipped
 *  but still count as satisfied deps (a resumed plan). */
export function wavesOf(items: PlanItem[]): PlanItem[][] {
  const placed = new Set<number>(items.filter((i) => i.done).map((i) => i.index));
  let remaining = items.filter((i) => !i.done);
  const waves: PlanItem[][] = [];
  while (remaining.length) {
    const ready = remaining.filter((i) => i.deps.every((d) => placed.has(d)));
    if (ready.length === 0) {
      throw new Error(
        `PLAN.md has a dependency cycle or an unsatisfiable (after:) reference among items ${remaining.map((i) => i.index).join(", ")}`,
      );
    }
    waves.push(ready);
    for (const i of ready) placed.add(i.index);
    remaining = remaining.filter((i) => !placed.has(i.index));
  }
  return waves;
}

function intFrom(text: string, key: string, fallback: number): number {
  const m = text.match(new RegExp(`${key}\\s*:\\s*(\\d+)`, "i"));
  return m ? parseInt(m[1], 10) : fallback;
}

/** Compile a brief into the workflow `args`. */
export function compileBrief(brief: { mission: string; charter: string; guardrails?: string; planText: string }): CompiledWorkflow {
  const items = parsePlan(brief.planText);
  if (items.length === 0) throw new Error("PLAN.md has no checkbox items to compile.");
  const waves = wavesOf(items).map((wave) =>
    wave.map((pi): WorkflowItem => {
      const k = classifyItem(pi.text, brief.charter);
      return {
        id: `i${pi.index}`,
        text: pi.text,
        effort: k.effort,
        critical: k.critical,
        sensitive: diffIsSensitive(pi.text),
      };
    }),
  );
  return {
    mission: brief.mission,
    charter: brief.charter,
    maxReviewRounds: intFrom(brief.guardrails ?? "", "max_review_rounds", 2),
    waves,
  };
}
