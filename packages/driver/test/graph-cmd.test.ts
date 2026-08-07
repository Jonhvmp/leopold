// Unit tests for `leopold graph`: the tree, the mermaid diagram, the diagnostics
// block, and the exit-code contract the command is actually trusted for.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan } from "../src/plan.ts";
import { buildGraph, validateGraph } from "../src/graph.ts";
import {
  renderGraphTree, renderMermaid, renderDiagnostics, runGraphCommand,
} from "../src/graph-cmd.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const graphOf = (plan: string) => buildGraph(parsePlan(plan));

const ROUTED_PLAN = `# Plan

- [x] @tool db: Snapshot the database
      @emit snapshot=true
- [ ] (after: 1) Run the migration
      @needs snapshot
      @emit migrated=true
      @on migrated=false -> 4
- [ ] @verify (after: 2) Check the schema
- [ ] Roll the migration back
- [ ] @human Ask ops to sign off
`;

const CYCLE_PLAN = `- [ ] Ship it
      @on again -> 2
- [ ] Roll back
      @on again -> 1
`;

/** Run the command with stdout/stderr captured, so the exit-code contract and the
 *  stream each line lands on are both asserted instead of assumed. */
function run(argv: string[], cwd = HERE): { code: number; out: string; err: string } {
  const log = console.log, error = console.error;
  let out = "", err = "";
  console.log = (...a: unknown[]) => { out += `${a.join(" ")}\n`; };
  console.error = (...a: unknown[]) => { err += `${a.join(" ")}\n`; };
  try {
    return { code: runGraphCommand(cwd, argv), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** A plan file in a throwaway dir — nothing this suite writes touches the repo. */
function planFile(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leopold-graph-"));
  const p = path.join(dir, "PLAN.md");
  fs.writeFileSync(p, body);
  return p;
}

// --- the tree -------------------------------------------------------------------

test("the tree names every node with its kind, and hangs children off their last dep", () => {
  const tree = renderGraphTree(graphOf(ROUTED_PLAN), "PLAN.md");
  assert.match(tree, /5 nodes · 2 dependency edges · 1 route · 2 signals/);
  assert.match(tree, /\[x\] 1 .*tool.*Snapshot the database \(db\)/);
  assert.match(tree, /\[ \] 3 .*verify.*Check the schema/);
  assert.match(tree, /\[ \] 5 .*human.*Ask ops to sign off/);
  // Item 2 waits on 1, so it is drawn under it, indented.
  const lines = tree.split("\n");
  const two = lines.find((l) => l.includes("Run the migration"))!;
  assert.match(two, /^[│├└─\s]+\[ \] 2/);
});

test("the tree shows a route as a route, with its condition and its target", () => {
  const tree = renderGraphTree(graphOf(ROUTED_PLAN));
  assert.match(tree, /→ on migrated=false → item 4 — Roll the migration back/);
});

test("the tree shows each node's @needs and @emit declarations", () => {
  const tree = renderGraphTree(graphOf(ROUTED_PLAN));
  assert.match(tree, /\[emits snapshot=true\]/);
  assert.match(tree, /\[needs snapshot · emits migrated=true\]/);
});

test("a node with several deps is drawn once and says which others it waits for", () => {
  const tree = renderGraphTree(graphOf(`- [ ] A\n- [ ] B\n- [ ] (after: 1, 2) C\n`));
  assert.equal(tree.split("\n").filter((l) => / 3  /.test(l)).length, 1);
  assert.match(tree, /\(also after: 1\)/);
});

test("a cycle still prints — every node appears, and nothing loops forever", () => {
  const tree = renderGraphTree(graphOf(`- [ ] A\n- [ ] (after: 2) B\n- [ ] (after: 2) C\n`));
  for (const t of ["A", "B", "C"]) assert.ok(tree.includes(t), `${t} missing from the tree`);
});

// --- mermaid --------------------------------------------------------------------

test("--mermaid emits a fenced graph whose every edge endpoint is a declared node", () => {
  const m = renderMermaid(graphOf(ROUTED_PLAN));
  const lines = m.split("\n");
  assert.equal(lines[0], "```mermaid");
  assert.equal(lines[1], "graph TD");
  assert.equal(lines[lines.length - 1], "```");

  const declared = new Set<string>();
  for (const l of lines) {
    const m2 = l.match(/^ {2}(n[a-z0-9]+)[[({]/);
    if (m2) declared.add(m2[1]);
  }
  assert.deepEqual([...declared].sort(), ["n1", "n2", "n3", "n4", "n5"]);
  const edges = lines.filter((l) => l.includes("-->") || l.includes(".->"));
  assert.equal(edges.length, 3);
  for (const e of edges) {
    for (const id of e.match(/n[a-z0-9]+/g) ?? []) {
      assert.ok(declared.has(id), `edge references undeclared node ${id}: ${e}`);
    }
  }
});

test("mermaid gives each node kind its own shape, and routes a dotted labelled edge", () => {
  const m = renderMermaid(graphOf(ROUTED_PLAN));
  assert.match(m, /n1\[\["1\. Snapshot the database · db"\]\]/); // tool
  assert.match(m, /n2\["2\. Run the migration"\]/);                // work
  assert.match(m, /n3\(\["3\. Check the schema"\]\)/);             // verify
  assert.match(m, /n5\{"5\. Ask ops to sign off"\}/);              // human
  assert.match(m, /n2 --> n3/);
  assert.match(m, /n2 -\. "migrated=false" \.-> n4/);
  assert.match(m, /class n1 done;/);
});

test("mermaid escapes what would break the diagram, and never leaves a space in a style", () => {
  const m = renderMermaid(graphOf(`- [ ] @gate ci Check "prod" #1 <now> [x] (y)\n`));
  const node = m.split("\n")[2];
  const inner = node.replace(/^ {2}n1[[({]+"/, "").replace(/"[\])}]+$/, "");
  assert.ok(!/[<>"[\]{}()|]/.test(inner), `unescaped metacharacter in the label: ${node}`);
  assert.match(m, /#quot;prod#quot;/);
  assert.match(m, /#35;1/);
  assert.match(m, /#lt;now#gt;/);
  for (const l of m.split("\n").filter((x) => x.includes("classDef"))) {
    assert.ok(!/:[^,;]*\s/.test(l), `classDef style value contains a space: ${l}`);
  }
});

test("mermaid draws a dangling route target instead of dropping the edge", () => {
  const m = renderMermaid(graphOf(`- [ ] A\n      @on fail -> 99\n`));
  assert.match(m, /n99\["99\. missing item"\]/);
  assert.match(m, /n1 -\. "fail" \.-> n99/);
  assert.match(m, /class n99 missing;/);
});

// --- diagnostics ----------------------------------------------------------------

test("a valid graph reports valid; an invalid one names every offending item", () => {
  assert.match(renderDiagnostics([]), /^Graph is valid/);
  const d = renderDiagnostics(validateGraph(graphOf(CYCLE_PLAN)));
  assert.match(d, /Invalid graph — 1 problem\. No agent would be dispatched\./);
  assert.match(d, /item 1 \("Ship it"\)/);
  assert.match(d, /item 2 \("Roll back"\)/);
});

// --- the command ----------------------------------------------------------------

test("a valid plan prints nodes with their kinds and edges with conditions, exit 0", () => {
  const r = run(["--plan", planFile(ROUTED_PLAN)]);
  assert.equal(r.code, 0);
  assert.match(r.out, /human   Ask ops to sign off/);
  assert.match(r.out, /→ on migrated=false → item 4/);
  assert.match(r.out, /Graph is valid/);
  assert.equal(r.err, "");
});

test("a plan with a cycle prints the diagnostic naming the items on stderr, exit non-zero", () => {
  const r = run(["--plan", planFile(CYCLE_PLAN)]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Cycle: item 1 \("Ship it"\) -> item 2 \("Roll back"\)/);
  assert.doesNotMatch(r.out, /Graph is valid/);
});

test("--mermaid emits only the fenced diagram on stdout, and still fails a bad graph", () => {
  const ok = run(["--mermaid", "--plan", planFile(ROUTED_PLAN)]);
  assert.equal(ok.code, 0);
  assert.equal(ok.out.trim().split("\n")[0], "```mermaid");
  assert.equal(ok.out.trim().split("\n").pop(), "```");
  assert.doesNotMatch(ok.out, /Graph is valid/); // a diagram is a diagram

  const bad = run(["--mermaid", "--plan", planFile(CYCLE_PLAN)]);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.out.trim().split("\n")[0], "```mermaid");
  assert.match(bad.err, /Cycle: /);
});

test("--json is the machine form: the graph, plus one diagnostic per defect", () => {
  const r = run(["--json", "--plan", planFile(CYCLE_PLAN)]);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out) as {
    nodes: Array<{ index: number; kind: string }>;
    edges: Array<{ from: number; to: number; kind: string; when?: string }>;
    diagnostics: Array<{ code: string; items: number[] }>;
  };
  assert.deepEqual(j.nodes.map((n) => n.index), [1, 2]);
  assert.equal(j.edges.filter((e) => e.kind === "route").length, 2);
  assert.deepEqual(j.diagnostics.map((d) => d.code), ["cycle"]);
  assert.deepEqual(j.diagnostics[0].items, [1, 2]);
});

test("--quiet is the pre-flight: no graph on success, diagnostics and exit 1 on failure", () => {
  const ok = run(["--quiet", "--plan", planFile(ROUTED_PLAN)]);
  assert.equal(ok.code, 0);
  assert.equal(ok.out, "");
  const bad = run(["--quiet", "--plan", planFile(CYCLE_PLAN)]);
  assert.equal(bad.code, 1);
  assert.equal(bad.out, "");
  assert.match(bad.err, /Cycle: /);
});

test("a missing plan is exit 2, not a crash and not a false 'valid'", () => {
  const r = run(["--plan", path.join(os.tmpdir(), "leopold-no-such-plan.md")]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no plan at /);
  assert.equal(r.out, "");
  assert.equal(run(["--plan"]).code, 2);
});

test("every existing plan fixture prints and validates clean — exit 0, both renderings", () => {
  const dir = path.join(HERE, "fixtures", "plans");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0);
  for (const f of files) {
    const p = path.join(dir, f);
    const tree = run(["--plan", p]);
    assert.equal(tree.code, 0, `${f}: ${tree.err}`);
    assert.equal(tree.err, "");
    const graph = graphOf(fs.readFileSync(p, "utf8"));
    // Every item is in the printed tree, exactly once: no plan may lose a node to
    // the renderer's tree-building.
    for (const n of graph.nodes) {
      const rows = tree.out.split("\n").filter((l) => new RegExp(`\\[[ x]\\] ${n.index}  `).test(l));
      assert.equal(rows.length, 1, `${f}: item ${n.index} appears ${rows.length} times`);
    }
    assert.equal(run(["--mermaid", "--plan", p]).code, 0, f);
  }
});
