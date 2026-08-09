// The plan as a graph: nodes with kinds, edges with a kind and a condition, and one
// deterministic routing function the scheduler calls to ask "what runs next?".
//
// This module is PURE. No file I/O, no model calls, no clock. Given the same graph,
// the same done set and the same state, nextNodes returns the same answer, always —
// that is what makes the Canvas trustworthy and routing arguable in review.
//
// TWO EDGE KINDS
//   after — the static dependency declared by `(after: 1, 3)`. Points from the
//           dependency at the item that waits for it. Always taken.
//   route — a conditional edge declared by `@on <cond> -> <target>`. Points from the
//           node that declares it at the node it may hand control to. Taken only
//           when its condition matches the state channel.
//
// STATE. `signals` is the state channel: what was DECIDED (`migrated=false`), never
// what was built — work product lives in git. `status` records a node's own outcome
// word (`ok`, `fail`), which is what a bare `@on fail -> 7` tests.
//
// ROUTING, in one paragraph. A done node whose route condition matches STEERS: its
// matched targets become dispatchable even if their static deps are not met (a route
// is an explicit jump — "the migration failed, go to the rollback"), and the nodes
// that merely sat downstream of it via `(after:)` are bypassed for this dispatch. A
// node with no matching route changes nothing, so a plan that declares no `@on` at
// all dispatches exactly the set — and in exactly the order — readyItems gives today.

//
// VALIDATION. validateGraph is the gate that runs BEFORE the first agent: it names
// the five ways a plan's graph can be malformed — a cycle, an edge to an item that
// does not exist, an item nothing can ever dispatch, an `@needs` no item emits, and
// an `@on key=value` route whose key no item emits — and every diagnostic names the
// offending item by index AND by text.

import { TOOL_EXIT_SIGNAL } from "./kinds.js";
import type { PlanItem, PlanNodeKind, PlanRoute } from "./plan.js";

export type GraphEdgeKind = "after" | "route";

export interface GraphNode {
  /** 1-based index, identical to PlanItem.index. */
  index: number;
  text: string;
  done: boolean;
  kind: PlanNodeKind;
  /** Label after the kind marker (`@gate security` → `"security"`), "" when none. */
  label: string;
  /** Signal keys this node requires before it may run (`@needs`). */
  needs: string[];
  /** Signals this node declares it may write (`@emit`). */
  emits: Array<{ key: string; value: string }>;
}

export interface GraphEdge {
  /** 1-based index of the source node. */
  from: number;
  /** 1-based index of the target node, exactly as declared — a `route` edge may point
   *  at a node that does not exist (0 or out of range). Recorded, not dropped, so the
   *  validator can name the offender; nextNodes simply never takes such an edge. */
  to: number;
  kind: GraphEdgeKind;
  /** Route edges only: the condition exactly as written (`fail`, `migrated=false`). */
  when?: string;
  /** Route edges only: the parsed condition the router evaluates. */
  condition?: PlanRoute;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** What the router reads. Both halves are optional; an empty state routes nothing. */
export interface GraphState {
  /** The state channel: signal key → value, as strings (`{ migrated: "false" }`). */
  signals?: Record<string, string>;
  /** Node index → the node's own outcome word (`"ok"`, `"fail"`). */
  status?: Record<number, string>;
}

const TRUTHY = new Set(["true", "1", "yes", "on", "ok", "pass", "passed", "success"]);

/** The only outcome words the engine ever records: `settleNode` writes `ok` when the item
 *  closed and `fail` when it did not, and nothing else ever lands in `status`. A bare-word
 *  `@on` condition therefore only means something if it is one of these — or a signal key
 *  some node emits. Anything else is an edge that cannot fire. */
const OUTCOME_WORDS = new Set(["ok", "fail"]);

/** Build the graph a plan declares. Pure: same items in, same graph out. */
export function buildGraph(items: PlanItem[]): Graph {
  const nodes: GraphNode[] = items.map((i) => ({
    index: i.index,
    text: i.text,
    done: i.done,
    kind: i.kind,
    label: i.kindLabel,
    needs: [...i.needs],
    emits: i.emits.map((e) => ({ ...e })),
  }));
  const edges: GraphEdge[] = [];
  for (const i of items) {
    for (const d of i.deps) edges.push({ from: d, to: i.index, kind: "after" });
  }
  for (const i of items) {
    for (const r of i.routes) {
      edges.push({ from: i.index, to: r.target, kind: "route", when: r.when, condition: { ...r } });
    }
  }
  return { nodes, edges };
}

/** Does this route's condition hold, for an edge leaving node `from`?
 *
 *  signal (`key=value` / `key!=value`) — compares the channel value. An ABSENT key
 *  never matches, in either direction: unknown is not "different from", and routing
 *  on something nobody emitted is the bug this rule prevents.
 *  status (a bare word) — matches the node's recorded outcome, case-insensitively;
 *  when the node recorded no outcome, a truthy signal of the same name matches
 *  (`@emit ok` then `@on ok -> 5`). */
function routeMatches(route: PlanRoute, from: number, state: GraphState): boolean {
  const signals = state.signals ?? {};
  if (route.kind === "signal") {
    const key = route.key ?? "";
    if (!Object.prototype.hasOwnProperty.call(signals, key)) return false;
    const actual = String(signals[key]).trim();
    const expected = (route.value ?? "").trim();
    const eq = actual.toLowerCase() === expected.toLowerCase();
    return route.op === "!=" ? !eq : eq;
  }
  const word = route.when.trim().toLowerCase();
  if (!word) return false;
  const outcome = state.status?.[from];
  if (outcome !== undefined && outcome !== null && String(outcome).trim() !== "") {
    if (String(outcome).trim().toLowerCase() === word) return true;
    // Fall through to the signal rather than returning. `settleNode` records "ok"/"fail"
    // for the node BEFORE the routes are taken, so `outcome` is always defined for the node
    // that just settled — which made the signal fallback this function documents
    // (`@emit ready=true` then `@on ready -> 3`) reachable only for a node carried over
    // from an earlier session. The bare-word spelling worked or not depending on when you
    // ran it; now it means one thing.
  }
  if (!Object.prototype.hasOwnProperty.call(signals, route.when.trim())) return false;
  const v = String(signals[route.when.trim()]).trim().toLowerCase();
  return TRUTHY.has(v) || v === word;
}

/** The signal keys a node can put on the channel: everything it declared with `@emit`,
 *  plus the `exit` a `@tool` node always reports (the executor writes it whether or not
 *  the plan spells it out, so the validator must count it as emitted). */
export function emittedKeys(node: GraphNode): string[] {
  const keys = node.emits.map((e) => e.key);
  if (node.kind === "tool") keys.push(TOOL_EXIT_SIGNAL);
  return keys;
}

/** Are every signal key this node declared with `@needs` present on the channel? */
function needsMet(node: GraphNode, state: GraphState): boolean {
  if (node.needs.length === 0) return true;
  const signals = state.signals ?? {};
  return node.needs.every((k) => Object.prototype.hasOwnProperty.call(signals, k));
}

/** The route edges leaving `from` whose condition holds right now.
 *
 *  Pure and done-blind ON PURPOSE: the scheduler asks this about a node the instant it
 *  settles — including a node that FAILED and is therefore not done — to find out
 *  whether the plan declared a handling for what just happened. Dangling targets are
 *  included; naming them is the validator's job, and `routeDecision` never dispatches
 *  one. Ordered by target index, so two matching routes always fan out the same way. */
export function takenRoutes(graph: Graph, from: number, state: GraphState = {}): GraphEdge[] {
  return graph.edges
    .filter((e) => e.kind === "route" && e.from === from && e.condition && routeMatches(e.condition, e.from, state))
    .sort((a, b) => a.to - b.to);
}

/** Everything the scheduler needs to dispatch AND to explain itself afterwards.
 *  `dispatch` is what runs; the rest is why. */
export interface RouteDecision {
  /** The nodes to dispatch, deduplicated and ascending — what `nextNodes` returns. */
  dispatch: number[];
  /** Targets a taken route points at, ascending. A routed target is dropped from
   *  `dispatch` (but kept here) when its own `@needs` are not on the channel yet. */
  routed: number[];
  /** Nodes whose route condition held, ascending. */
  steered: number[];
  /** The route edges actually taken, ordered by source then target. */
  taken: Array<{ from: number; to: number; when: string }>;
  /** Static successors skipped this dispatch because their predecessor steered. */
  bypassed: number[];
}

/** What the run has already DECIDED about its own edges — the latch.
 *
 *  A signal key is global and a node may overwrite one an earlier node routed on (two
 *  `@tool` nodes both write `exit`). Re-deriving the taken routes from the live channel
 *  every round would then silently un-take a route and un-bypass the branch the plan
 *  steered past, so a scheduler passes what it latched when the node settled: for a
 *  FROZEN node the router replays exactly those edges instead of re-evaluating its
 *  conditions. A node not in `frozen` — a node this run has not ended, including one
 *  marked done by an earlier session — is evaluated live, exactly as before. */
export interface LatchedRoutes {
  /** Nodes whose routing is decided and must not be re-evaluated. */
  frozen: ReadonlySet<number>;
  /** The route edges those nodes actually took. */
  taken: Iterable<{ from: number; to: number }>;
}

/** The nodes to dispatch next — the deterministic routing function.
 *
 *  `done` is the set of finished node indices; nodes already marked done in the plan
 *  count too, so `nextNodes(g, [], state)` works on a freshly parsed plan. The result
 *  is deduplicated and sorted ascending by index, which for a plan with no `@on`
 *  edges is exactly readyItems' order, item for item. */
export function nextNodes(
  graph: Graph,
  done: Iterable<number> = [],
  state: GraphState = {},
): number[] {
  return routeDecision(graph, done, state).dispatch;
}

/** `nextNodes` plus the reasoning behind it. ONE implementation: `nextNodes` is a
 *  wrapper over this, so what the scheduler dispatches and what it logs can never
 *  drift apart. */
export function routeDecision(
  graph: Graph,
  done: Iterable<number> = [],
  state: GraphState = {},
  latched?: LatchedRoutes,
): RouteDecision {
  const byIndex = new Map(graph.nodes.map((n) => [n.index, n]));
  const latchedEdges = new Set<string>();
  for (const t of latched?.taken ?? []) latchedEdges.add(`${t.from}->${t.to}`);
  const tookEdge = (e: GraphEdge): boolean =>
    latched?.frozen.has(e.from)
      ? latchedEdges.has(`${e.from}->${e.to}`)
      : routeMatches(e.condition!, e.from, state);
  const doneSet = new Set<number>(done);
  for (const n of graph.nodes) if (n.done) doneSet.add(n.index);

  // 1. Which done nodes steered, and where to.
  const routed = new Set<number>();
  const steered = new Set<number>();
  const taken: Array<{ from: number; to: number; when: string }> = [];
  for (const e of graph.edges) {
    if (e.kind !== "route" || !e.condition) continue;
    if (!doneSet.has(e.from)) continue;
    if (!tookEdge(e)) continue;
    steered.add(e.from);
    taken.push({ from: e.from, to: e.to, when: e.when ?? e.condition.when });
    const target = byIndex.get(e.to);
    if (!target || doneSet.has(e.to)) continue; // dangling or already done: not a target
    routed.add(e.to);
  }
  taken.sort((a, b) => a.from - b.from || a.to - b.to);

  // 2. Static successors of a node that steered are bypassed for this dispatch —
  //    control went down the route instead. Anything the route itself points at is
  //    never bypassed.
  const bypassed = new Set<number>();
  if (steered.size > 0) {
    for (const e of graph.edges) {
      if (e.kind !== "after") continue;
      if (steered.has(e.from) && !routed.has(e.to)) bypassed.add(e.to);
    }
  }

  // 3. The static ready set, unchanged from readyItems: open, every dep done.
  const out = new Set<number>(routed);
  for (const n of graph.nodes) {
    if (doneSet.has(n.index) || bypassed.has(n.index)) continue;
    const deps = graph.edges.filter((e) => e.kind === "after" && e.to === n.index);
    if (!deps.every((e) => doneSet.has(e.from))) continue;
    if (!needsMet(n, state)) continue;
    out.add(n.index);
  }

  // 4. A routed target still may not run without the signals it declared it needs.
  for (const i of routed) {
    const node = byIndex.get(i);
    if (node && !needsMet(node, state)) out.delete(i);
  }

  const asc = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);
  return { dispatch: asc(out), routed: asc(routed), steered: asc(steered), taken, bypassed: asc(bypassed) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The four ways a plan's graph can be malformed. One code per defect class, so a
 *  caller can filter, count or exit on a specific one without parsing prose. */
export type GraphDiagnosticCode =
  | "cycle"
  | "dangling-edge"
  | "unreachable"
  | "unmet-need"
  | "unroutable-signal";

/** How hard a diagnostic bites.
 *
 *  `error` — the graph cannot run: a cycle, an edge to nothing, an item nothing reaches,
 *  a `@needs` nobody emits. The run refuses, as it always has.
 *
 *  `warning` — the graph runs, but not the way its author wrote it. This exists because
 *  `unroutable-signal` is a NEW verdict on OLD text: a 0.15 plan carrying
 *  `@on migrated=false -> 7` with no matching `@emit` ran fine (the route was simply dead),
 *  and making that fatal would refuse to dispatch a single item of a plan that worked
 *  yesterday — against the promise `compile.ts` and `graph-cmd.ts` both state in as many
 *  words, "never a new way for an existing plan to be rejected". The plan item this
 *  implements asks that such routing "either works or is REPORTED"; loudly reported is
 *  what that is. */
export type GraphDiagnosticSeverity = "error" | "warning";

export interface GraphDiagnostic {
  code: GraphDiagnosticCode;
  /** Absent means `error` — every diagnostic that predates the severity split is one. */
  severity?: GraphDiagnosticSeverity;
  /** The item this diagnostic is about (1-based). For a cycle, its lowest member. */
  index: number;
  /** Every item this diagnostic names, ascending. `[index]` for everything but a
   *  cycle, where it is the whole cycle. */
  items: number[];
  /** dangling-edge and unroutable-signal only: the target exactly as written — `0`
   *  when the `@on` line carried no target at all. */
  target?: number;
  /** unmet-need and unroutable-signal only: the signal key nobody emits. */
  key?: string;
  /** One line, naming the offender by index and text. Ready to print as-is. */
  message: string;
}

const MAX_TEXT = 60;

/** `item 7 ("Run the migration")` — the offender, named the way a human finds it. */
function name(node: GraphNode | undefined, index: number): string {
  const raw = (node?.text ?? "").trim();
  if (!raw) return `item ${index}`;
  const text = raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT - 1).trimEnd()}…` : raw;
  return `item ${index} ("${text}")`;
}

/** Edges whose both ends exist, as an ascending adjacency list. Dangling edges are
 *  left out on purpose: they get their own diagnostic and must not also drag a node
 *  into a phantom cycle. */
function adjacency(graph: Graph, byIndex: Map<number, GraphNode>): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const n of graph.nodes) adj.set(n.index, []);
  for (const e of graph.edges) {
    if (!byIndex.has(e.from) || !byIndex.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
  }
  for (const [, tos] of adj) tos.sort((a, b) => a - b);
  return adj;
}

/** Tarjan, walked in ascending index order so the answer never depends on the order
 *  edges happened to be declared. Returns only the components that actually cycle:
 *  more than one node, or a single node with an edge to itself. */
function cycles(graph: Graph, adj: Map<number, number[]>): number[][] {
  const indexOf = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const found: number[][] = [];
  let counter = 0;

  const strongconnect = (v: number): void => {
    indexOf.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indexOf.get(w)!));
      }
    }
    if (low.get(v) !== indexOf.get(v)) return;
    const comp: number[] = [];
    for (;;) {
      const w = stack.pop()!;
      onStack.delete(w);
      comp.push(w);
      if (w === v) break;
    }
    const selfLoop = comp.length === 1 && (adj.get(v) ?? []).includes(v);
    if (comp.length > 1 || selfLoop) found.push(comp.sort((a, b) => a - b));
  };

  for (const n of [...graph.nodes].sort((a, b) => a.index - b.index)) {
    if (!indexOf.has(n.index)) strongconnect(n.index);
  }
  return found.sort((a, b) => a[0] - b[0]);
}

/** One concrete loop through a cyclic component, starting at its lowest member, so
 *  the message shows the actual path instead of an unordered set. */
function cyclePath(component: number[], adj: Map<number, number[]>): number[] {
  const member = new Set(component);
  const start = component[0];
  const path: number[] = [];
  const seen = new Set<number>();
  const walk = (v: number): boolean => {
    path.push(v);
    seen.add(v);
    for (const w of adj.get(v) ?? []) {
      if (w === start) return true;
      if (!member.has(w) || seen.has(w)) continue;
      if (walk(w)) return true;
    }
    path.pop();
    seen.delete(v);
    return false;
  };
  return walk(start) ? path : [...component];
}

/** Every node the run could ever dispatch, and the signals those nodes may emit.
 *
 *  Monotone fixpoint over exactly the rule nextNodes executes: a node runs when all
 *  its `(after:)` predecessors can run OR any route pointing at it can be taken, and
 *  in both cases only once its `@needs` are on the channel. Nodes already marked done
 *  seed the set — they demonstrably ran, whatever the graph says. */
function reachableSet(
  graph: Graph,
  byIndex: Map<number, GraphNode>,
): { reachable: Set<number>; signals: Set<string> } {
  const afterPreds = new Map<number, number[]>();
  const routePreds = new Map<number, number[]>();
  for (const n of graph.nodes) {
    afterPreds.set(n.index, []);
    routePreds.set(n.index, []);
  }
  for (const e of graph.edges) {
    if (!byIndex.has(e.from) || !byIndex.has(e.to)) continue;
    (e.kind === "after" ? afterPreds : routePreds).get(e.to)!.push(e.from);
  }

  const reachable = new Set<number>();
  const signals = new Set<string>();
  const admit = (n: GraphNode): void => {
    reachable.add(n.index);
    for (const key of emittedKeys(n)) signals.add(key);
  };
  for (const n of graph.nodes) if (n.done) admit(n);

  for (;;) {
    let grew = false;
    for (const n of graph.nodes) {
      if (reachable.has(n.index)) continue;
      const deps = afterPreds.get(n.index)!;
      const routes = routePreds.get(n.index)!;
      const dispatchable =
        deps.every((p) => reachable.has(p)) || routes.some((p) => reachable.has(p));
      if (!dispatchable) continue;
      if (!n.needs.every((k) => signals.has(k))) continue;
      admit(n);
      grew = true;
    }
    if (!grew) break;
  }
  return { reachable, signals };
}

/** Validate the graph a plan declares, BEFORE any agent runs.
 *
 *  Returns one diagnostic per defect, ordered cycle → dangling-edge → unmet-need →
 *  unroutable-signal → unreachable and by item index within a class, so the output is
 *  stable enough to diff. An empty array means the graph is sound.
 *
 *  A plan that declares no `@on`, `@needs` or `@emit` can never produce a diagnostic:
 *  `(after:)` edges only ever point forward from an existing item, so they cannot
 *  cycle, dangle or strand anything. Validation is a gate for the new grammar, never
 *  a new way for an old plan to fail. */
export function validateGraph(graph: Graph): GraphDiagnostic[] {
  const byIndex = new Map(graph.nodes.map((n) => [n.index, n]));
  const out: GraphDiagnostic[] = [];

  // 1. Cycles. Structural: a loop is a loop whether or not anything can reach it.
  const adj = adjacency(graph, byIndex);
  const cyclic = new Set<number>();
  for (const comp of cycles(graph, adj)) {
    for (const i of comp) cyclic.add(i);
    const path = cyclePath(comp, adj);
    const hops = [...path, path[0]].map((i) => name(byIndex.get(i), i)).join(" -> ");
    out.push({
      code: "cycle",
      index: comp[0],
      items: comp,
      message: `Cycle: ${hops}. The run could never finish, so nothing was dispatched.`,
    });
  }

  // 2. Dangling edges — a route pointing at an item that does not exist, or none.
  const dangling: GraphDiagnostic[] = [];
  for (const e of graph.edges) {
    if (byIndex.has(e.to)) continue;
    const from = name(byIndex.get(e.from), e.from);
    const when = e.when ? `\`@on ${e.when}\`` : "a route";
    dangling.push({
      code: "dangling-edge",
      index: e.from,
      items: [e.from],
      target: e.to,
      message:
        e.to > 0
          ? `${from} routes to item ${e.to}, which does not exist (${when}).`
          : `${from} declares ${when} with no target item.`,
    });
  }
  dangling.sort((a, b) => a.index - b.index || (a.target ?? 0) - (b.target ?? 0));
  out.push(...dangling);

  // 3. Unmet needs — a `@needs key` no item anywhere declares it may emit. Checked
  //    over every node, done or not: a malformed declaration stays malformed.
  const emitted = new Set<string>();
  for (const n of graph.nodes) for (const key of emittedKeys(n)) emitted.add(key);
  const flagged = new Set<number>();
  for (const n of [...graph.nodes].sort((a, b) => a.index - b.index)) {
    for (const key of n.needs) {
      if (emitted.has(key)) continue;
      flagged.add(n.index);
      out.push({
        code: "unmet-need",
        index: n.index,
        items: [n.index],
        key,
        message: `${name(n, n.index)} needs signal "${key}", which no item emits.`,
      });
    }
  }

  // 4. Unroutable signals — the `@on` half of the same rule. A route conditioned on
  //    `key=value` can only ever fire if something puts `key` on the channel, and
  //    routeMatches treats an absent key as no match in BOTH directions, so
  //    `@on migrated=false -> 7` with no `@emit migrated` anywhere is an edge that
  //    can never be taken: the routing the author wrote silently does not happen.
  //    Status routes (`@on fail`) need no signal — they test the node's own outcome —
  //    and are never diagnosed. An edge already named as dangling is skipped: it has
  //    a more fundamental defect and one line per defect is the contract.
  const unroutable: GraphDiagnostic[] = [];
  for (const e of graph.edges) {
    if (e.kind !== "route" || !e.condition) continue;
    if (!byIndex.has(e.from) || !byIndex.has(e.to)) continue;
    // Both spellings of the same dead edge. `@on migrated=false` is a signal condition;
    // `@on migrated` parses as a STATUS condition, and a status word only ever matches an
    // outcome the engine records — which is `ok` or `fail`, nothing else — or, failing
    // that, a signal of the same name. So a bare word that is neither an outcome word nor
    // an emitted key can no more fire than the `key=value` form can. Diagnosing one and
    // staying silent on the other is how "the routing either works or is reported" stayed
    // half true.
    const key = e.condition.kind === "signal"
      ? (e.condition.key ?? "")
      : e.condition.when.trim();
    if (!key) continue;
    if (e.condition.kind === "status" && OUTCOME_WORDS.has(key.toLowerCase())) continue;
    if (emitted.has(key)) continue;
    unroutable.push({
      code: "unroutable-signal",
      severity: "warning",
      index: e.from,
      items: [e.from],
      target: e.to,
      key,
      message:
        `${name(byIndex.get(e.from), e.from)} routes to item ${e.to} on signal "${key}"` +
        ` (\`@on ${e.when ?? key}\`), which no item emits — the route can never be taken.`,
    });
  }
  unroutable.sort((a, b) => a.index - b.index || (a.target ?? 0) - (b.target ?? 0));
  out.push(...unroutable);

  // 5. Unreachable — nothing can ever dispatch it. Items already named by a cycle or
  //    an unmet need are skipped: that diagnostic IS the reason, and repeating it
  //    downstream would bury the offender under its own consequences.
  const { reachable } = reachableSet(graph, byIndex);
  for (const n of [...graph.nodes].sort((a, b) => a.index - b.index)) {
    if (reachable.has(n.index) || cyclic.has(n.index) || flagged.has(n.index)) continue;
    out.push({
      code: "unreachable",
      index: n.index,
      items: [n.index],
      message: `${name(n, n.index)} is unreachable: no wave and no route can dispatch it.`,
    });
  }

  return out;
}
