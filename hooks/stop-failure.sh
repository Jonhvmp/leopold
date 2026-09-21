#!/usr/bin/env bash
# Leopold StopFailure hook: an API error ends the turn, and this is the only witness.
#
# THE FACT THIS RIDES ON, from the probe's live capture (docs/reference/hook-events.md,
# `StopFailure` — Claude Code): when a turn dies on an API error, `Stop` DOES NOT FIRE.
# The continuity hook — the one thing that counts a turn, notices a stop condition and
# writes `stopped_reason` — never runs. Before this hook, such a run stayed `active: true`
# in .leopold/state.json forever: `leopold watch` showed a live run, `/leopold-status`
# showed a live run, and nothing anywhere said the API had refused. `StopFailure` is the
# only event that sees the failed turn, so it is where the run is marked stopped.
#
# The payload, verbatim keys from that capture:
#   {"session_id":…,"transcript_path":…,"cwd":…,"prompt_id":…,
#    "hook_event_name":"StopFailure","error":"rate_limit","last_assistant_message":…}
# The field is `error` (NOT `error_type`), and the probe drove real 429 / 500 / 529 / 401
# responses through a stdlib stub with CLAUDE_CODE_MAX_RETRIES=0 to learn its vocabulary:
#   rate_limit             429
#   server_error           500 AND 529
#   authentication_failed  401, and a config dir with no login at all
#
# Per harness, from hooks/hook-matrix.tsv (row `api-error-stop`):
#   Claude Code 2.1.259  available   — the event above.
#   Codex CLI 0.152.1    unavailable — an API error ends a Codex run as a plain stop:
#                                      `turn.failed` in the --json stream, no Stop and no
#                                      failure hook (the probe's stub ended every turn
#                                      that way and only SessionStart / UserPromptSubmit /
#                                      SessionEnd fired). Nothing is wired there,
#                                      extensions/lib/harness.sh refuses the spec by name,
#                                      and `leopold doctor` prints the row so the gap is
#                                      stated rather than discovered. Resume a Codex run
#                                      after an API error with /leopold-run.
#
# What it writes into state.json, and NOTHING else (scripts/test-hooks.sh diffs the state
# to prove it):
#   stopped_reason: "api_error"
#   api_error:      {type, at, retryable, hint}
#   active:         false
# Never `iteration`, `no_progress`, `windows`, `context_mb`, `transcript_path`,
# `last_turn` or `owner` — those belong to hooks/stop-continuity.sh and to activation. A
# failed turn is not a turn: charging one would spend a budget on the API's mistake, and
# `no_progress` would blame the run for work it was never allowed to do.
#
# It also clears the run's tokens — .leopold/STOP, ALLOW_GIT, ALLOW_PUSH, ALLOW_PUBLISH —
# because this is a TERMINAL stop, and every other terminal stop in Leopold clears them:
# allow_stop() in hooks/stop-continuity.sh, clearRunTokens() in the driver
# (packages/driver/src/config.ts), and /leopold-stop. Those tokens are scoped to ONE run
# by documentation alone; nothing clears them at activation. Left behind, a human's
# per-run `touch .leopold/ALLOW_GIT` outlives the run it was granted for and the NEXT
# autonomous run in this project starts with git already unlocked, from turn 1, with no
# human in the loop — the exact opposite of "the run stages, the human ships". Reproduced
# before this line existed: a 429 here, then /leopold-run, and guard-irreversible.sh let
# `git commit` straight through. A surviving STOP is the mirror image — the resume this
# hook's own hint recommends would halt on turn 1 with `kill_switch`. This is a filesystem
# hygiene step, not a state field: the forbidden-fields invariant above governs state.json
# keys and is untouched by it.
#
# WHOSE RUN IT MAY END. Passing the gate means this payload may act for the run; it does
# not mean this payload CONDUCTS it. On a driver-conducted run the session that passes is
# the driver's spawned worker (LEOPOLD_SDK_WORKER=1 — packages/driver/src/worker.ts loads
# `settingSources: ["user","project"]`, so these hooks run inside it), and a worker's
# failed turn is caught and retried by the conductor: packages/driver/src/loop.ts counts it
# as one `consecutive_failures` and keeps dispatching until `max_failures`. Writing
# `active: false` from there would take the project-wide git lock OFF mid-run —
# hooks/guard-irreversible.sh gates on exactly that field — while the driver is still
# conducting and, under --parallel, while sibling workers are live inside the same window.
# So the driver branch logs the witness and writes NOTHING, the way hooks/stop-continuity.sh
# already exits 0 for that same session class: the conductor decides what happens next.
#
# `retryable` is decided LEXICALLY from `error`, never by re-interpreting the model-facing
# `last_assistant_message` (which this hook does not read at all, and does not copy into
# state): true for rate_limit / overloaded / server_error, false for auth / billing /
# invalid_request. An error class Leopold does not recognize is `retryable: false` — a
# human decides. The one thing a wrong `true` buys is an automatic relaunch loop against
# a permanent failure, which is the expensive mistake; a wrong `false` costs one command.
#
# Scope, in order (each case has a test in scripts/test-hooks.sh):
#   no .leopold/state.json, run not active, or a session that is not the run's -> silent.
#     Ownership is read by leo_hook_gate, the same reader hooks/stop-continuity.sh and
#     hooks/permission-policy.sh use, so a second window that hits an API error never ends
#     a run it does not conduct.
#   anything but StopFailure                                                   -> silent.
#   a driver run, from the driver's own worker -> log `api_error_observed` and say so;
#     no state write, no token clearing. The conductor decides (see above).
#   otherwise -> log `stop_failure`, mark the run stopped under the state lock, clear the
#     run's tokens, and put the retry hint in front of a person.
#
# Fail OPEN throughout: this is a continuity hook. It never blocks anything, it cannot
# (the turn is already over), and an unreadable payload or state means silence.

input="$(cat 2>/dev/null || true)"

# The shared gate/lock/event library, resolved beside THIS script so the installed asset
# home works exactly like the checkout. Missing means a broken install: say so where a
# person will see it and let the harness carry on — a continuity hook never fails loud
# into the model's way.
_LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
if [ -r "$_LEO_LIB" ]; then
  # shellcheck source=_lib.sh
  . "$_LEO_LIB"
else
  # Only where Leopold has something to say: the library is what establishes scope, so
  # its absence is checked against the one thing a hook can read without it — a
  # .leopold/state.json in the payload's cwd. A broken install must not print into every
  # session on the machine.
  _cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${_cwd:-}" ] || _cwd="$PWD"
  [ -f "$_cwd/.leopold/state.json" ] || exit 0
  echo "Leopold: hooks/_lib.sh is missing beside stop-failure.sh — this API error was NOT recorded. Re-run the Leopold installer, then: leopold doctor" >&2
  exit 0
fi

# Active run, conducted by the session in this payload, or nothing at all.
leo_hook_gate "$input"

# Wired on StopFailure alone; the name is checked anyway, because a hook that acts on a
# payload it was not written for is how one bad wiring becomes a stopped run.
case "${LEO_EVENT:-}" in StopFailure|"") ;; *) exit 0 ;; esac

# The harness's own error vocabulary, kept as evidence: bounded, whitespace collapsed,
# nothing else touched. `type` is what the harness said, verbatim — a normalized class
# would hide the day a new value appears, and `retryable` below already carries the
# verdict in a machine-readable form.
etype="$(printf '%s' "$input" | jq -r '.error // empty' 2>/dev/null || true)"
etype="$(printf '%s' "$etype" | tr '\n\r\t' '   ' | sed -e 's/  */ /g' -e 's/^ *//' -e 's/ *$//')"
[ "${#etype}" -le 100 ] || etype="${etype:0:99}…"
[ -n "$etype" ] || etype="unknown"

# ---- the classification, lexical and closed ------------------------------------------
# Matched on the lower-cased `error` value. The three captured classes come first; the
# families the brief names are matched by their own words, and everything else is
# deliberately NOT guessed at.
lower="$(printf '%s' "$etype" | tr '[:upper:]' '[:lower:]')"
RESUME="Nothing was committed — the work is staged in the working tree, and /leopold-run picks the plan up at the next open item."
case "$lower" in
  *rate*limit*)
    retryable=true
    hint="The API rate-limited this session (\`$etype\`). Wait for the limit to clear, then resume: /leopold-run. $RESUME" ;;
  *overload*)
    # Not in the captured vocabulary — 529 came back as `server_error` on 2.1.259 — but
    # it is a documented upstream error type, and it belongs to the same transient family,
    # so a version that starts sending it is classified rather than sent to `unknown`.
    retryable=true
    hint="The API is overloaded (\`$etype\`). It clears on its own; retry in a moment with /leopold-run. $RESUME" ;;
  *server*error*)
    retryable=true
    hint="The API returned a server-side error (\`$etype\` — a 500 or a 529). It is usually transient: retry with /leopold-run, and if it repeats check whatever gateway or proxy sits in front of the API. $RESUME" ;;
  *auth*)
    # The scenario this hook was specified against: the hint names re-login, and never
    # suggests that starting the run again would help. It would not — the credentials
    # failed, not the work.
    retryable=false
    hint="Authentication failed (\`$etype\`). Log in again — \`claude /login\`, or \`codex login\` on Codex — and only then take the seat back with /leopold-run. The credentials are what failed, so this run stops here instead of spending turns on the same 401. $RESUME" ;;
  *billing*|*credit*|*payment*)
    retryable=false
    hint="The API refused this session for billing reasons (\`$etype\`). Settle the account or raise the plan's limit, then start the run again with /leopold-run. $RESUME" ;;
  *invalid*request*)
    retryable=false
    hint="The API rejected the request as invalid (\`$etype\`). That is a bug in what was sent, not a transient failure: read the harness's last message, fix the input, and start the run again with /leopold-run. $RESUME" ;;
  *)
    retryable=false
    hint="Leopold does not recognize this API error (\`$etype\`), so it is treated as permanent and nothing resumes on its own. Read the harness's last message, then decide: /leopold-run takes the run back once the cause is fixed. $RESUME" ;;
esac

now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"

# ---- a driver run: the executor reports, the conductor decides -----------------------
# The gate admitted this payload as the driver's spawned worker. A worker's failed turn is
# one attempt inside a run that keeps going (loop.ts retries to `max_failures`), so ending
# the run here would unlock git mid-run — see WHOSE RUN IT MAY END above. The failure is
# still logged, because the driver's own log records only `item_incomplete` and never says
# the API refused; without this line a run that dies of three 429s reads as three bad
# attempts by the worker. Nothing is written to state.json and no token is cleared.
if [ "${LEO_OWNER_ENGINE:-}" = "driver" ]; then
  leo_hook_event api_error_observed "$(jq -cn --arg t "$etype" --argjson r "$retryable" \
    '{error_type:$t,retryable:$r,conducted_by:"driver"}' 2>/dev/null || echo '{}')"
  dmsg="Leopold: this turn failed on an API error (\`$etype\`, retryable: $retryable). A driver conducts this run, so the run was NOT stopped and git stays locked — the conductor retries or stops on its own budget. Logged as api_error_observed in .leopold/events.jsonl."
  jq -cn --arg m "$dmsg" '{systemMessage:$m}' 2>/dev/null
  echo "$dmsg" >&2
  exit 0
fi

# The witness first: the run's log records the failed turn even if the state write below
# cannot happen (a read-only .leopold, a full disk).
leo_hook_event stop_failure "$(jq -cn --arg t "$etype" --argjson r "$retryable" \
  '{error_type:$t,retryable:$r}' 2>/dev/null || echo '{}')"

# ---- the run is over: mark it, under the lock ----------------------------------------
# The same mkdir lock every other state writer takes — a compaction, a stop and this can
# land in the same second, and a lost update here would leave the run looking active.
# When the lock cannot be taken inside its budget the write happens ANYWAY, unlocked, and
# `lock_timeout` says so: a lost counter is cheap, a run left `active: true` is the bug
# this hook exists to end. That fallback only exists if the harness lets this process live
# past the wait, which is why the spec in leo_core_hook_specs declares 15s against a ~5s
# budget (hooks/_lib.sh, LEO_LOCK_HEADROOM) — wired at 5 the hook was killed mid-wait and
# wrote nothing at all.
leo_hook_lock || leo_hook_event lock_timeout
tmp="$(mktemp 2>/dev/null || echo "$LEO_STATE.tmp")"
wrote=no
if jq --arg t "$etype" --arg at "$now" --argjson r "$retryable" --arg h "$hint" \
     '.active = false
      | .stopped_reason = "api_error"
      | .api_error = {type:$t, at:$at, retryable:$r, hint:$h}' \
     "$LEO_STATE" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
  mv "$tmp" "$LEO_STATE" 2>/dev/null && wrote=yes || rm -f "$tmp" 2>/dev/null || true
else
  rm -f "$tmp" 2>/dev/null || true
fi
leo_hook_unlock

# ---- the run's tokens go with the run ------------------------------------------------
# The same four files hooks/stop-continuity.sh removes in allow_stop(), in the same words:
# so the next run re-locks git and does not halt immediately on a stale STOP. Unconditional
# on purpose — the git half must never depend on the jq write above succeeding, because a
# state.json Leopold could not write is exactly the case where a leftover ALLOW_GIT would
# be hardest to notice. Reached only past the ownership gate and past the driver branch,
# so no session clears tokens for a run it does not conduct.
rm -f "$LEO_DIR/STOP" "$LEO_DIR/ALLOW_GIT" "$LEO_DIR/ALLOW_PUSH" "$LEO_DIR/ALLOW_PUBLISH" 2>/dev/null || true

# ---- put it in front of a person -----------------------------------------------------
# `systemMessage` is the field both harnesses deserialize everywhere the probe tried it;
# StopFailure itself was captured in observe mode only, so the same line also goes to
# stderr — it costs nothing and it is what someone piping this hook by hand sees. A run
# that died on an API error and said nothing is the failure this hook exists to end.
msg="Leopold: this turn failed on an API error (\`$etype\`) and no Stop hook fires for a failed turn, so nothing else would have noticed."
if [ "$wrote" = "yes" ]; then
  msg="$msg The run is marked stopped in .leopold/state.json (stopped_reason: api_error, retryable: $retryable). $hint"
else
  msg="$msg Leopold could NOT write .leopold/state.json, so the run may still look active — end it with /leopold-stop --force. $hint"
fi
jq -cn --arg m "$msg" '{systemMessage:$m}' 2>/dev/null
echo "$msg" >&2
exit 0
