// The scheduler's routing seam: what runs next, and what the run decided.
//
// One writer for both dispatch paths. The serial loop and the --parallel scheduler ask
// the SAME two questions here, so they can never drift into routing a plan differently:
//
//   dispatchPlan()  — given the plan, the channel and what has settled, what do I run?
//   settleNode()    — an item just ended: put its signals on the channel, and take
//                     whatever route the plan declared for that outcome.
//
// THE REPOSITORY IS THE TRUTH OF WHAT WAS BUILT; THE CHANNEL IS THE TRUTH OF WHAT WAS
// DECIDED. Nothing here ever touches the work product: it moves signal names and
// outcome words, and the bus enforces the ceilings that keep it that way.
//
// A NODE THAT FAILED IS NOT A FAILING RUN when the plan declared where a failure goes.
// `@on fail -> 6` means "the migration failed, run the rollback", so a failure with a
// matching route SETTLES the node (it is not retried, and it does not count toward
// max_failures) and control moves to the target. A failure with no matching route is
// exactly what it always was: a retry, then an escalation.
//
// BACKWARD COMPATIBILITY. A plan with no `@on`, `@emit` or `@needs` can never produce a
// signal, can never take a route and can never settle a node. `dispatchPlan` then
// returns precisely `readyItems`' set, in ascending index order — which for the serial
// loop is the same item `nextOpenItem` picked, every round.

import { buildGraph, routeDecision, takenRoutes, type GraphState, type LatchedRoutes } from "./graph.js";
import { readSignals, emitSignal, recordDecision, BusContractError } from "./bus.js";
import { logEvent } from "./log.js";
import { TOOL_EXIT_SIGNAL } from "./kinds.js";
import type { PlanItem } from "./plan.js";

/** What the run has decided so far — the in-memory half of the state channel.
 *
 *  `status` is a node's own outcome word, which is what a bare `@on fail -> 6` tests;
 *  it lives for the run, not on disk, because it describes THIS run's execution.
 *  Signals, which outlive a turn, live in `.leopold/bus.json`. */
export interface RunRouting {
  /** 1-based item index → the outcome word it ended with (`"ok"` | `"fail"`). */
  status: Record<number, string>;
  /** Items whose declared route was taken. Open in PLAN.md but not dispatchable
   *  again: the plan said where control goes when they end that way. */
  settled: Set<number>;
  /** True once any route has been taken this run — the run genuinely branched. */
  steered: boolean;
  /** THE LATCH: every route edge this run actually took, in the order it took them.
   *
   *  A route is taken ONCE, when the node settles, against the channel as it stood at
   *  that instant. Signal keys are global — a later `@tool` node overwrites the same
   *  `exit` an earlier one routed on — so re-deriving the taken edges from the live
   *  channel on a later round would un-take a route and un-bypass the branch the plan
   *  steered past. Latched here, replayed by `routeDecision`, never recomputed. */
  taken: Array<{ from: number; to: number; when: string }>;
}

export function newRouting(): RunRouting {
  return { status: {}, settled: new Set<number>(), steered: false, taken: [] };
}

/** The routing this run has already decided, in the shape `routeDecision` replays.
 *
 *  FROZEN is every node whose outcome this run recorded: its edges are settled facts.
 *  A node marked done by an EARLIER session is deliberately not frozen — this run
 *  latched nothing for it, so it is evaluated live, exactly as it was before. */
function latchOf(routing: RunRouting): LatchedRoutes {
  return { frozen: new Set(Object.keys(routing.status).map(Number)), taken: routing.taken };
}

export interface Dispatch {
  /** The items to run, ROUTED TARGETS FIRST, then ascending by index. A taken route
   *  means "go there next", so it outranks the positional order; with no routes the
   *  list is plain ascending — `readyItems`' order, item for item. */
  order: PlanItem[];
  /** Targets a taken route points at, ascending. */
  routed: number[];
  /** Items skipped this round because their predecessor steered away from them. */
  bypassed: number[];
}

/** What runs next. Reads the channel (a file) and the plan; decides nothing itself —
 *  `routeDecision` is the pure function, this only feeds it. */
export function dispatchPlan(
  leoDir: string,
  items: PlanItem[],
  routing: RunRouting,
  inFlight: Set<number> = new Set(),
): Dispatch {
  const graph = buildGraph(items);
  const state: GraphState = { signals: readSignals(leoDir), status: routing.status };
  const d = routeDecision(graph, routing.settled, state, latchOf(routing));
  const byIndex = new Map(items.map((i) => [i.index, i]));
  const routed = new Set(d.routed);
  const pick = d.dispatch.filter((i) => !inFlight.has(i) && byIndex.has(i));
  const order = [...pick.filter((i) => routed.has(i)), ...pick.filter((i) => !routed.has(i))];
  return { order: order.map((i) => byIndex.get(i)!), routed: d.routed, bypassed: d.bypassed };
}

/** The outcome of one item, as the scheduler saw it. */
export interface NodeOutcome {
  done: boolean;
  /** Signals the worker reported on its status line, before any filtering. */
  signals?: Record<string, string>;
}

export interface Settlement {
  /** Routes actually taken away from this node (empty for a plan with no `@on`). */
  routes: Array<{ to: number; when: string; why: string }>;
  /** Signals that landed on the channel. */
  emitted: Record<string, string>;
  /** Keys the node reported but was refused, with the reason. */
  refused: Array<{ key: string; reason: string }>;
}

/** The signals a node may write, as `key → the values it declared for that key`.
 *
 *  A `@tool` node implicitly declares `exit` with no value: its command's exit status
 *  is not a choice the node makes, so it needs no `@emit` line to reach the channel —
 *  but it also has no declared value to fall back on, which is exactly right (the
 *  executor always reports the real one). */
function declaredEmits(item: PlanItem): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (item.kind === "tool") out.set(TOOL_EXIT_SIGNAL, []);
  for (const e of item.emits) {
    const values = out.get(e.key);
    if (values) values.push(e.value);
    else out.set(e.key, [e.value]);
  }
  return out;
}

/** Which signals actually go on the channel for this outcome. Pure, so the rule is
 *  testable without a filesystem:
 *
 *  - A key the item did NOT declare with `@emit` is refused. The plan says what a node
 *    may decide; a worker cannot widen that at runtime.
 *  - A declared key the worker reported takes the worker's value.
 *  - A declared key the worker did not report takes its DECLARED value, but only when
 *    the item ended `ok` and declared exactly one value for it — so `@emit migrated=true`
 *    means what it reads like without needing the model to cooperate, while an item
 *    declaring two possible values for one key (`@emit ok=true`, `@emit ok=false`) is
 *    ambiguous and emits nothing unless the worker says which. */
export function signalsFor(item: PlanItem, o: NodeOutcome): {
  emitted: Record<string, string>; refused: Array<{ key: string; reason: string }>;
} {
  const declared = declaredEmits(item);
  const emitted: Record<string, string> = {};
  const refused: Array<{ key: string; reason: string }> = [];
  for (const [key, value] of Object.entries(o.signals ?? {})) {
    if (declared.has(key)) emitted[key] = value;
    else refused.push({ key, reason: `item ${item.index} does not declare "${key}" with @emit` });
  }
  if (o.done) {
    for (const [key, values] of declared) {
      if (key in emitted) continue;
      const uniq = [...new Set(values)];
      if (uniq.length === 1) emitted[key] = uniq[0];
    }
  }
  return { emitted, refused };
}

/** Can the scheduler actually dispatch this route target right now?
 *
 *  Mirrors, for one node, exactly what `routeDecision` does with a routed target: a
 *  node already done (in the plan file or settled this run) is dropped, and so is one
 *  whose `@needs` are not on the channel. A route nobody can follow is not a handled
 *  outcome, so `settleNode` must not treat it as one. */
function dispatchable(target: PlanItem, routing: RunRouting, signals: Record<string, string>): boolean {
  if (target.done || routing.settled.has(target.index)) return false;
  return target.needs.every((k) => Object.prototype.hasOwnProperty.call(signals, k));
}

/** One item just ended: record its outcome, put its signals on the channel, and take
 *  whatever route the plan declared for that outcome — logging each one with WHY.
 *
 *  Mutates `routing`. Returns what happened so the caller can report it; the caller
 *  decides what a taken route means for the plan file (nothing — a routed-around item
 *  stays open, which is the honest record of what ran). */
export function settleNode(
  leoDir: string,
  items: PlanItem[],
  item: PlanItem,
  o: NodeOutcome,
  routing: RunRouting,
): Settlement {
  routing.status[item.index] = o.done ? "ok" : "fail";

  // 1. The channel. Per key, so one over-long value cannot drop the others; the bus
  //    enforces its own ceilings and names the offending key when it refuses.
  const { emitted, refused } = signalsFor(item, o);
  const landed: Record<string, string> = {};
  for (const [key, value] of Object.entries(emitted)) {
    try {
      emitSignal(leoDir, key, value, { by: item.index });
      landed[key] = value;
    } catch (err) {
      if (!(err instanceof BusContractError)) throw err;
      refused.push({ key, reason: err.message });
    }
  }
  if (Object.keys(landed).length) {
    logEvent(leoDir, { event: "signals", item: item.index, signals: landed });
  }
  for (const r of refused) {
    logEvent(leoDir, { event: "signal_refused", item: item.index, key: r.key, reason: r.reason });
  }

  // 2. The routes. Evaluated AFTER the emit, so a node may route on the signal it just
  //    decided (`@emit migrated=false` + `@on migrated=false -> 7` on the same item).
  const graph = buildGraph(items);
  const signals = readSignals(leoDir);
  const state: GraphState = { signals, status: routing.status };
  const byIndex = new Map(items.map((i) => [i.index, i]));
  const routes: Settlement["routes"] = [];
  for (const e of takenRoutes(graph, item.index, state)) {
    const target = byIndex.get(e.to);
    if (target && !dispatchable(target, routing, signals)) {
      // The route matched, but the target can never be dispatched — it is already
      // done, or it waits on a signal nothing put on the channel. Settling here would
      // report a failure as a clean, fully routed run while the declared recovery
      // never ran. Named in the events log, and the item falls back to the ordinary
      // retry/escalation path, exactly as if the route had not matched.
      logEvent(leoDir, {
        event: "route_unreachable", item: item.index, to: e.to, when: e.when ?? "",
        reason: target.done || routing.settled.has(e.to)
          ? `item ${item.index} routes to item ${e.to}, which is already done`
          : `item ${item.index} routes to item ${e.to}, which is waiting on signals it needs`,
      });
      continue;
    }
    if (!target) {
      // Declared but pointing nowhere. Never silently "handled": the item falls back to
      // the ordinary retry path and the dangling edge is named in the events log (the
      // graph validator names it before the run, this catches a plan edited mid-run).
      logEvent(leoDir, {
        event: "route_dangling", item: item.index, to: e.to, when: e.when ?? "",
        reason: `item ${item.index} routes to item ${e.to}, which does not exist`,
      });
      continue;
    }
    const c = e.condition;
    const why = c && c.kind === "signal"
      ? `signal ${c.key}="${signals[c.key ?? ""] ?? ""}" matches @on ${e.when}`
      : `item ${item.index} ended "${routing.status[item.index]}" and declares @on ${e.when}`;
    routes.push({ to: e.to, when: e.when ?? "", why });
  }

  if (routes.length) {
    routing.settled.add(item.index);
    routing.steered = true;
    // Latch before logging: from here on the router replays these edges instead of
    // re-testing their conditions against a channel a later node may overwrite.
    for (const r of routes) routing.taken.push({ from: item.index, to: r.to, when: r.when });
    for (const r of routes) {
      logEvent(leoDir, {
        event: "route", from: item.index, to: r.to, when: r.when,
        status: routing.status[item.index], why: r.why,
      });
      // The decision trail on the channel: what was decided, never what was built.
      try { recordDecision(leoDir, `route ${item.index} -> ${r.to}: ${r.why}`, { by: item.index }); }
      catch { /* the trail must never take the run down */ }
    }
  }

  return { routes, emitted: landed, refused };
}
