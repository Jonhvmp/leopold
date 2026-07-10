// Unit tests for the hand-rolled canvas layout (scripts/leopold-canvas-layout.js).
// The layout is zero-dep vanilla JS shared with the browser; here we require it
// straight from source and assert the invariants the canvas relies on:
// deterministic positions, finite coordinates, cycle-safety, and correct layering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { layout } = require("../../../scripts/leopold-canvas-layout.js") as {
  layout: (n: { id: string }[], e: { from: string; to: string }[], o?: Record<string, unknown>) => {
    positions: Record<string, { x: number; y: number; layer: number; order: number }>;
    width: number; height: number; layers: string[][]; dir: string;
  };
};

const finite = (r: { positions: Record<string, { x: number; y: number; layer: number }> }) =>
  Object.values(r.positions).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.layer));

test("layers a DAG by longest path; sources at layer 0, children below parents", () => {
  const nodes = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
  const edges = [{ from: "1", to: "2" }, { from: "1", to: "3" }, { from: "3", to: "4" }, { from: "2", to: "4" }];
  const r = layout(nodes, edges);
  assert.ok(finite(r));
  assert.equal(r.positions["1"].layer, 0, "source at layer 0");
  assert.ok(r.positions["4"].layer > r.positions["3"].layer, "child below parent");
  assert.ok(r.positions["2"].layer > r.positions["1"].layer, "longest-path relaxation");
  assert.equal(r.positions["4"].layer, 2, "4 is two hops from the source");
});

test("self-loops are ignored (no crash, finite)", () => {
  const r = layout([{ id: "a" }], [{ from: "a", to: "a" }]);
  assert.ok(finite(r));
  assert.equal(r.positions["a"].layer, 0);
});

test("is deterministic — identical inputs give byte-identical positions", () => {
  const nodes = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
  const edges = [{ from: "1", to: "2" }, { from: "1", to: "3" }, { from: "3", to: "4" }];
  assert.equal(JSON.stringify(layout(nodes, edges).positions), JSON.stringify(layout(nodes, edges).positions));
});

test("cycle-safe — a cyclic graph terminates with finite layers", () => {
  const r = layout([{ id: "1" }, { id: "2" }, { id: "3" }], [
    { from: "1", to: "2" }, { from: "2", to: "3" }, { from: "3", to: "1" },
  ]);
  assert.ok(finite(r));
  assert.equal(Object.keys(r.positions).length, 3);
});

test("empty and single-node graphs", () => {
  const empty = layout([], []);
  assert.deepEqual(empty.positions, {});
  assert.equal(empty.width, 0);
  const one = layout([{ id: "x" }], []);
  assert.equal(one.positions["x"].layer, 0);
  assert.ok(finite(one));
});

test("a fan-out shares one layer; LR direction is honored", () => {
  const nodes = [{ id: "root" }];
  const edges: { from: string; to: string }[] = [];
  for (let i = 0; i < 12; i++) { nodes.push({ id: "c" + i }); edges.push({ from: "root", to: "c" + i }); }
  const r = layout(nodes, edges, { dir: "LR" });
  assert.ok(finite(r));
  assert.equal(r.dir, "LR");
  const childLayers = new Set(nodes.slice(1).map((n) => r.positions[n.id].layer));
  assert.deepEqual([...childLayers], [1], "all fan-out children co-layered at layer 1");
});

test("edges to unknown nodes never produce NaN positions", () => {
  const r = layout([{ id: "a" }, { id: "b" }], [{ from: "a", to: "ghost" }, { from: "a", to: "b" }]);
  assert.ok(finite(r));
});
