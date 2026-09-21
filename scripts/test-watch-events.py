#!/usr/bin/env python3
"""Pins the watch's EVENTS registry to what the hooks actually emit.

Every event Leopold's hooks write into .leopold/events.jsonl must have a registry
entry in scripts/leopold-watch.py: a severity class and a one-line meaning. The set
of names is DERIVED here, by reading every script in hooks/ for the two literal
forms they use — jq's `event:"name"` and printf's `"event":"name"` — so a new hook
that logs a new event fails this test until the dashboard can render it with a
severity and a sentence.

Also checks the registry itself: every severity is one the page has a class for,
every meaning is a non-empty single line, and the generated page carries the object
(no unsubstituted placeholder).

HERMETIC: reads two paths in the checkout, writes nothing.

MUTATION-VERIFIED: delete one entry from EVENTS (e.g. "window_roll") and this fails
naming that event; add a new `event:"x"` literal to a hook and it fails naming x; drop the
`leo_hook_event` pattern below and the events the hooks log through hooks/_lib.sh stop
being derived at all (the count in the summary line falls).
"""
import importlib.util
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS = os.path.join(ROOT, "hooks")
WATCH = os.path.join(ROOT, "scripts", "leopold-watch.py")

# The severity classes the page defines (.sev-crit / -high / -med / -low / -info).
SEVERITIES = {"crit", "high", "med", "low", "info"}

# Three forms a hook writes an event name in:
#   jq object form      event:"name"
#   printf/JSON form    "event":"name"
#   through the library leo_hook_event name '{...}'   (hooks/_lib.sh stamps ts + session)
# The third is why this is a list: once a hook logs through leo_hook_event, its event
# names stop appearing as JSON literals anywhere in hooks/, and a deriver that only knew
# the first two forms would quietly stop deriving anything — a pin that pins nothing.
EMITTED = [
    re.compile(r'"?event"?\s*:\s*"([a-z0-9_]+)"'),
    re.compile(r'\bleo_hook_event\s+([a-z0-9_]+)'),
]
LIB_FORM = 1   # index of the hooks/_lib.sh form, asserted below to still match something

fails = []


def load_watch():
    spec = importlib.util.spec_from_file_location("leopold_watch", WATCH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hook_events():
    """Every event name a script in hooks/ emits, with its file, plus the names the
    library form (`leo_hook_event <name>`) accounted for."""
    found = {}
    by_lib = set()
    for name in sorted(os.listdir(HOOKS)):
        if not name.endswith(".sh"):
            continue
        path = os.path.join(HOOKS, name)
        with open(path, encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                # A comment is prose, not an emission: these files explain themselves at
                # length, and "leo_hook_event stamps ts and session" is a sentence, not a
                # call. Nothing is lost — a commented-out log line logs nothing.
                if line.lstrip().startswith("#"):
                    continue
                for i, pattern in enumerate(EMITTED):
                    for ev in pattern.findall(line):
                        found.setdefault(ev, "hooks/%s:%d" % (name, n))
                        if i == LIB_FORM:
                            by_lib.add(ev)
    return found, by_lib


def main():
    watch = load_watch()
    reg = watch.EVENTS
    emitted, by_lib = hook_events()

    if not emitted:
        fails.append("no event literals found in hooks/ — the deriver stopped working")
    # The library form has to keep matching. Hooks that log through hooks/_lib.sh carry no
    # JSON literal at all, so a rotted pattern here does not fail loudly — it derives
    # fewer names and passes, which is a pin that pins nothing.
    if os.path.exists(os.path.join(HOOKS, "_lib.sh")) and not by_lib:
        fails.append(
            "hooks/_lib.sh is present but no event was derived from a `leo_hook_event <name>` "
            "call — the deriver's library form has rotted and every event logged through it "
            "is now unpinned"
        )

    for ev, where in sorted(emitted.items()):
        if ev not in reg:
            fails.append(
                "hooks emit %r (%s) but scripts/leopold-watch.py EVENTS has no entry — "
                "the watch would render it with no severity and no meaning" % (ev, where)
            )

    for ev, val in sorted(reg.items()):
        if not isinstance(val, tuple) or len(val) != 2:
            fails.append("EVENTS[%r] is not (severity, meaning)" % ev)
            continue
        sev, meaning = val
        if sev not in SEVERITIES:
            fails.append("EVENTS[%r] severity %r is not one of %s" % (ev, sev, sorted(SEVERITIES)))
        if not meaning or "\n" in meaning:
            fails.append("EVENTS[%r] needs a one-line, non-empty meaning" % ev)

    if "__LEOPOLD_EVENTS__" in watch.PAGE:
        fails.append("the page still holds the __LEOPOLD_EVENTS__ placeholder — the registry never landed")
    for ev in reg:
        if '"%s"' % ev not in watch.PAGE:
            fails.append("EVENTS[%r] is missing from the generated page" % ev)

    print("watch event registry: %d registered, %d emitted by hooks (%d through hooks/_lib.sh)"
          % (len(reg), len(emitted), len(by_lib)))
    for f in fails:
        print("  FAIL: %s" % f)
    if fails:
        print("watch event registry: FAILURES")
        return 1
    print("watch event registry: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
