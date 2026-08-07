#!/usr/bin/env python3
"""Unit tests for leopold-watch.py's DAG builder and the steer write-side.

Zero dependencies (stdlib unittest). Run: python3 scripts/test-watch-graph.py
Wired into `make test` via the `watch-test` target.

Covers:
  - build_graph() edge inference (conductor (after:N) deps, workflow seq/contains/
    verifies, no dangling edges, no self-deps, empty-safe)
  - the PLAN.md graph grammar the Canvas reads: node kinds, `@on` route edges with
    their condition, `@emit`/`@needs`, and the `awaiting` state of a `@human` node
  - BACKWARD COMPATIBILITY: a plan with none of that grammar produces a payload
    byte-identical to the one this built before the grammar existed (asserted against
    a literal snapshot, so a stray new key fails the test)
  - the Python parser AGREES with the driver's TypeScript parser on the repo's own
    plan fixtures (runs when packages/driver/dist is built)
  - _parse_after marker parsing
  - apply_canvas_command routing + the RED-TEAM invariant: a canvas command never
    writes a git-unlock token (ALLOW_GIT / ALLOW_PUSH / STOP).
"""
import importlib.util
import json
import os
import subprocess
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


# --------------------------------------------------------------------------- grammar
# The Canvas must draw the graph the human AUTHORED. These tests are the contract:
# what a kind marker, a route and the state channel look like once they reach
# /api/graph — and, first, that a plan using none of them is untouched.

LEGACY_PLAN = [
    {"done": True, "text": "Build the thing"},
    {"done": False, "text": "(after: 1) Check the thing"},
]

# Exactly what build_graph() emitted for LEGACY_PLAN before the graph grammar existed.
# A new key on a node or an edge — even a harmless one — fails here, which is the point:
# "identical" is a gate, not an aspiration.
LEGACY_PAYLOAD = {
    "nodes": [
        {"id": "item-1", "kind": "item", "label": "Build the thing", "state": "done",
         "group": "plan", "tokens": 0, "toolCalls": 0, "model": "", "source": "conductor",
         "detail": ""},
        {"id": "item-2", "kind": "item", "label": "Check the thing", "state": "open",
         "group": "plan", "tokens": 0, "toolCalls": 0, "model": "", "source": "conductor",
         "detail": ""},
    ],
    "edges": [{"from": "item-1", "to": "item-2", "kind": "after"}],
    "groups": ["plan"],
}

ROUTING_PLAN_MD = """# Plan

- [x] @gate security Review the auth diff
      @emit reviewed=true
- [ ] (after: 1) Run the migration
      @needs reviewed
      @emit migrated=true
      @emit migrated=false
      @on migrated=false -> 4
- [ ] (after: 2) Ship it
- [ ] @human Decide whether to roll back
"""

LEGACY_PLAN_MD = """# Plan

- [x] Build the thing
- [ ] (after: 1) Check the thing
"""


class GraphGrammar(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old = lw.LEO
        lw.LEO = self.tmp

    def tearDown(self):
        lw.LEO = self.old

    def _plan(self, text):
        with open(os.path.join(self.tmp, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write(text)
        return lw.read_plan()["items"]

    def test_legacy_payload_is_byte_identical(self):
        self.assertEqual(lw.build_graph(LEGACY_PLAN, [], []), LEGACY_PAYLOAD)

    def test_legacy_plan_read_from_disk_builds_the_same_payload(self):
        # read_plan() now carries the grammar fields; a plan that declares none of them
        # must still reach the Canvas as the payload above, defaults and all.
        self.assertEqual(lw.build_graph(self._plan(LEGACY_PLAN_MD), [], []), LEGACY_PAYLOAD)

    def test_kinds_and_routes_reach_the_payload(self):
        items = self._plan(ROUTING_PLAN_MD)
        self.assertEqual([i["kind"] for i in items], ["gate", "work", "work", "human"])
        self.assertEqual(items[0]["kindLabel"], "security")
        self.assertEqual(items[1]["needs"], ["reviewed"])
        self.assertEqual(items[1]["emits"], ["migrated=true", "migrated=false"])
        g = lw.build_graph(items, [], [])
        by_id = {n["id"]: n for n in g["nodes"]}
        # each node's kind, as authored
        self.assertEqual(by_id["item-1"]["nodeKind"], "gate")
        self.assertEqual(by_id["item-1"]["nodeLabel"], "security")
        self.assertEqual(by_id["item-1"]["label"], "Review the auth diff")
        self.assertEqual(by_id["item-4"]["nodeKind"], "human")
        self.assertNotIn("nodeKind", by_id["item-2"], "a work node carries no kind key")
        self.assertEqual(by_id["item-2"]["needs"], ["reviewed"])
        # each route edge's condition, as authored
        routes = [e for e in g["edges"] if e["kind"] == "route"]
        self.assertEqual(routes, [{"from": "item-2", "to": "item-4", "kind": "route",
                                   "when": "migrated=false"}])
        # ...and it is NOT confused with the static dependency edges
        self.assertEqual({(e["from"], e["to"]) for e in g["edges"] if e["kind"] == "after"},
                         {("item-1", "item-2"), ("item-2", "item-3")})

    def test_human_node_awaiting_input_is_a_distinct_state(self):
        items = self._plan(ROUTING_PLAN_MD)
        ev = [{"event": "awaiting_human", "item": 4, "text": "Decide whether to roll back"}]
        by_id = {n["id"]: n for n in lw.build_graph(items, ev, [])["nodes"]}
        self.assertEqual(by_id["item-4"]["state"], "awaiting")
        self.assertEqual(by_id["item-3"]["state"], "open", "only the named item waits")
        # without the event it is an ordinary open item — the Canvas never guesses
        plain = {n["id"]: n for n in lw.build_graph(items, [], [])["nodes"]}
        self.assertEqual(plain["item-4"]["state"], "open")

    def test_route_to_a_nonexistent_item_draws_no_edge(self):
        items = self._plan("- [ ] one\n      @on fail -> 99\n- [ ] two\n")
        g = lw.build_graph(items, [], [])
        self.assertEqual([e for e in g["edges"] if e["kind"] == "route"], [])
        self.assertTrue(all(e["from"] in node_ids(g) and e["to"] in node_ids(g)
                            for e in g["edges"]))

    def test_markers_parse_the_way_the_driver_parses_them(self):
        mk = lw._item_markers
        self.assertEqual(mk("@gate security Review auth"),
                         {"deps": [], "kind": "gate", "kindLabel": "security",
                          "label": "Review auth"})
        # a capitalised word after a kind is TEXT, not a label
        self.assertEqual(mk("@human Ask the team")["kindLabel"], "")
        self.assertEqual(mk("@human Ask the team")["label"], "Ask the team")
        # inline, with nothing after it, a bare lowercase word is TEXT, not a label —
        # on a marker line of its own the same word IS the label
        self.assertEqual(mk("@gate security"), {"deps": [], "kind": "gate",
                                                "kindLabel": "", "label": "security"})
        self.assertEqual(lw._match_kind("@node human ops", False), ("human", "ops", ""))
        # the feedback node reads the RUN and may amend the plan; the Canvas draws it
        self.assertEqual(mk("@feedback health Read the run")["kind"], "feedback")
        self.assertEqual(mk("@feedback health Read the run")["kindLabel"], "health")
        self.assertEqual(lw._match_kind("@node feedback", False), ("feedback", "", ""))
        self.assertEqual(mk("@feedbacks from the beta users")["kind"], "work")
        self.assertEqual(mk("@node human ops")["kind"], "human")
        # `@node` without a known kind is prose, left alone
        self.assertEqual(mk("@node the DAG")["kind"], "work")
        self.assertEqual(mk("@node the DAG")["label"], "@node the DAG")
        # markers in either order
        self.assertEqual(mk("(after: 2) @verify Recheck")["deps"], [2])
        self.assertEqual(mk("@verify (after: 2) Recheck")["deps"], [2])
        # a second (after:) stays in the text, exactly as the driver leaves it
        self.assertEqual(mk("(after: 1) (after: 2) x")["label"], "(after: 2) x")

    def test_route_conditions_parse(self):
        r = lw._parse_route
        self.assertEqual(r("fail -> 7"), {"when": "fail", "target": 7})
        self.assertEqual(r("migrated=false → 7"), {"when": "migrated=false", "target": 7})
        self.assertEqual(r("fail => #7"), {"when": "fail", "target": 7})
        self.assertEqual(r("fail"), {"when": "fail", "target": 0})  # recorded, not dropped
        self.assertIsNone(r("   "))


class ParserAgreesWithTheDriver(unittest.TestCase):
    """The dashboard cannot import plan.ts, so it re-reads the grammar. This proves the
    two readings AGREE on the repo's own plans — the only way two parsers stay honest."""

    SCRIPT = (
        "const {parsePlanFile}=await import(process.argv[1]);"
        "const out=parsePlanFile(process.argv[2]).map(i=>({index:i.index,text:i.text,"
        "done:i.done,deps:i.deps,kind:i.kind,kindLabel:i.kindLabel,"
        "routes:i.routes.map(r=>({when:r.when,target:r.target})),"
        "emits:i.emits.map(e=>e.key+'='+e.value),needs:i.needs}));"
        "console.log(JSON.stringify(out));"
    )

    def _dist(self):
        dist = os.path.join(HERE, "..", "packages", "driver", "dist", "plan.js")
        if not os.path.isfile(dist):
            self.skipTest("driver not built (packages/driver/dist) — run `make driver-check` first")
        return os.path.abspath(dist)

    def _compare(self, dist, directory, name):
        """Parse one plan with both parsers and assert they read it the same way."""
        old = lw.LEO
        try:
            lw.LEO = directory
            self.assertTrue(lw._read(name).strip(), name)
            items = lw.read_plan(name)["items"]
        finally:
            lw.LEO = old
        proc = subprocess.run(["node", "--input-type=module", "-e", self.SCRIPT,
                               dist, os.path.join(directory, name)],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            self.skipTest("node could not run the driver parser: %s" % proc.stderr[:200])
        ts = json.loads(proc.stdout)
        self.assertEqual(len(items), len(ts), "%s: item count" % name)
        for i, (a, b) in enumerate(zip(items, ts), start=1):
            where = "%s item %d" % (name, i)
            self.assertEqual(a["done"], b["done"], where)
            self.assertEqual(a["kind"], b["kind"], where)
            self.assertEqual(a["kindLabel"], b["kindLabel"], where)
            self.assertEqual(a["needs"], b["needs"], where)
            self.assertEqual(a["emits"], b["emits"], where)
            self.assertEqual(a["routes"],
                             [{"when": r["when"], "target": r["target"]} for r in b["routes"]],
                             where)
            self.assertEqual(lw._strip_after(a["text"]), b["text"], where)
            self.assertEqual([d for d in lw._parse_after(a["text"]) if d < i], b["deps"], where)
        return len(items)

    def test_fixture_plans_parse_identically(self):
        """The repo's own archived run plans — the legacy half of the promise."""
        dist = self._dist()
        fixtures = os.path.join(HERE, "..", "packages", "driver", "test", "fixtures", "plans")
        if not os.path.isdir(fixtures):
            self.skipTest("plan fixtures missing")
        plans = sorted(f for f in os.listdir(fixtures) if f.endswith(".md"))
        self.assertTrue(plans, "no plan fixtures to compare against")
        total = sum(self._compare(dist, fixtures, name) for name in plans)
        self.assertGreaterEqual(total, 45, "expected the fixtures to cover real plans")

    def test_a_routing_plan_parses_identically(self):
        """And the new half: kinds, routes and the state channel read the same on both
        sides, including the corners (arrow spellings, labels, marker lines)."""
        dist = self._dist()
        tmp = tempfile.mkdtemp()
        plan = ROUTING_PLAN_MD + """- [ ] @tool make the build
      @on fail => 4
- [ ] @tool build: make release
- [ ] (after: 5) @verify Recheck everything
      @needs migrated, reviewed
      @on ok → 1
- [ ] @node human ops
      @on fail -> 99
"""
        with open(os.path.join(tmp, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write(plan)
        self.assertEqual(self._compare(dist, tmp, "PLAN.md"), 8)


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


def _write(path, records):
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


CODEX_ROLLOUT = [
    {"timestamp": "2026-08-03T18:00:00.000Z", "type": "session_meta",
     "payload": {"session_id": "019f-codex", "cwd": "/tmp/proj", "cli_version": "0.146.0"}},
    {"timestamp": "2026-08-03T18:00:01.000Z", "type": "turn_context",
     "payload": {"turn_id": "t1", "cwd": "/tmp/proj", "model": "gpt-5.1-codex-max"}},
    {"timestamp": "2026-08-03T18:00:05.000Z", "type": "event_msg",
     "payload": {"type": "agent_message", "message": "on it"}},
    {"timestamp": "2026-08-03T18:00:06.000Z", "type": "event_msg",
     "payload": {"type": "token_count", "info": {
         "total_token_usage": {"input_tokens": 20000, "cached_input_tokens": 8000,
                               "cache_write_input_tokens": 0, "output_tokens": 1000,
                               "reasoning_output_tokens": 400, "total_tokens": 21000},
         "last_token_usage": {"input_tokens": 20000, "cached_input_tokens": 8000,
                              "cache_write_input_tokens": 0, "output_tokens": 1000,
                              "reasoning_output_tokens": 400, "total_tokens": 21000},
         "model_context_window": 258400}}},
    {"timestamp": "2026-08-03T18:01:06.000Z", "type": "event_msg",
     "payload": {"type": "token_count", "info": {
         "total_token_usage": {"input_tokens": 50000, "cached_input_tokens": 28000,
                               "cache_write_input_tokens": 0, "output_tokens": 3000,
                               "reasoning_output_tokens": 900, "total_tokens": 53000},
         "last_token_usage": {"input_tokens": 30000, "cached_input_tokens": 20000,
                              "cache_write_input_tokens": 0, "output_tokens": 2000,
                              "reasoning_output_tokens": 500, "total_tokens": 32000},
         "model_context_window": 258400}}},
]

CLAUDE_TRANSCRIPT = [
    {"type": "user", "sessionId": "sess-1", "timestamp": "2026-08-03T18:00:00.000Z",
     "message": {"role": "user", "content": "go"}},
    {"type": "assistant", "sessionId": "sess-1", "timestamp": "2026-08-03T18:00:10.000Z",
     "message": {"model": "claude-opus-4-6", "usage": {
         "input_tokens": 1000, "output_tokens": 500,
         "cache_creation_input_tokens": 2000, "cache_read_input_tokens": 10000}}},
    {"type": "assistant", "isSidechain": True, "sessionId": "sess-1",
     "timestamp": "2026-08-03T18:00:40.000Z",
     "message": {"model": "claude-haiku-4-5", "usage": {
         "input_tokens": 300, "output_tokens": 100,
         "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}},
]


class TranscriptParsing(unittest.TestCase):
    """The dashboard must price BOTH harnesses and never fake a zero for neither."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old_leo = lw.LEO
        lw.LEO = self.tmp            # keep prices.json lookups inside the temp dir
        lw._PRICES_LOADED = None

    def tearDown(self):
        lw.LEO = self.old_leo
        lw._PRICES_LOADED = None

    def _path(self, name, records):
        p = os.path.join(self.tmp, name)
        _write(p, records)
        return p

    def test_codex_rollout_is_detected_and_priced(self):
        p = self._path("rollout-x.jsonl", CODEX_ROLLOUT)
        self.assertEqual(lw.detect_harness(p), "codex")
        c = lw.parse_transcript(p)
        self.assertTrue(c["available"])
        self.assertEqual(c["harness"], "codex")
        # cumulative snapshots -> deltas; cached tokens are billed at the cached rate
        self.assertEqual(c["tokens"]["input"], 22000)       # 50000 - 28000 uncached
        self.assertEqual(c["tokens"]["cache_read"], 28000)
        self.assertEqual(c["tokens"]["output"], 3000)
        self.assertEqual(c["tokens"]["total"], 53000)
        self.assertGreater(c["usd"], 0)
        expected = (22000 * 1.25 + 3000 * 10.0 + 28000 * 0.125) / 1e6
        self.assertAlmostEqual(c["usd"], round(expected, 4), places=4)
        self.assertEqual(c["messages"], 1)                  # one agent_message
        self.assertEqual(c["session"], "019f-codex")
        self.assertEqual(c["models"][0]["model"], "gpt-5.1-codex-max")
        self.assertEqual(c["context_tokens"], 32000)        # last_token_usage
        self.assertEqual(c["context_window"], 258400)
        self.assertEqual(c["context_pct"], 12)
        self.assertEqual(c["duration_s"], 60)

    def test_unknown_codex_model_still_costs_money(self):
        rec = [dict(r) for r in CODEX_ROLLOUT]
        rec[1] = {"timestamp": "2026-08-03T18:00:01.000Z", "type": "turn_context",
                  "payload": {"model": "gpt-9.9-unreleased"}}
        c = lw.parse_transcript(self._path("rollout-new.jsonl", rec))
        self.assertGreater(c["usd"], 0, "an unknown model must never price a run at zero")

    def test_claude_transcript_numbers_unchanged(self):
        p = self._path("claude.jsonl", CLAUDE_TRANSCRIPT)
        self.assertEqual(lw.detect_harness(p), "claude")
        c = lw.parse_transcript(p)
        # identical to what _parse_cost produced before the Codex path existed
        self.assertEqual(c, dict(lw._parse_cost(p)))
        self.assertTrue(c["available"])
        self.assertEqual(c["tokens"], {"input": 1300, "output": 600, "cache_write": 2000,
                                       "cache_read": 10000, "total": 13900})
        opus = (1000 * 15.0 + 500 * 75.0 + 2000 * 18.75 + 10000 * 1.5) / 1e6
        haiku = (300 * 1.0 + 100 * 5.0) / 1e6
        self.assertAlmostEqual(c["usd"], round(opus + haiku, 4), places=4)
        self.assertAlmostEqual(c["sub_usd"], round(haiku, 4), places=4)
        self.assertEqual(c["messages"], 2)
        self.assertEqual(c["sub_msgs"], 1)
        self.assertEqual(c["cache_hit_pct"], 75)
        self.assertEqual(c["session"], "sess-1")
        self.assertNotIn("context_window", c)   # Claude payload shape is untouched

    def test_codex_session_without_usage_yet_is_not_a_zero_cost(self):
        p = self._path("rollout-fresh.jsonl", CODEX_ROLLOUT[:1])
        c = lw.parse_transcript(p)
        self.assertFalse(c["available"])
        self.assertNotIn("usd", c)
        self.assertIn("waiting", c["reason"])

    def test_foreign_transcript_says_unavailable(self):
        p = os.path.join(self.tmp, "weird.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            f.write('{"hello":"world"}\nnot json at all\n')
        self.assertEqual(lw.detect_harness(p), "unknown")
        c = lw.parse_transcript(p)
        self.assertFalse(c["available"])
        self.assertIn("unavailable", c["reason"])
        self.assertNotIn("usd", c, "an unparseable transcript must not report a cost")

    def test_codex_transcript_discovered_by_cwd(self):
        home = os.path.join(self.tmp, "codexhome")
        d = os.path.join(home, "sessions", "2026", "08", "03")
        os.makedirs(d)
        proj = os.path.join(self.tmp, "proj")
        os.makedirs(proj)
        rec = [dict(r) for r in CODEX_ROLLOUT]
        rec[0] = {"type": "session_meta", "payload": {"session_id": "s", "cwd": proj}}
        _write(os.path.join(d, "rollout-2026-08-03T18-00-00-abc.jsonl"), rec)
        _write(os.path.join(d, "rollout-2026-08-03T19-00-00-def.jsonl"),
               [{"type": "session_meta", "payload": {"session_id": "other", "cwd": "/elsewhere"}}])
        old_proj, old_leo = lw.PROJECT, lw.LEO
        lw.PROJECT, lw.LEO = proj, os.path.join(proj, ".leopold")
        os.environ["CODEX_HOME"] = home
        os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(self.tmp, "no-claude-here")
        try:
            tp = lw.find_transcript()
            self.assertIsNotNone(tp, "a Codex-only machine must still find its transcript")
            self.assertTrue(tp.endswith("abc.jsonl"))
            self.assertEqual(lw.parse_transcript(tp)["harness"], "codex")
        finally:
            lw.PROJECT, lw.LEO = old_proj, old_leo
            os.environ.pop("CODEX_HOME", None)
            os.environ.pop("CLAUDE_CONFIG_DIR", None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
