#!/usr/bin/env python3
"""Unit tests for leopold-watch.py's DAG builder and the steer write-side.

Zero dependencies (stdlib unittest). Run: python3 scripts/test-watch-graph.py
Wired into `make test` via the `watch-test` target.

Covers:
  - build_graph() edge inference (conductor (after:N) deps, workflow seq/contains/
    verifies, no dangling edges, no self-deps, empty-safe)
  - _parse_after marker parsing
  - apply_canvas_command routing + the RED-TEAM invariant: a canvas command never
    writes a git-unlock token (ALLOW_GIT / ALLOW_PUSH / STOP).
"""
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("lw", os.path.join(HERE, "leopold-watch.py"))
lw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lw)


def edge_set(g):
    return {(e["from"], e["to"], e["kind"]) for e in g["edges"]}


def node_ids(g):
    return {n["id"] for n in g["nodes"]}


class BuildGraphConductor(unittest.TestCase):
    def test_after_deps_and_states(self):
        plan = [
            {"done": True, "text": "Build the graph model"},
            {"done": False, "text": "(after: 1) Emit edge hints"},
            {"done": False, "text": "(after: 1) Node detail"},
            {"done": False, "text": "(after: 3, 4) Canvas renderer"},
        ]
        g = lw.build_graph(plan, [], [])
        items = [n for n in g["nodes"] if n["kind"] == "item"]
        self.assertEqual(len(items), 4)
        self.assertEqual(items[0]["state"], "done")
        self.assertEqual(items[1]["state"], "open")
        after = {(e["from"], e["to"]) for e in g["edges"] if e["kind"] == "after"}
        self.assertIn(("item-1", "item-2"), after)
        self.assertIn(("item-1", "item-3"), after)
        self.assertIn(("item-3", "item-4"), after)
        # forward/self deps never leak
        self.assertNotIn(("item-4", "item-4"), after)
        self.assertTrue(all(e["from"] in node_ids(g) and e["to"] in node_ids(g) for e in g["edges"]))

    def test_review_hangs_off_current_item(self):
        plan = [{"done": True, "text": "Do the thing"}]
        events = [
            {"event": "item_start", "item": "Do the thing"},
            {"event": "review", "ok": False, "blocking": 2, "round": 1},
        ]
        g = lw.build_graph(plan, events, [])
        verifies = [e for e in g["edges"] if e["kind"] == "verifies"]
        self.assertTrue(any(e["from"] == "item-1" for e in verifies))

    def test_empty_is_safe(self):
        g = lw.build_graph([], [], [])
        self.assertEqual(g["nodes"], [])
        self.assertEqual(g["edges"], [])


class BuildGraphWorkflow(unittest.TestCase):
    def _wf(self):
        return {
            "runId": "wf_test", "name": "demo",
            "phases": [
                {"title": "Find", "running": 0, "tokens": 10, "agents": [
                    {"label": "find:bugs", "state": "done", "tokens": 5, "toolCalls": 1, "model": "opus"},
                ]},
                {"title": "Verify", "running": 0, "tokens": 8, "agents": [
                    {"label": "verify:bugs", "state": "done", "tokens": 8, "toolCalls": 2, "model": "sonnet"},
                ]},
            ],
        }

    def test_phase_seq_contains_and_verify_edges(self):
        g = lw.build_graph([], [], [self._wf()])
        ek = edge_set(g)
        self.assertTrue(any(k == "seq" for (_, _, k) in ek), "phase->phase seq edge")
        self.assertTrue(any(k == "contains" for (_, _, k) in ek), "phase->agent contains edge")
        self.assertTrue(any(k == "verifies" for (_, _, k) in ek), "verify agent hangs off prior phase")
        # a verify-labelled agent is classified as a verify node
        kinds = {n["id"]: n["kind"] for n in g["nodes"]}
        self.assertIn("verify", kinds.values())
        # no dangling edges
        self.assertTrue(all(e["from"] in node_ids(g) and e["to"] in node_ids(g) for e in g["edges"]))

    def test_structured_labels_give_exact_verify_edge(self):
        # Leopold's own scripts label `impl:<id>` + `verify:<id>:<lens>` — the graph
        # must draw the verify edge FROM the matching impl node (exact), not the phase.
        wf = {
            "runId": "wf_lbl", "name": "run",
            "phases": [
                {"title": "Execute", "agents": [{"label": "impl:i1", "state": "done"}]},
                {"title": "Verify", "agents": [{"label": "verify:i1:correctness", "state": "done"}]},
            ],
        }
        g = lw.build_graph([], [], [wf])
        impl_id, verify_id = "wf_lbl-p0-a0", "wf_lbl-p1-a0"
        verifies = {(e["from"], e["to"]) for e in g["edges"] if e["kind"] == "verifies"}
        self.assertIn((impl_id, verify_id), verifies, "verify edge must originate at the exact impl node")
        # and NOT from the phase node (that's the fallback we improved away from)
        self.assertNotIn(("wf_lbl-p0", verify_id), verifies)


class ParseAfter(unittest.TestCase):
    def test_marker_parsing(self):
        self.assertEqual(lw._parse_after("(after: 2, 3) do it"), [2, 3])
        self.assertEqual(lw._parse_after("no marker here"), [])
        self.assertEqual(lw._strip_after("(after: 1) label"), "label")


class CanvasCommandSecurity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        lw.LEO = self.tmp
        with open(os.path.join(self.tmp, "PLAN.md"), "w") as f:
            f.write("# Plan\n- [ ] one\n- [ ] two\n")

    def _tokens_present(self):
        return [t for t in ("ALLOW_GIT", "ALLOW_PUSH", "STOP") if os.path.exists(os.path.join(self.tmp, t))]

    def test_conductor_command_written(self):
        code, res = lw.apply_canvas_command({"cmd": "kill-item", "nodeId": "item-2", "source": "conductor"})
        self.assertEqual(code, 200)
        with open(os.path.join(self.tmp, "commands.jsonl")) as f:
            self.assertIn('"index": 2', f.read())

    def test_workflow_directive_written(self):
        code, res = lw.apply_canvas_command({"cmd": "inject", "nodeId": "wf_x-p0-a0", "source": "workflow:wf_x", "text": "note"})
        self.assertEqual(code, 200)
        self.assertEqual(res["applied"], "directive")
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, "workflow-directives.json")))

    def test_redteam_unknown_command_rejected_no_token(self):
        for bad in ({"cmd": "allow_git", "nodeId": "item-1"},
                    {"cmd": "ALLOW_PUSH"},
                    {"cmd": "unlink", "path": "x"},
                    {"cmd": "redirect", "nodeId": "item-1", "text": "x", "allowGit": True}):
            lw.apply_canvas_command(bad)
        # the only accepted one above (redirect w/ text) writes commands.jsonl, never a token
        self.assertEqual(self._tokens_present(), [], "a canvas command must never create a git-unlock token")

    def test_redirect_requires_text(self):
        code, res = lw.apply_canvas_command({"cmd": "redirect", "nodeId": "item-1", "source": "conductor"})
        self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
