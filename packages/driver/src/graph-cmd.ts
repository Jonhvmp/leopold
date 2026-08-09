// `leopold graph`: the command a human runs before trusting a plan.
//
// It answers three questions in one shot — what did I actually author, where can
// control go, and is any of it malformed — WITHOUT running a single agent. Reading
// PLAN.md top to bottom tells you the items; it does not tell you that item 7 is
// only ever reachable through a route nobody can take, or that items 4 and 9 point
// at each other. This does, and it exits non-zero when the graph is unsound, so a
// pre-flight check can be `leopold graph >/dev/null || exit`.
//
// Three renderings, ONE graph behind all of them: the ASCII tree (default), the
// mermaid diagram (--mermaid), and the machine form (--json). Every one is built
// from buildGraph + validateGraph — the exact functions the scheduler routes on —
// so what you read here is what the run will do, not a second opinion about it.
//
// The renderers are PURE (graph in, string out) and unit-tested; runGraphCommand
// only reads the file and prints. Diagnostics go to stderr so the graph itself
// still pipes cleanly.

import fs from "node:fs";
import path from "node:path";
import { findLeoDir } from "./config.js";
import { parsePlan, type PlanNodeKind } from "./plan.js";
import {
  buildGraph, validateGraph, type Graph, type GraphDiagnostic, type GraphEdge, type GraphNode,
} from "./graph.js";

/** One glyph + one word per node kind. The glyph makes the tree scannable; the word
 *  makes it greppable, and both say the same thing so neither can lie. */
const KIND_GLYPH: Record<PlanNodeKind, string> = {
  work: "○",
  gate: "◆",
  human: "☗",
  tool: "⚙",
  verify: "✓",
  feedback: "↺",
};

/** Mermaid node shapes, one per kind: rectangle for work, hexagon for a gate,
 *  rhombus for the human decision, subroutine for a tool call, stadium for a
 *  verification, rounded box for the feedback node that reads the run itself. Chosen
 *  so a reader can tell the kinds apart at a glance without a legend, and stable so a
 *  diagram diffs cleanly. */
const KIND_SHAPE: Record<PlanNodeKind, [string, string]> = {
  work: ["[\"", "\"]"],
  gate: ["{{\"", "\"}}"],
  human: ["{\"", "\"}"],
  tool: ["[[\"", "\"]]"],
  verify: ["([\"", "\"])"],
  feedback: ["(\"", "\")"],
};

const MAX_TEXT = 64;

function clip(text: string, max = MAX_TEXT): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The signal declarations that hang off a node, as one trailing annotation. */
function annotations(n: GraphNode): string {
  const parts: string[] = [];
  if (n.needs.length) parts.push(`needs ${n.needs.join(", ")}`);
  if (n.emits.length) parts.push(`emits ${n.emits.map((e) => `${e.key}=${e.value}`).join(", ")}`);
  return parts.length ? `  [${parts.join(" · ")}]` : "";
}

function afterEdges(graph: Graph): GraphEdge[] {
  return graph.edges.filter((e) => e.kind === "after");
}

function routeEdges(graph: Graph): GraphEdge[] {
  return graph.edges.filter((e) => e.kind === "route");
}

/** The ASCII tree.
 *
 *  Structure is the `(after:)` dependency forest: roots are the items nothing
 *  depends on being done first, and each node is drawn once, under the first parent
 *  that reaches it. A node with more than one parent says so (`also after: 2`)
 *  rather than being duplicated, and a node revisited along a cycle is drawn as a
 *  back-reference — so a malformed graph still prints instead of hanging.
 *
 *  Route edges hang under their source as `→ on <cond> → item N`, visibly different
 *  from the dependency lines, because "may hand control to" is not "waits for". */
export function renderGraphTree(graph: Graph, title = "PLAN.md"): string {
  const byIndex = new Map(graph.nodes.map((n) => [n.index, n]));
  const after = afterEdges(graph);
  const routes = routeEdges(graph);

  const parents = new Map<number, number[]>();
  const children = new Map<number, number[]>();
  for (const n of graph.nodes) { parents.set(n.index, []); children.set(n.index, []); }
  for (const e of after) {
    if (!byIndex.has(e.from) || !byIndex.has(e.to)) continue;
    parents.get(e.to)!.push(e.from);
    children.get(e.from)!.push(e.to);
  }
  for (const [, v] of children) v.sort((a, b) => a - b);
  for (const [, v] of parents) v.sort((a, b) => a - b);

  const out: string[] = [];
  const signals = new Set<string>();
  for (const n of graph.nodes) for (const e of n.emits) signals.add(e.key);
  out.push(`Leopold graph — ${title}`);
  out.push(
    `${graph.nodes.length} node${graph.nodes.length === 1 ? "" : "s"} · ` +
    `${after.length} dependency edge${after.length === 1 ? "" : "s"} · ` +
    `${routes.length} route${routes.length === 1 ? "" : "s"} · ` +
    `${signals.size} signal${signals.size === 1 ? "" : "s"}`,
  );
  out.push("");

  const drawn = new Set<number>();
  /** The parent a node is drawn under: the highest-indexed one, i.e. the last of its
   *  dependencies to be satisfied. Undefined for a root. */
  const primary = (index: number): number | undefined => {
    const ps = parents.get(index) ?? [];
    return ps.length ? ps[ps.length - 1] : undefined;
  };

  const line = (n: GraphNode, prefix: string, connector: string, extra: string): void => {
    const box = n.done ? "[x]" : "[ ]";
    const kind = `${KIND_GLYPH[n.kind]} ${n.kind}`.padEnd(9);
    const label = n.label ? ` (${n.label})` : "";
    out.push(`${prefix}${connector}${box} ${n.index}  ${kind} ${clip(n.text)}${label}${extra}${annotations(n)}`);
  };

  const draw = (index: number, prefix: string, connector: string, childPrefix: string): void => {
    const n = byIndex.get(index);
    if (!n) return;
    if (drawn.has(index)) {
      out.push(`${prefix}${connector}↩ ${index} (already shown above)`);
      return;
    }
    drawn.add(index);
    const others = (parents.get(index) ?? []).slice(0, -1);
    const extra = others.length ? `  (also after: ${others.join(", ")})` : "";
    line(n, prefix, connector, extra);

    // Draw a node under the LAST dependency that gates it, so it appears once every
    // item it waits for has already been shown. `(after:)` only ever points at an
    // earlier item, so that parent is always drawn first.
    const kids = (children.get(index) ?? []).filter((c) => primary(c) === index);
    const mine = routes.filter((r) => r.from === index).sort((a, b) => a.to - b.to);
    const rows = [...mine.map((r) => ({ route: r })), ...kids.map((k) => ({ kid: k }))];
    rows.forEach((row, i) => {
      const last = i === rows.length - 1;
      const conn = last ? "└─ " : "├─ ";
      const nextPrefix = `${childPrefix}${last ? "   " : "│  "}`;
      if ("route" in row && row.route) {
        const r = row.route;
        const target = byIndex.get(r.to);
        const where = target ? `item ${r.to} — ${clip(target.text, 40)}` : `item ${r.to} (missing)`;
        out.push(`${childPrefix}${conn}→ on ${r.when} → ${where}`);
      } else if ("kid" in row && row.kid !== undefined) {
        draw(row.kid, childPrefix, conn, nextPrefix);
      }
    });
  };

  const roots = graph.nodes
    .filter((n) => (parents.get(n.index) ?? []).length === 0)
    .map((n) => n.index)
    .sort((a, b) => a - b);
  for (const r of roots) draw(r, "", "", "");

  // Anything a cycle kept out of the forest: still shown, never silently dropped.
  const orphans = graph.nodes.map((n) => n.index).filter((i) => !drawn.has(i)).sort((a, b) => a - b);
  if (orphans.length) {
    out.push("");
    out.push("Not reachable from any root (a cycle keeps these out of the dependency forest):");
    for (const i of orphans) draw(i, "", "", "");
  }
  return out.join("\n");
}

/** Escape a node label for mermaid: `#` first (it introduces the entity form), then
 *  the characters that would end the quoted string or the node itself. */
function mermaidText(text: string): string {
  return clip(text)
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"))
    .replace(/[{}[\]()|]/g, "");
}

/** The mermaid rendering, in a fenced block ready to paste into a doc or an issue.
 *  Dependencies are solid arrows; routes are dotted and carry their condition, the
 *  same visual split the Canvas uses. A route pointing at an item that does not
 *  exist gets a drawn placeholder node — the diagram must show the defect, not hide
 *  it behind a dropped edge. */
export function renderMermaid(graph: Graph): string {
  const byIndex = new Map(graph.nodes.map((n) => [n.index, n]));
  const out: string[] = ["```mermaid", "graph TD"];
  for (const n of graph.nodes) {
    const [open, close] = KIND_SHAPE[n.kind];
    // ` · label`, not `(label)`: mermaidText strips brackets out of the text, so the
    // renderer must not put any back in itself.
    const label = `${n.index}. ${mermaidText(n.text)}${n.label ? ` · ${mermaidText(n.label)}` : ""}`;
    out.push(`  n${n.index}${open}${label}${close}`);
  }
  const missing = new Set<number>();
  for (const e of graph.edges) if (e.kind === "route" && !byIndex.has(e.to)) missing.add(e.to);
  for (const m of [...missing].sort((a, b) => a - b)) {
    out.push(`  n${m < 0 ? `neg${Math.abs(m)}` : m}["${m > 0 ? `${m}. missing item` : "no target"}"]`);
  }
  const id = (i: number): string => `n${i < 0 ? `neg${Math.abs(i)}` : i}`;
  for (const e of afterEdges(graph)) out.push(`  ${id(e.from)} --> ${id(e.to)}`);
  for (const e of routeEdges(graph)) {
    out.push(`  ${id(e.from)} -. "${mermaidText(e.when ?? "")}" .-> ${id(e.to)}`);
  }
  const done = graph.nodes.filter((n) => n.done).map((n) => id(n.index));
  const dangling = [...missing].sort((a, b) => a - b).map(id);
  // Style values carry no spaces and no commas on purpose: mermaid splits classDef
  // properties on both, and a space inside a value is how a diagram stops rendering.
  out.push("  classDef done fill:#eef2ff,stroke:#8899bb;");
  out.push("  classDef missing fill:#fff0f0,stroke:#cc0000,color:#cc0000;");
  if (done.length) out.push(`  class ${done.join(",")} done;`);
  if (dangling.length) out.push(`  class ${dangling.join(",")} missing;`);
  out.push("```");
  return out.join("\n");
}

/** The diagnostics block a human reads when the graph is rejected. Each line already
 *  names the offending item by index and text; this only groups and counts them. */
export function renderDiagnostics(diags: GraphDiagnostic[]): string {
  if (diags.length === 0) return "Graph is valid: no cycles, no dangling edges, every item reachable.";
  const errors = diags.filter((d) => (d.severity ?? "error") === "error");
  const warnings = diags.filter((d) => (d.severity ?? "error") === "warning");
  const out: string[] = [];
  // Errors and warnings must not be counted together. "No agent would be dispatched" is a
  // statement about what the run will DO, and saying it over a plan that dispatches
  // everything just fine is the same lie as staying silent about a dead route — pointed
  // the other way. A warning gets its own heading, its own mark, and no verdict.
  if (errors.length) {
    out.push(
      `Invalid graph — ${errors.length} problem${errors.length === 1 ? "" : "s"}. No agent would be dispatched.`,
      "",
    );
    // The diagnostic's own message already says which defect it is ("Cycle: …",
    // "routes to item 99, which does not exist"); repeating the code would only make
    // the line longer. The machine form (--json) is where the code belongs.
    for (const d of errors) out.push(`  ✗ ${d.message}`);
    out.push("");
  }
  if (warnings.length) {
    out.push(
      errors.length
        ? `Also ${warnings.length} warning${warnings.length === 1 ? "" : "s"} — the graph runs, but not as written:`
        : `Graph is valid, with ${warnings.length} warning${warnings.length === 1 ? "" : "s"} — it runs, but not as written:`,
      "",
    );
    for (const d of warnings) out.push(`  ⚠ ${d.message}`);
    out.push("");
  }
  out.push(errors.length
    ? "Fix PLAN.md and run `leopold graph` again."
    : "The run will proceed. Fix the routing above if you meant it to fire.");
  return out.join("\n");
}

/** The verdict of the pre-flight gate: is this plan's graph safe to dispatch? */
export interface Preflight {
  ok: boolean;
  diagnostics: GraphDiagnostic[];
  /** The human-facing block, identical to what `leopold graph` prints. "" when ok. */
  report: string;
}

/** Validate a plan's graph WITHOUT running anything — the gate `leopold graph` and
 *  the driver's run entry both call, so the two can never disagree about whether a
 *  plan is dispatchable or about how the problem is worded.
 *
 *  A plan with no graph grammar cannot fail here: `(after:)` edges only ever point
 *  backward, so they cannot cycle, dangle or strand an item. This is a new gate for
 *  the new constructs, never a new way for an existing plan to be rejected. */
export function preflightPlan(planPath: string): Preflight {
  const graph = buildGraph(parsePlan(fs.readFileSync(planPath, "utf8")));
  const diagnostics = validateGraph(graph);
  // `ok` is about whether the graph can RUN, so only errors decide it. A warning still
  // prints — a dead route the author wrote is worth saying out loud every time — but it
  // does not refuse a plan that ran yesterday. See GraphDiagnosticSeverity for why that
  // distinction had to exist the moment `unroutable-signal` started judging old text.
  const blocking = diagnostics.filter((d) => (d.severity ?? "error") === "error");
  return {
    ok: blocking.length === 0,
    diagnostics,
    report: diagnostics.length ? renderDiagnostics(diagnostics) : "",
  };
}

/** Where the plan is: `--plan PATH` wins, else the nearest .leopold/PLAN.md. */
function resolvePlanPath(cwd: string, argv: string[]): string {
  const i = argv.indexOf("--plan");
  if (i >= 0) {
    const p = argv[i + 1];
    if (!p || p.startsWith("-")) throw new Error("--plan needs a path to a PLAN.md file.");
    return path.resolve(cwd, p);
  }
  return path.join(findLeoDir(cwd), "PLAN.md");
}

/** `leopold graph [--mermaid|--json] [--quiet] [--plan PATH]`.
 *
 *  Exit codes are the contract: 0 the graph is sound, 1 it is malformed (the
 *  diagnostics are on stderr), 2 there was no plan to read. */
export function runGraphCommand(cwd: string, argv: string[]): number {
  let planPath: string;
  try {
    planPath = resolvePlanPath(cwd, argv);
  } catch (err) {
    console.error(`leopold graph: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (!fs.existsSync(planPath)) {
    console.error(`leopold graph: no plan at ${planPath}. Run /leopold-brief first.`);
    return 2;
  }

  const graph = buildGraph(parsePlan(fs.readFileSync(planPath, "utf8")));
  const diags = validateGraph(graph);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ plan: planPath, ...graph, diagnostics: diags }, null, 2));
    return diags.length ? 1 : 0;
  }

  if (!argv.includes("--quiet")) {
    console.log(argv.includes("--mermaid") ? renderMermaid(graph) : renderGraphTree(graph, planPath));
  }
  if (diags.length) {
    console.error("");
    console.error(renderDiagnostics(diags));
    return 1;
  }
  if (!argv.includes("--quiet") && !argv.includes("--mermaid")) {
    console.log("");
    console.log(renderDiagnostics(diags));
  }
  return 0;
}
