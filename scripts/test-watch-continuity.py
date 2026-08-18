#!/usr/bin/env python3
"""Tests for the watcher's continuity monitor (window-roll relaunch).

Zero dependencies (stdlib unittest). Run: python3 scripts/test-watch-continuity.py
Wired into `make test` via the `watch-test` target.

Hermetic on purpose: every test runs against a temp project, temp harness homes
(CLAUDE_HOME / CODEX_HOME / LEOPOLD_HOME / CLAUDE_CONFIG_DIR), and a REBUILT PATH
containing only stub `claude` / `codex` binaries that record their argv — nothing
here can touch a real harness, a real home, or the network.

Covers the acceptance scenarios of the relaunch item:
  - rolled window + continuity auto + gates pass -> exactly one relaunch; the
    `window_relaunch` event names window N+1 and the harness binary used
  - .leopold/STOP present -> no relaunch, `window_relaunch_refused` reason kill_switch
  - livelock gate / max_windows -> no relaunch, the reason on the event stream
  - continuity manual -> no relaunch and NO event: the stop message's resume pointer
    is the whole story
  - the same roll observed twice (watcher restart) -> still exactly one relaunch —
    the decision is recorded in state.json and re-checked, never fired blindly
plus: the codex argv, checkpoint-missing refusal, gate order (kill switch first),
spawn failure is loud, and non-roll states stay idle.
"""
import importlib.util
import json
import os
import shutil
import stat
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WATCH = os.path.join(HERE, "leopold-watch.py")


def load_watch():
    spec = importlib.util.spec_from_file_location("lw_cont", WATCH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CHECKPOINT = """# Leopold Checkpoint

## In-Flight Item
Item 2: wire the relaunch.

## Files and Code
scripts/leopold-watch.py

## Errors and Fixes
none

## Decisions This Run
none

## Learned Constraints
none

## Current Work
Detecting the roll.

## Next Step
Fire the relaunch.
"""

PLAN = """# Plan

- [x] First item, closed in window 1
- [ ] Second item, still open
"""

GUARDRAILS_AUTO = """# Guardrails

## Continuity
- continuity: auto           # auto | manual
- max_windows: 10            # total context windows one run may span
"""


def rolled_state(**over):
    st = {
        "active": False,
        "stopped_reason": "context_budget",
        "iteration": 7,
        "max_iterations": 50,
        "windows": 2,               # the hook already incremented: window 2 is next
        "window_zero_streak": 0,
        "window_plan_vector": "xo",
        "checkpoint_written": True,
    }
    st.update(over)
    return st


class ContinuityBase(unittest.TestCase):
    """Temp project + temp homes + stub binaries on a rebuilt PATH."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="leopold-watch-cont-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.project = os.path.join(self.tmp, "project")
        self.leo = os.path.join(self.project, ".leopold")
        os.makedirs(self.leo)

        # Stub harness binaries: each appends its full argv to calls.log.
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.calls = os.path.join(self.tmp, "calls.log")
        for name in ("claude", "codex"):
            p = os.path.join(self.bin, name)
            with open(p, "w", encoding="utf-8") as f:
                f.write('#!/bin/sh\nprintf \'%s\\n\' "{name} $*" >> "{log}"\n'
                        .format(name=name, log=self.calls))
            os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        # Rebuilt PATH (only the stubs) + temp homes. Restored on cleanup.
        self.env_backup = {k: os.environ.get(k) for k in
                           ("PATH", "CLAUDE_HOME", "CODEX_HOME", "LEOPOLD_HOME",
                            "CLAUDE_CONFIG_DIR")}
        self.addCleanup(self._restore_env)
        os.environ["PATH"] = self.bin
        for k in ("CLAUDE_HOME", "CODEX_HOME", "LEOPOLD_HOME", "CLAUDE_CONFIG_DIR"):
            os.environ[k] = os.path.join(self.tmp, k.lower())

        # The rolled project: brief + checkpoint + a rolled state that owns a claude
        # session (fake transcript whose first line is Claude Code shaped).
        self.transcript = os.path.join(self.tmp, "transcript.jsonl")
        self.write_transcript_claude()
        self.write(".leopold/GUARDRAILS.md", GUARDRAILS_AUTO)
        self.write(".leopold/PLAN.md", PLAN)
        self.write(".leopold/CHECKPOINT.md", CHECKPOINT)
        self.set_state(rolled_state(transcript_path=self.transcript))

        self.lw = load_watch()
        self.point(self.lw)
        # A recording spawn for the deterministic tests (the real-spawn test skips it).
        self.spawned = []
        self.spawn = self.spawned.append

    def _restore_env(self):
        for k, v in self.env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def point(self, mod):
        mod.LEO = self.leo
        mod.PROJECT = self.project

    def write(self, rel, content):
        p = os.path.join(self.project, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)

    def set_state(self, st):
        self.write(".leopold/state.json", json.dumps(st))

    def state(self):
        with open(os.path.join(self.leo, "state.json"), encoding="utf-8") as f:
            return json.load(f)

    def write_transcript_claude(self):
        with open(self.transcript, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "assistant", "sessionId": "s1", "uuid": "u1"}) + "\n")

    def write_transcript_codex(self):
        with open(self.transcript, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "session_meta",
                                "payload": {"cwd": self.project}}) + "\n")

    def events(self, kind=None):
        p = os.path.join(self.leo, "events.jsonl")
        if not os.path.isfile(p):
            return []
        out = []
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                e = json.loads(line)
                if kind is None or e.get("event") == kind:
                    out.append(e)
        return out

    def stub_calls(self, wait=0.0):
        deadline = time.time() + wait
        while True:
            if os.path.isfile(self.calls):
                with open(self.calls, encoding="utf-8") as f:
                    lines = [x for x in f.read().splitlines() if x.strip()]
                if lines or time.time() >= deadline:
                    return lines
            elif time.time() >= deadline:
                return []
            time.sleep(0.05)


class RolledWindowRelaunches(ContinuityBase):
    def test_auto_relaunch_fires_the_real_stub_exactly_once(self):
        """The headline scenario, with a REAL detached spawn against the stub PATH."""
        self.assertEqual(self.lw.continuity_tick(), "relaunched:claude")
        calls = self.stub_calls(wait=5.0)
        self.assertEqual(len(calls), 1, "expected exactly one stub invocation: %r" % calls)
        self.assertIn("claude --dangerously-skip-permissions -p /leopold-run", calls[0])
        ev = self.events("window_relaunch")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["window"], 2)          # window N+1, as the hook left it
        self.assertEqual(ev[0]["harness"], "claude")
        self.assertEqual(ev[0]["binary"], "claude")
        # The decision is durable: recorded in state.json, not in watcher memory.
        st = self.state()
        self.assertEqual(st["relaunch_window"], 2)
        self.assertEqual(st["relaunch_result"], "fired:claude")
        # A second observation of the SAME roll re-checks the record and stands down.
        self.assertEqual(self.lw.continuity_tick(), "already_handled")
        time.sleep(0.3)
        self.assertEqual(len(self.stub_calls()), 1)
        self.assertEqual(len(self.events("window_relaunch")), 1)

    def test_watcher_restart_still_exactly_one_relaunch(self):
        """A fresh watcher process (fresh module) sees the same roll: no second fire."""
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "relaunched:claude")
        self.assertEqual(len(self.spawned), 1)
        fresh = load_watch()          # the restart: no in-memory state survives
        self.point(fresh)
        fired = []
        self.assertEqual(fresh.continuity_tick(spawn=fired.append), "already_handled")
        self.assertEqual(fired, [])
        self.assertEqual(len(self.events("window_relaunch")), 1)

    def test_codex_session_relaunches_on_codex(self):
        self.write_transcript_codex()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "relaunched:codex")
        self.assertEqual(len(self.spawned), 1)
        argv = self.spawned[0]
        self.assertEqual(argv[0], "codex")
        self.assertEqual(argv[1], "exec")
        self.assertIn("--skip-git-repo-check", argv)
        self.assertIn("-C", argv)
        self.assertEqual(argv[argv.index("-C") + 1], self.project)
        ev = self.events("window_relaunch")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["harness"], "codex")
        self.assertEqual(ev[0]["binary"], "codex")

    def test_next_roll_is_a_new_decision(self):
        """Window 3's roll relaunches again even though window 2's was recorded."""
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "relaunched:claude")
        st = self.state()
        st.update({"windows": 3, "active": False, "stopped_reason": "context_budget"})
        self.set_state(st)
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "relaunched:claude")
        self.assertEqual(len(self.spawned), 2)
        self.assertEqual([e["window"] for e in self.events("window_relaunch")], [2, 3])


class GatesRefuse(ContinuityBase):
    def refused(self, reason):
        ev = self.events("window_relaunch_refused")
        self.assertEqual(len(ev), 1, "expected one refusal event: %r" % ev)
        self.assertEqual(ev[0]["reason"], reason)
        self.assertEqual(ev[0]["window"], 2)
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.events("window_relaunch"), [])

    def test_kill_switch_beats_auto_without_consuming_the_relaunch(self):
        # The old pin here made the kill-switch refusal FINAL (it consumed the
        # exactly-once record), so removing STOP left the seat empty forever with the
        # log blaming the switch. STOP is the user's hand on the plug: while present,
        # nothing fires and nothing is recorded; remove it and the decision is made
        # again — the relaunch then happens normally.
        open(os.path.join(self.leo, "STOP"), "a").close()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "kill_switch")
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "kill_switch")
        st = json.loads(open(os.path.join(self.leo, "state.json")).read())
        self.assertNotIn("relaunch_window", st, "a kill-switch wait must not consume the record")
        self.assertEqual(self.spawned, [])
        os.remove(os.path.join(self.leo, "STOP"))
        v = self.lw.continuity_tick(spawn=self.spawn)
        self.assertTrue(v.startswith("relaunched:"), v)
        self.assertEqual(len(self.spawned), 1)

    def test_kill_switch_is_checked_first(self):
        open(os.path.join(self.leo, "STOP"), "a").close()
        self.set_state(rolled_state(windows=99, window_zero_streak=5,
                                    transcript_path=self.transcript))
        v = self.lw.continuity_tick(spawn=self.spawn)
        self.assertEqual(v, "kill_switch")
        self.assertEqual(self.spawned, [])

    def test_max_windows_from_state(self):
        self.set_state(rolled_state(windows=3, max_windows=2,
                                    transcript_path=self.transcript))
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "refused:max_windows")
        ev = self.events("window_relaunch_refused")
        self.assertEqual(ev[0]["reason"], "max_windows")
        self.assertEqual(ev[0]["window"], 3)
        self.assertEqual(self.spawned, [])

    def test_max_windows_from_guardrails(self):
        self.write(".leopold/GUARDRAILS.md",
                   "# Guardrails\n- continuity: auto\n- max_windows: 1\n")
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "refused:max_windows")
        self.refused("max_windows")

    def test_livelock_gate(self):
        self.set_state(rolled_state(window_zero_streak=2,
                                    transcript_path=self.transcript))
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn),
                         "refused:no_progress_across_windows")
        self.refused("no_progress_across_windows")

    def test_checkpoint_missing_is_loud_not_silent(self):
        os.remove(os.path.join(self.leo, "CHECKPOINT.md"))
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn),
                         "refused:checkpoint_missing")
        self.refused("checkpoint_missing")

    def test_unknown_harness_refuses(self):
        with open(self.transcript, "w", encoding="utf-8") as f:
            f.write('{"type":"mystery"}\n')
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn),
                         "refused:unknown_harness")
        self.refused("unknown_harness")

    def test_spawn_failure_is_loud_and_never_retried_blindly(self):
        def boom(argv):
            raise OSError("no such binary")
        self.assertEqual(self.lw.continuity_tick(spawn=boom), "refused:spawn_failed")
        ev = self.events("window_relaunch_refused")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["reason"], "spawn_failed")
        self.assertIn("no such binary", ev[0]["detail"])
        self.assertEqual(self.events("window_relaunch"), [])
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "already_handled")


class ManualNeverRelaunches(ContinuityBase):
    def test_manual_no_relaunch_no_event_no_record(self):
        self.write(".leopold/GUARDRAILS.md",
                   "# Guardrails\n- continuity: manual\n- max_windows: 10\n")
        before = self.state()
        for _ in range(3):
            self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "manual")
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.events(), [])          # the resume pointer is the whole story
        self.assertEqual(self.state(), before)       # nothing recorded either

    def test_unrecognized_value_is_auto(self):
        # Same posture doctor reports: an unreadable line must not silently disable
        # the relaunch (auto is the default and the safe direction for continuity).
        self.write(".leopold/GUARDRAILS.md",
                   "# Guardrails\n- continuity: sometimes\n- max_windows: 10\n")
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "relaunched:claude")


class NonRollsStayIdle(ContinuityBase):
    def test_active_run_is_idle(self):
        self.set_state(rolled_state(active=True, transcript_path=self.transcript))
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "idle")
        self.assertEqual(self.events(), [])

    def test_other_stop_reasons_are_final(self):
        for reason in ("plan_complete", "iteration_budget", "kill_switch",
                       "no_progress_across_windows", "max_windows", "repeated_failure"):
            self.set_state(rolled_state(stopped_reason=reason,
                                        transcript_path=self.transcript))
            self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "idle", reason)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.spawned, [])

    def test_no_open_items_is_idle(self):
        self.write(".leopold/PLAN.md", "# Plan\n\n- [x] all done\n")
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "idle")
        self.assertEqual(self.events(), [])

    def test_no_state_and_invalid_state_are_idle(self):
        os.remove(os.path.join(self.leo, "state.json"))
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "idle")
        self.write(".leopold/state.json", "{not json")
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "idle")
        self.assertEqual(self.events(), [])


class FreshnessAndReactivation(ContinuityBase):
    def test_stale_roll_is_refused_not_relaunched(self):
        # Opening the dashboard on a project whose run rolled long ago must NOT spawn a
        # headless agent: the monitor is event-shaped, and stale state is not an event.
        st = rolled_state(transcript_path=self.transcript)
        st["last_turn"] = "2020-01-01T00:00:00Z"
        self.set_state(st)
        # state.json mtime is fresh, but last_turn is authoritative when present.
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "refused:stale_roll")
        self.assertEqual(self.spawned, [])
        ev = self.events("window_relaunch_refused")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["reason"], "stale_roll")

    def test_fresh_roll_still_relaunches(self):
        st = rolled_state(transcript_path=self.transcript)
        st["last_turn"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.set_state(st)
        v = self.lw.continuity_tick(spawn=self.spawn)
        self.assertTrue(v.startswith("relaunched:"), v)

    def test_fired_child_that_never_reactivates_is_a_named_failure(self):
        # A Popen that opened is not a seat that is taken. When the child never flips
        # the run back to active within the grace, the record turns FAILED and the event
        # stream says so — instead of already_handled forever while the seat stays empty.
        st = rolled_state(transcript_path=self.transcript)
        st["relaunch_window"] = st.get("windows", 2)
        st["relaunch_result"] = "fired:claude"
        st["relaunch_at"] = "2020-01-01T00:00:00Z"
        self.set_state(st)
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "relaunch_failed")
        ev = self.events("window_relaunch_failed")
        self.assertEqual(len(ev), 1)
        st2 = json.loads(open(os.path.join(self.leo, "state.json")).read())
        self.assertTrue(str(st2.get("relaunch_result", "")).startswith("failed:"))
        # ...and the failure is terminal for the window: no blind refire, no re-log.
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "already_handled")
        self.assertEqual(len(self.events("window_relaunch_failed")), 1)

    def test_recently_fired_is_left_alone(self):
        st = rolled_state(transcript_path=self.transcript)
        st["relaunch_window"] = st.get("windows", 2)
        st["relaunch_result"] = "fired:claude"
        st["relaunch_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.set_state(st)
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "already_handled")


if __name__ == "__main__":
    unittest.main(verbosity=2)
