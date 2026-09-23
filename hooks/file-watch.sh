#!/usr/bin/env bash
# Leopold's second-writer detector: FileChanged, Claude Code only.
#
# WHAT IT IS FOR. The run writes its own record — `.leopold/PLAN.md` is the plan it ticks,
# `.leopold/DECISIONS.md` the reasoning it leaves behind — and until now nothing anywhere
# noticed when SOMETHING ELSE wrote them mid-run. A second window, a `sed` in another
# terminal, an editor with the file open: the run would keep conducting from a plan that
# had changed under it, and the only trace would be a diff nobody read. This hook makes
# that visible. It WARNS and it never blocks: the owner rule already keeps a run to one
# executor (hooks/stop-continuity.sh), and the human editing the plan on purpose is a
# thing that happens — the charter's own example for this event is to say so and leave the
# write alone.
#
# THE FACTS IT RIDES ON, all from live captures. The section names below are
# docs/reference/hook-events.md; the rows are hooks/hook-matrix.tsv, capability
# `file-watch`; the fork is .leopold/DECISIONS.md, "file-watch — Claude Code only".
#
#   THE PAYLOAD IS `file_path` + `event` AND NOTHING ELSE (#filechanged-claude-code).
#   There is no field that separates the session's own Edit from another process's
#   append — the two produce byte-identical payload shapes. So "was this us?" is answered
#   by CORRELATION, not by a field, and that makes it a HEURISTIC, not a payload fact:
#   an own-edit stamp within FW_OWN_WINDOW seconds of this delivery is read as the run's
#   own write. See `own_edits` below for how the stamp gets there and what it costs.
#
#   THE MATCHER IS A LITERAL FILE NAME, AND IT TAKES TWO ENTRIES PER FILE. Probed live
#   here on Claude Code 2.1.260, four wirings, one headless session each (an Edit of
#   .leopold/PLAN.md and of .leopold/DECISIONS.md, then a `sleep` during which another
#   process appended to both):
#       matcher `PLAN.md|DECISIONS.md`            (one entry, alternation)  -> fired 0
#       matcher `PLAN.md` + `DECISIONS.md`        (basenames only)          -> fired 0
#       matcher `.leopold/PLAN.md` + `.leopold/DECISIONS.md` (paths only)   -> fired 0
#       all four (path-shaped AND basename-shaped)                          -> fired 8
#   The path-shaped entry REGISTERS the watch and never fires; the basename-shaped entry
#   RECEIVES every change to a watched file of that name. Neither works alone, and an
#   ALTERNATION MATCHES NOTHING — which is why extensions/lib/harness.sh wires four
#   literal FileChanged entries for two files instead of one clever regex. A matcher that
#   silently matches nothing is exactly the degradation this project bans.
#
#   EVERY CHANGE IS DELIVERED TWICE. Same probe: 2 firings per logical write, ~11ms apart
#   (and PreToolUse/PostToolUse doubled identically in that session, so it is the
#   harness's delivery, not this event's). One external write must not produce two
#   warnings, so the hook de-duplicates against its own last event — see FW_DEDUPE_WINDOW.
#   The two deliveries are two PROCESSES, so the fold is taken under the run's state lock:
#   an unlocked read-then-append lets the second one read before the first one writes, and
#   both warn. See the critical section below for the measurement.
#
#   ORDER: PostToolUse LANDS FIRST. Measured in the same run: the Edit's PostToolUse fired
#   at t+0.196s and its FileChanged at t+0.813s — 0.6s later, every time. That is what
#   makes the correlation possible at all: by the time this hook reads the stamp, the
#   receipt hook has already written it.
#
#   A `cd` IN THE SESSION DETACHES THE WATCHES (#filechanged-claude-code, run
#   filechanged-cwd: 0 firings after `cd sub`). Nothing here can fix that; it is recorded
#   in the matrix note and in the docs so a silent stop is not read as silence.
#
# WHICH FILES. `.leopold/PLAN.md` and `.leopold/DECISIONS.md`.
#
#   `.leopold/state.json` IS DELIBERATELY NOT WATCHED, and this is a deviation from the
#   item's own wording, recorded in .leopold/DECISIONS.md. The run's own hooks are that
#   file's dominant writers — the Stop hook, the receipts, the subagent ledger and the
#   compaction checkpoint rewrite it several times a turn, from processes with no tool
#   call and therefore no own-edit stamp to correlate against — so watching it would log
#   `external_write` for the run's own bookkeeping many times per turn. A detector that
#   cries wolf every turn is worse than no detector: the one signal it exists to carry
#   would be buried in its own noise. The second-writer bound on state.json is already
#   enforced in CODE and has been since the 2026-09-02 incident: ownership is compared on
#   every stop (`foreign_stop`, `owner_takeover`, `owner_unknown` in
#   hooks/stop-continuity.sh) and by scripts/leopold-owner.sh before a run is activated.
#   docs/reference/hooks.md says so where a reader will look for it.
#
# SCOPE, in order (each case has a test in scripts/test-hooks.sh):
#   no .leopold/state.json, state that does not parse, run not active, or a session that
#     is not the run's                  -> silent. Inert without an active run, and a
#                                          stranger's session does not warn about this
#                                          run's files. Ownership comes from
#                                          leo_hook_gate (hooks/_lib.sh), the one reader.
#   anything but FileChanged            -> silent.
#   a path that is not a watched file   -> silent (the basename matcher also delivers a
#                                          root-level PLAN.md; the path is re-checked
#                                          here, lexically).
#   an own edit inside the window       -> silent. The run's `[x]` flips are not tampering.
#   a repeat delivery of the same change -> silent (one warning per change).
#   anything else                       -> `external_write` + a systemMessage warning,
#                                          and the write is never blocked.
#
# WHAT IT NEVER DOES: block (there is no reply that could, and the charter forbids it
# here), write state.json (it only READS `own_edits`; it takes the state lock to make its
# own de-duplication atomic, and releases it), or read the file's contents. A
# detector that opened PLAN.md would be re-interpreting what changed; this one reports
# THAT it changed and lets the run look.

input="$(cat 2>/dev/null || true)"

# How close an own-edit stamp has to be to count as "this delivery is our own write".
# Sized from the measurement above (0.6s between PostToolUse and FileChanged) with room
# for a loaded machine; the stamps are one-second grained, so 2 is the smallest honest
# value. The cost is stated rather than hidden: an external write to a file THIS RUN
# edited less than 2 seconds ago is read as the run's own and not reported. That is the
# direction the plan asks for — the run's own paperwork must never read as tampering —
# and the miss is bounded to a two-second shadow behind each of the run's own edits.
FW_OWN_WINDOW=2
# One warning per change, not one per delivery: the harness delivers each change twice
# (~11ms apart, measured). A second `external_write` for the same file inside this window
# is the same change arriving again. A genuinely separate external write within one second
# of another one, on the same file, is folded into the first warning — a warning about the
# file, not a byte count, so nothing is lost that the run acts on.
FW_DEDUPE_WINDOW=1

# The shared gate/lock/event library, resolved beside THIS script so the installed asset
# home works exactly like the checkout. Missing means a broken install: say so where a
# person will see it and let the harness carry on — this hook warns, it never refuses, and
# an unwritten warning is not worth interrupting a run for.
_LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
if [ -r "$_LEO_LIB" ]; then
  # shellcheck source=_lib.sh
  . "$_LEO_LIB"
else
  # Only where Leopold has something to say: the library is what establishes scope, so its
  # absence is checked against the one thing a hook can read without it — a
  # .leopold/state.json in the payload's cwd. A broken install must not print into every
  # session on the machine.
  _cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${_cwd:-}" ] || _cwd="$PWD"
  [ -f "$_cwd/.leopold/state.json" ] || exit 0
  echo "Leopold: hooks/_lib.sh is missing beside file-watch.sh — a second writer on this run's plan or decisions is NOT being detected. Re-run the Leopold installer, then: leopold doctor" >&2
  exit 0
fi

# Active run, conducted by the session in this payload, or nothing at all. Without
# `report` this exits silently on every no — the continuity direction, and the right one
# for a detector that only ever warns.
leo_hook_gate "$input"

# Wired on one event; the name is checked anyway, because a hook that acts on a payload it
# was not written for is how one bad wiring becomes a false alarm.
case "${LEO_EVENT:-}" in FileChanged) ;; *) exit 0 ;; esac

fw_path="$(printf '%s' "$input" | jq -r '.file_path // ""' 2>/dev/null || true)"
[ -n "$fw_path" ] || exit 0

# The watched set, re-checked here rather than trusted from the wiring: the basename-
# shaped entry that RECEIVES also delivers a `PLAN.md` in the project root (the probe's
# own control file), and a root plan is not the run's plan. Matched on the path's tail,
# not on an absolute prefix, because the harness reports the resolved path
# (`/private/tmp/...` for a `/tmp/...` project) and a prefix compare would answer "not
# ours" for the run's own directory.
case "$fw_path" in
  */.leopold/PLAN.md)      fw_file="PLAN.md" ;;
  */.leopold/DECISIONS.md) fw_file="DECISIONS.md" ;;
  *) exit 0 ;;
esac

# Everything at or after this instant counts as "just now". Computed as an ISO string so
# it compares against the stamps with the same lexicographic `>` the evidence gate uses —
# ISO-8601 UTC sorts chronologically, and portable bash has no date arithmetic. BSD
# (`-v-2S`) and GNU (`-d '2 seconds ago'`) spell it differently and neither is everywhere;
# if both fail, the cutoff collapses to `now`, which degrades this to "the same second"
# rather than to a wrong answer.
fw_cutoff() { # <seconds back>
  date -u -v-"$1"S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "$1 seconds ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || echo ''
}

# ---- was this the run's own write? ---------------------------------------------------
# `own_edits` is the map hooks/verify-receipt.sh stamps on every successful edit tool call
# that touched a file INSIDE `.leopold/` — basename -> the second it landed. It is the
# exact complement of that hook's `last_edit_at`, which is deliberately the last edit
# OUTSIDE `.leopold/` (the run's own paperwork must not make the evidence gate ask for a
# later verification). One writer, one field, and this is its only reader.
#
# A missing stamp is not a fault: a run that has not edited the file yet has no entry, and
# the write is therefore not ours. A stamp we cannot parse is treated the same way — the
# warning direction, because a detector that goes quiet on a bad read detects nothing.
#
# THE STAMP IS VALIDATED BEFORE IT IS COMPARED, and that is not defensive dressing. The
# comparison below is lexicographic (`>` on ISO strings), so ANY string that sorts at or
# after the cutoff would silence this hook — and unlike the two-second shadow, that
# silence would be PERMANENT, because a garbage stamp never falls out of the window. That
# hands the disarm to exactly the writer this detector exists to catch: a second writer
# who can append to `.leopold/PLAN.md` can also write one field of `.leopold/state.json`,
# and `own_edits.PLAN.md = "unknown"` (or `"9999-01-01T00:00:00Z"`) would turn the
# detector off for good, silently, which is the degradation this project bans. So:
#
#   * SHAPE. Only `YYYY-MM-DDTHH:MM:SSZ` — the one format hooks/verify-receipt.sh writes
#     and the only one this comparison is meaningful over — is read as a stamp. Anything
#     else is treated as no stamp at all, which is the warning direction the paragraph
#     above promises.
#   * UPPER BOUND. A stamp AFTER now is not a record of an edit that already happened:
#     both writers call `date -u` on this machine, so the receipt hook cannot stamp the
#     future. It is a clock that jumped or a hand that wrote it, and neither is evidence
#     that this change was ours. Bounded above, the window is a real window in both
#     directions and no single value can hold it open.
own_at="$(jq -r --arg f "$fw_file" '.own_edits[$f] // ""' "$LEO_STATE" 2>/dev/null || true)"
case "$own_at" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
  *) own_at="" ;;
esac
if [ -n "$own_at" ]; then
  own_now="$(fw_cutoff 0)"
  if [ -n "$own_now" ] && [[ "$own_at" > "$own_now" ]]; then own_at=""; fi
fi
if [ -n "$own_at" ]; then
  own_cut="$(fw_cutoff "$FW_OWN_WINDOW")"
  if [ -n "$own_cut" ] && [[ ! "$own_cut" > "$own_at" ]]; then exit 0; fi
fi

# ---- one warning per change ----------------------------------------------------------
# The harness delivers each change twice. The run's own log is the memory: the last
# `external_write` for this file, if it is inside FW_DEDUPE_WINDOW, is this same change
# arriving again. Read from the tail — the log is append-only and a run writes a lot of it
# — and any failure to read falls through to warning, which is the direction a detector
# fails in.
#
# THE READ AND THE APPEND ARE ONE CRITICAL SECTION, under the run's state lock. The two
# deliveries this fold exists for arrive ~11ms apart and are two PROCESSES, not two turns:
# an unlocked read-then-append lets the second one's read land before the first one's
# write and both warn. Measured here against this hook before the lock: two simultaneous
# deliveries produced 2 `external_write` events in 5/5 trials, and a single invocation
# takes ~78ms end to end against an 11ms delivery gap — so even the sequential case had no
# margin on a loaded machine. "One write is one warning" is stated as fact in this header
# and in docs/reference/hooks.md, so it is enforced rather than hoped for.
#
# The lock is hooks/_lib.sh's, on $LEO_DIR/.state.lock — the one lock, not a second
# private one, so that a state writer and this reader cannot interleave either. It is why
# leo_core_hook_specs wires the four FileChanged entries at 10s and not 5: the lock's
# budget plus its headroom is the floor for any hook that takes it, and
# scripts/test-harness-lib.sh derives that floor rather than trusting this comment.
#
# A lock we cannot get does NOT cost the warning. The library's contract is "proceed
# unlocked and log it", and for a detector that is also the right direction: the worst an
# unlocked pass can do is warn twice about one write, and a duplicate warning is a nuisance
# where a missed one is the whole failure.
if ! leo_hook_lock; then
  leo_hook_event lock_timeout "$(jq -cn --arg f "$fw_file" '{hook:"file-watch",file:$f}' 2>/dev/null || echo '{}')"
fi

if [ -f "$LEO_DIR/events.jsonl" ]; then
  last_ext="$(tail -n 40 "$LEO_DIR/events.jsonl" 2>/dev/null \
    | jq -r --arg f "$fw_file" 'select(.event == "external_write" and .file == $f) | .ts // ""' 2>/dev/null \
    | tail -n 1 || true)"
  if [ -n "${last_ext:-}" ]; then
    dedupe_cut="$(fw_cutoff "$FW_DEDUPE_WINDOW")"
    if [ -n "$dedupe_cut" ] && [[ ! "$dedupe_cut" > "$last_ext" ]]; then
      leo_hook_unlock
      exit 0
    fi
  fi
fi

# ---- say so, loudly, and block nothing -----------------------------------------------
# The EVENT is the durable half: scripts/leopold-watch.py renders it, and it survives the
# window this warning was printed into. The systemMessage is the half a person reads in
# the moment — the capture records no honored reply for FileChanged at all
# (#filechanged-claude-code lists none), so it is sent as the harness's documented
# informational channel and the event is what this hook's tests assert on.
#
# The append closes the critical section: the lock is released AFTER it, so the next
# delivery's read sees this line. The systemMessage is written outside — it is this
# process's own stdout and nothing else can observe it.
fw_event="$(printf '%s' "$input" | jq -r '.event // ""' 2>/dev/null || true)"
leo_hook_event external_write "$(jq -cn --arg f "$fw_file" --arg p "$fw_path" --arg e "$fw_event" \
  '{file:$f,path:$p} + (if $e == "" then {} else {change:$e} end)' 2>/dev/null || echo '{}')"
leo_hook_unlock

jq -cn --arg f "$fw_file" --arg p "$fw_path" \
  '{systemMessage: ("Leopold: .leopold/" + $f + " changed and this run did not write it (" + $p + "). Nothing was blocked — re-read the file before you act on it, and check whether a second window or another process is editing this run'"'"'s brief.")}' \
  2>/dev/null || true
exit 0
