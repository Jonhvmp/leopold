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
import { buildGraph, validateGraph } from "./graph.js";
import { parsePlan, type PlanEmit, type PlanItem, type PlanNodeKind, type PlanRoute } from "./plan.js";

export interface WorkflowItem {
  id: string;
  text: string;
  effort: Effort;
  critical: boolean;
  sensitive: boolean;
}

/** One node of the authored graph, as the workflow engine consumes it: the risk
 *  classification a wave item already carried, plus the structure the router needs —
 *  who it waits for, what it may decide, and where it may send control. */
export interface WorkflowNode extends WorkflowItem {
  /** 1-based plan index. The router speaks in indices; `id` stays the display key. */
  index: number;
  kind: PlanNodeKind;
  /** Label after the kind marker (`@gate security` → `"security"`), "" when none. */
  label: string;
  done: boolean;
  deps: number[];
  needs: string[];
  emits: PlanEmit[];
  routes: PlanRoute[];
}

export interface CompiledWorkflow {
  mission: string;
  charter: string;
  maxReviewRounds: number;
  waves: WorkflowItem[][];
  /** The authored graph — present ONLY when the plan declares graph grammar (a node
   *  kind, an `@on` route, an `@emit` or a `@needs`). Its absence is what keeps a plan
   *  written before this grammar existed compiling to a byte-identical payload, and it
   *  is the exact switch the workflow script uses to choose between the wave loop it
   *  has always run and the routed loop. */
  graph?: { nodes: WorkflowNode[] };
}

/** Does this plan author a graph, or is it the flat checklist Leopold has always run?
 *  Anything the old grammar could not express counts: a kind, a route, a signal. */
function declaresGraph(items: PlanItem[]): boolean {
  return items.some(
    (i) => i.kind !== "work" || i.routes.length > 0 || i.emits.length > 0 || i.needs.length > 0,
  );
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

/** Compile a brief into the workflow `args`.
 *
 *  A MALFORMED GRAPH FAILS HERE, before the workflow spawns its first agent: the
 *  validator's diagnostics are raised as the compile error, each naming its offending
 *  item by index and text. A plan with no graph grammar cannot produce a diagnostic
 *  (`(after:)` edges only ever point backward, so they cannot cycle, dangle or strand
 *  anything), so this gate is new safety for the new grammar, never a new way for an
 *  old plan to fail. */
export function compileBrief(brief: { mission: string; charter: string; guardrails?: string; planText: string }): CompiledWorkflow {
  const items = parsePlan(brief.planText);
  if (items.length === 0) throw new Error("PLAN.md has no checkbox items to compile.");

  const diagnostics = validateGraph(buildGraph(items));
  if (diagnostics.length > 0) {
    throw new Error(
      `PLAN.md declares an invalid graph, so nothing was dispatched:\n${diagnostics.map((d) => `  - ${d.message}`).join("\n")}`,
    );
  }

  const classify = (pi: PlanItem): WorkflowItem => {
    const k = classifyItem(pi.text, brief.charter);
    return {
      id: `i${pi.index}`,
      text: pi.text,
      effort: k.effort,
      critical: k.critical,
      sensitive: diffIsSensitive(pi.text),
    };
  };

  const waves = wavesOf(items).map((wave) => wave.map(classify));
  const compiled: CompiledWorkflow = {
    mission: brief.mission,
    charter: brief.charter,
    maxReviewRounds: intFrom(brief.guardrails ?? "", "max_review_rounds", 2),
    waves,
  };

  // The graph rides ALONGSIDE the waves rather than replacing them: a routed plan still
  // compiles to a valid wave payload, so an older copy of the script keeps running it.
  if (declaresGraph(items)) {
    compiled.graph = {
      nodes: items.map((pi): WorkflowNode => ({
        ...classify(pi),
        index: pi.index,
        kind: pi.kind,
        label: pi.kindLabel,
        done: pi.done,
        deps: [...pi.deps],
        needs: [...pi.needs],
        emits: pi.emits.map((e) => ({ ...e })),
        routes: pi.routes.map((r) => ({ ...r })),
      })),
    };
  }
  return compiled;
}
