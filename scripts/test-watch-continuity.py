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

And the API-ERROR ladder (`stopped_reason: api_error`, written by hooks/stop-failure.sh):
  - retryable + continuity auto -> exactly one stub spawn past the first delay, one
    `api_error_relaunch` event with attempt 1
  - the backoff doubles and every rung after the first is floored at the reactivation
    grace: 30 120 120 240 480, and nothing fires before its delay
  - a child that is still STARTING UP when the next rung would come due is never joined
    by a second spawn (the grace floor)
  - five attempts spent -> no spawn, one `api_error_relaunch_refused` reason `attempts`
  - a non-retryable class is refused ONCE, by name, per class
  - exactly-once across a watcher restart (the record is state.json, not memory)
  - `windows` is never touched, and a `context_budget` roll still behaves byte-for-byte
    as it did before the ladder existed

MUTATION-VERIFIED (each reintroduced, watched fail, restored):
  - drop the `api_error` branch from continuity_tick -> the ladder tests fail (idle)
  - make the backoff constant instead of doubling -> the ladder test fails on delay 3
  - drop the reactivation floor from _api_error_delay (and the _api_error_hold belt) ->
    the mid-startup test fails: a second `claude -p /leopold-run` is spawned 60s into
    attempt 1's child
  - drop the attempt ceiling -> the `attempts` refusal test fails (it spawns)
  - relax the `retryable is not True` check -> the per-class refusal tests fail
  - write `windows` on the api_error path -> the windows-untouched test fails
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


def api_error_state(at, retryable=True, etype="rate_limit", **over):
    """The state hooks/stop-failure.sh leaves behind: active false, stopped_reason
    api_error, the classified error block — and NO window field touched."""
    st = {
        "active": False,
        "stopped_reason": "api_error",
        "api_error": {"type": etype, "at": at, "retryable": retryable,
                      "hint": "wait for the limit to clear, then /leopold-run"},
        "iteration": 7,
        "max_iterations": 50,
        "windows": 2,
        "window_zero_streak": 0,
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


class ApiErrorLadder(ContinuityBase):
    """`stopped_reason: api_error` is a wait, not a verdict — up to five relaunches on a
    doubling backoff, and never a window charged for the API's mistake."""

    def stamp(self, ago=0):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - ago))

    def api(self, ago=40, **over):
        """A retryable api_error stop whose error is `ago` seconds old (40 > the 30s
        first delay, so the first attempt is due)."""
        self.set_state(api_error_state(self.stamp(ago), transcript_path=self.transcript,
                                       **over))

    def test_first_attempt_fires_once_past_the_first_delay(self):
        """@scenario retryable api_error + continuity auto, past the first delay ->
        exactly one stub `claude` spawn and one api_error_relaunch with attempt 1."""
        self.api()
        self.assertEqual(self.lw.continuity_tick(), "api_relaunched:claude")
        calls = self.stub_calls(wait=5.0)
        self.assertEqual(len(calls), 1, "expected exactly one stub invocation: %r" % calls)
        self.assertIn("claude --dangerously-skip-permissions -p /leopold-run", calls[0])
        ev = self.events("api_error_relaunch")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["attempt"], 1)
        self.assertEqual(ev[0]["delay"], 30)
        self.assertEqual(ev[0]["error_type"], "rate_limit")
        self.assertEqual(ev[0]["harness"], "claude")
        st = self.state()
        self.assertEqual(st["api_error_attempts"], 1)
        self.assertEqual(st["api_error_result"], "fired:claude")
        # The next attempt is scheduled, not fired: a second tick waits.
        v = self.lw.continuity_tick()
        self.assertTrue(v.startswith("api_waiting:"), v)
        time.sleep(0.3)
        self.assertEqual(len(self.stub_calls()), 1)
        self.assertEqual(len(self.events("api_error_relaunch")), 1)

    def test_nothing_fires_before_the_delay(self):
        self.api(ago=0)
        v = self.lw.continuity_tick(spawn=self.spawn)
        self.assertTrue(v.startswith("api_waiting:"), v)
        self.assertLessEqual(int(v.split(":")[1]), 30)
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.events(), [])
        # The due time is recorded exactly once and re-read, never recomputed forward.
        due = self.state()["api_error_next_at"]
        self.assertTrue(self.lw.continuity_tick(spawn=self.spawn).startswith("api_waiting:"))
        self.assertEqual(self.state()["api_error_next_at"], due)
        self.assertEqual(self.state().get("api_error_attempts", 0), 0)

    def test_the_backoff_doubles_and_stops_at_five(self):
        self.api()
        for n, delay in enumerate([30, 120, 120, 240, 480], start=1):
            st = self.state()
            # Make attempt n due: the ladder's reference is the last attempt's stamp.
            st.pop("api_error_next_at", None)
            if n > 1:
                st["api_error_relaunch_at"] = self.stamp(ago=delay + 1)
            self.set_state(st)
            self.assertEqual(self.lw.continuity_tick(spawn=self.spawn),
                             "api_relaunched:claude", "attempt %d" % n)
        self.assertEqual([e["delay"] for e in self.events("api_error_relaunch")],
                         [30, 120, 120, 240, 480])
        self.assertEqual([e["attempt"] for e in self.events("api_error_relaunch")],
                         [1, 2, 3, 4, 5])
        self.assertEqual(len(self.spawned), 5)
        # ...and the sixth is refused by the ceiling, once.
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_refused:attempts")
        self.assertEqual(len(self.spawned), 5)

    def test_a_child_still_starting_up_is_never_joined_by_a_second_spawn(self):
        """The relaunched agent gets the same reactivation grace the roll path gives it:
        no rung comes due inside CONTINUITY_REACTIVATE_SECS of the spawn before it.

        Without the floor, attempt 2 is due 60s after attempt 1 — half the grace the file
        itself says a child may need to flip `active: true` — and the watcher puts a
        second `claude -p /leopold-run` on the same checkout while the first is still
        starting: two owners racing on state.json."""
        grace = self.lw.CONTINUITY_REACTIVATE_SECS
        self.api()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_relaunched:claude")
        self.assertEqual(len(self.spawned), 1)
        # The child is alive but still starting: `active` is not yet true, the stop is
        # still on the state, and the unfloored 60s rung would already be due.
        st = self.state()
        st["api_error_relaunch_at"] = self.stamp(ago=grace - 30)
        st["api_error_next_at"] = self.stamp(ago=5)      # an older watcher's stamp
        self.set_state(st)
        v = self.lw.continuity_tick(spawn=self.spawn)
        self.assertTrue(v.startswith("api_waiting:"), v)
        self.assertGreater(int(v.split(":")[1]), 0)
        self.assertEqual(len(self.spawned), 1, "a second agent joined a starting child")
        self.assertEqual(len(self.events("api_error_relaunch")), 1)
        # The pill agrees with the gate: it never counts down to 0 while the hold holds.
        self.assertGreater(self.lw._api_retry(self.state())["secs"], 0)
        # Past the grace, the ladder resumes.
        st = self.state()
        st["api_error_relaunch_at"] = self.stamp(ago=grace + 1)
        self.set_state(st)
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_relaunched:claude")
        self.assertEqual(len(self.spawned), 2)

    def test_the_grace_floor_is_the_roll_paths_grace(self):
        """One constant, not two: the ladder's floor IS CONTINUITY_REACTIVATE_SECS."""
        self.assertEqual(self.lw._api_error_delay(1), 30)
        for n in (2, 3):
            self.assertEqual(self.lw._api_error_delay(n),
                             max(30 * 2 ** (n - 1), self.lw.CONTINUITY_REACTIVATE_SECS))
        self.assertEqual([self.lw._api_error_delay(n) for n in range(1, 6)],
                         [30, 120, 120, 240, 480])

    def test_five_attempts_spent_refuses_with_reason_attempts(self):
        """@scenario five failed attempts recorded -> no spawn, one refusal, reason
        `attempts`."""
        self.api(api_error_attempts=5, api_error_result="fired:claude",
                 api_error_relaunch_at=self.stamp(ago=600))
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_refused:attempts")
        self.assertEqual(self.spawned, [])
        ev = self.events("api_error_relaunch_refused")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["reason"], "attempts")
        self.assertIn("5 of 5", ev[0]["detail"])
        # Said once. A refusal is final for this stop; it is not re-logged every 2s.
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "already_handled")
        self.assertEqual(len(self.events("api_error_relaunch_refused")), 1)

    def test_a_non_retryable_class_is_refused_once_by_name(self):
        for cls in ("authentication_failed", "billing_error", "invalid_request_error",
                    "something_leopold_has_never_seen"):
            with self.subTest(cls):
                os.path.isfile(os.path.join(self.leo, "events.jsonl")) and \
                    os.remove(os.path.join(self.leo, "events.jsonl"))
                self.api(retryable=False, etype=cls)
                self.assertEqual(self.lw.continuity_tick(spawn=self.spawn),
                                 "api_refused:not_retryable")
                ev = self.events("api_error_relaunch_refused")
                self.assertEqual(len(ev), 1)
                self.assertEqual(ev[0]["reason"], "not_retryable")
                self.assertEqual(ev[0]["error_type"], cls, "the refusal names the class")
                self.assertIn(cls, ev[0]["detail"])
                self.assertEqual(self.spawned, [])
                self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "already_handled")
                self.assertEqual(len(self.events("api_error_relaunch_refused")), 1)

    def test_exactly_once_across_a_watcher_restart(self):
        self.api()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_relaunched:claude")
        fresh = load_watch()          # the restart: no in-memory state survives
        self.point(fresh)
        fired = []
        self.assertTrue(fresh.continuity_tick(spawn=fired.append).startswith("api_waiting:"))
        self.assertEqual(fired, [])
        self.assertEqual(len(self.events("api_error_relaunch")), 1)

    def test_windows_is_never_touched_by_the_ladder(self):
        self.api()
        for _ in range(2):
            self.lw.continuity_tick(spawn=self.spawn)
        st = self.state()
        self.assertEqual(st["windows"], 2, "an API error is not a context roll")
        self.assertEqual(st["iteration"], 7, "a failed turn is not a turn")
        self.assertNotIn("relaunch_window", st, "the roll's record belongs to the roll")
        self.assertEqual(self.events("window_relaunch"), [])

    def test_no_checkpoint_is_needed_for_an_api_error(self):
        # The roll's checkpoint gate does not apply: the window did not roll, so there is
        # nothing to hand the next one — the run resumes from the brief and the plan.
        os.remove(os.path.join(self.leo, "CHECKPOINT.md"))
        self.api()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_relaunched:claude")

    def test_codex_session_relaunches_on_codex(self):
        self.write_transcript_codex()
        self.api()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_relaunched:codex")
        self.assertEqual(self.events("api_error_relaunch")[0]["harness"], "codex")

    def test_spawn_failure_is_loud_and_never_retried_blindly(self):
        def boom(argv):
            raise OSError("no such binary")
        self.api()
        self.assertEqual(self.lw.continuity_tick(spawn=boom), "api_refused:spawn_failed")
        ev = self.events("api_error_relaunch_refused")
        self.assertEqual(len(ev), 1)
        self.assertIn("no such binary", ev[0]["detail"])
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "already_handled")

    def test_the_pill_reports_the_next_retry(self):
        self.api(ago=0)
        self.lw.continuity_tick(spawn=self.spawn)          # schedules, does not fire
        snap = self.lw.snapshot()
        self.assertEqual(snap["stopped_reason"], "api_error")
        self.assertEqual(snap["api_retry"]["attempt"], 1)
        self.assertEqual(snap["api_retry"]["max"], 5)
        self.assertLessEqual(snap["api_retry"]["secs"], 30)
        # Nothing to retry -> nothing claimed.
        self.api(retryable=False)
        self.assertIsNone(self.lw.snapshot()["api_retry"])
        self.set_state(rolled_state(transcript_path=self.transcript))
        self.assertIsNone(self.lw.snapshot()["api_retry"])

    def test_the_page_renders_the_retry_countdown_and_both_events(self):
        # The pill reads `stopped · api_error (retry in Ns)`; the feed knows both events.
        self.assertIn('" (retry in "+r.secs+"s)"', self.lw.PAGE)
        for name in ("api_error_relaunch", "api_error_relaunch_refused"):
            self.assertIn(name, self.lw.EVENTS, "the watch registry must carry %s" % name)
            sev, meaning = self.lw.EVENTS[name]
            self.assertIn(sev, ("crit", "high", "med", "low", "info"))
            self.assertTrue(meaning.strip())


class ApiErrorGates(ContinuityBase):
    """The kill switch, `continuity: manual`, freshness and `max_windows`, in today's
    order — the same four the roll passes through."""

    def stamp(self, ago=0):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - ago))

    def api(self, ago=40, **over):
        self.set_state(api_error_state(self.stamp(ago), transcript_path=self.transcript,
                                       **over))

    def test_manual_never_relaunches_and_never_records(self):
        self.write(".leopold/GUARDRAILS.md",
                   "# Guardrails\n- continuity: manual\n- max_windows: 10\n")
        self.api()
        before = self.state()
        for _ in range(3):
            self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "manual")
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.events(), [])
        self.assertEqual(self.state(), before)

    def test_kill_switch_beats_auto_without_consuming_an_attempt(self):
        self.api()
        open(os.path.join(self.leo, "STOP"), "a").close()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "kill_switch")
        st = self.state()
        self.assertNotIn("api_error_attempts", st)
        self.assertNotIn("api_error_result", st)
        os.remove(os.path.join(self.leo, "STOP"))
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_relaunched:claude")

    def test_a_stale_api_error_belongs_to_a_human(self):
        self.api(ago=7200)
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_refused:stale_error")
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.events("api_error_relaunch_refused")[0]["reason"], "stale_error")

    def test_max_windows_still_refuses(self):
        self.api(windows=3, max_windows=2)
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "api_refused:max_windows")
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.state()["windows"], 3, "the refusal does not charge a window")

    def test_no_open_items_is_idle(self):
        self.write(".leopold/PLAN.md", "# Plan\n\n- [x] all done\n")
        self.api()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "idle")
        self.assertEqual(self.events(), [])

    def test_an_active_run_is_idle(self):
        self.api(active=True)
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "idle")
        self.assertEqual(self.events(), [])


class RollIsUnchangedByTheLadder(ContinuityBase):
    """The regression the ladder must not cause: a `context_budget` roll writes exactly
    the record it always wrote, logs exactly the event it always logged, and gains no
    api_error field."""

    def test_a_roll_records_and_logs_byte_for_byte_what_it_always_did(self):
        before = self.state()
        self.assertEqual(self.lw.continuity_tick(spawn=self.spawn), "relaunched:claude")
        after = self.state()
        self.assertEqual(sorted(set(after) - set(before)),
                         ["relaunch_at", "relaunch_result", "relaunch_window"])
        self.assertEqual({k: v for k, v in after.items() if k in before}, before,
                         "a roll changes nothing that was already in state.json")
        self.assertEqual(after["relaunch_window"], 2)
        self.assertEqual(after["relaunch_result"], "fired:claude")
        ev = self.events()
        self.assertEqual(len(ev), 1)
        self.assertEqual(sorted(ev[0]), ["binary", "event", "harness", "ts", "window"])
        self.assertEqual(ev[0]["event"], "window_relaunch")
        self.assertEqual(self.lw.snapshot()["api_retry"], None)


class TimestampZones(ContinuityBase):
    """The stamps the hooks write are UTC (`date -u`), and the monitor must read them as
    UTC on ANY machine. Parsing them with `time.mktime(...) - time.timezone` was wrong on
    every zone observing DST: `time.timezone` is the STANDARD-time offset, so a summer
    stamp landed an hour early, every ladder deadline read an hour past due, and the
    freshness gate refused the first attempt with `stale_error` instead of relaunching.
    CI runs in UTC, which hid it — so the zone is a parameter here.

    Mutation check: restore `time.mktime(str) - time.timezone` in _parse_ts and
    test_the_first_attempt_still_fires_in_every_zone fails on the DST zones (a refusal
    verdict `api_refused:stale_error`), while UTC and Asia/Kolkata still pass.
    """

    # A summer-DST zone west and east of UTC, a half-hour zone with no DST, and UTC.
    ZONES = ("UTC", "America/New_York", "Europe/Berlin", "Asia/Kolkata",
             "Pacific/Auckland")

    def use_zone(self, tz):
        """Point the process at `tz` and hand back a module that parsed its own clock
        under it (restored for the next case by the cleanup)."""
        prev = os.environ.get("TZ")

        def restore():
            if prev is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = prev
            time.tzset()

        self.addCleanup(restore)
        os.environ["TZ"] = tz
        time.tzset()
        mod = load_watch()
        self.point(mod)
        return mod

    def test_a_utc_stamp_round_trips_in_every_zone(self):
        # A January instant and a July one: any zone with DST answers differently for
        # the two under the old arithmetic, and identically under timegm.
        for epoch in (1767225600, 1751328000):     # 2026-01-01Z and 2025-07-01Z
            for tz in self.ZONES:
                mod = self.use_zone(tz)
                stamp = mod._utc(epoch)
                self.assertEqual(mod._parse_ts(stamp), epoch,
                                 "%s misread %s" % (tz, stamp))

    def test_the_first_attempt_still_fires_in_every_zone(self):
        """@scenario retryable api_error 40s old, continuity auto, on a DST machine ->
        one spawn and one api_error_relaunch with attempt 1, never `stale_error`."""
        for tz in self.ZONES:
            mod = self.use_zone(tz)
            log = os.path.join(self.leo, "events.jsonl")
            if os.path.isfile(log):
                os.remove(log)
            spawned = []
            at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 40))
            self.set_state(api_error_state(at, transcript_path=self.transcript))
            self.assertEqual(mod.continuity_tick(spawn=spawned.append),
                             "api_relaunched:claude", tz)
            self.assertEqual(len(spawned), 1, tz)
            ev = self.events("api_error_relaunch")
            self.assertEqual([e["attempt"] for e in ev], [1], tz)
            self.assertEqual(ev[0]["delay"], 30, tz)
            self.assertEqual(self.events("api_error_relaunch_refused"), [], tz)

    def test_a_roll_still_relaunches_in_every_zone(self):
        """The same helper carries the roll path's freshness window; it must not refuse
        a 10s-old roll in a DST zone either."""
        for tz in self.ZONES:
            mod = self.use_zone(tz)
            last = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 10))
            self.set_state(rolled_state(transcript_path=self.transcript, last_turn=last))
            spawned = []
            self.assertEqual(mod.continuity_tick(spawn=spawned.append),
                             "relaunched:claude", tz)
            self.assertEqual(len(spawned), 1, tz)


if __name__ == "__main__":
    unittest.main(verbosity=2)
