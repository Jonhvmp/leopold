#!/usr/bin/env bash
# Leopold verification receipts: PostToolUse / PostToolUseFailure, on both harnesses.
# The evidence half of "done means verified" — it RECORDS, it never refuses. The gate
# that refuses reads what this writes (hooks/done-gate.sh, the next item).
#
# WHY IT EXISTS. "An item is done when a verification command ran with exit 0 after its
# last edit" has lived in .leopold/GUARDRAILS.md and in the run skill's prose since the
# beginning, and nothing anywhere compared a test run to an edit. A rule that lives only
# in a prompt is a wish. This hook turns the two halves of that sentence into facts on
# disk: `last_edit_at` (an edit tool ran) and `verify_receipts` + `last_verify_at` (a
# command the brief calls verification ran, and how it ended).
#
# THE FACTS IT RIDES ON, from the probe's live captures (docs/reference/hook-events.md,
# `PostToolUse` / `PostToolUseFailure` on both harnesses; hooks/hook-matrix.tsv, rows
# `verify-receipt`; .leopold/DECISIONS.md, "verify-receipt — both harnesses, PostToolUse
# with no exit code in the payload"):
#
#   THERE IS NO EXIT CODE IN A PostToolUse PAYLOAD ON EITHER HARNESS. The plan asked for
#   "the exit code the probe captured"; the probe captured none. What it captured instead:
#
#   Claude Code 2.1.259  `tool_response` is an OBJECT ({stdout, stderr, interrupted,
#                        isImage, noOutputExpected, …}), and MOST non-zero Bash exits do
#                        not reach this event at all: they fire `PostToolUseFailure`,
#                        whose `error` is the string "Exit code 1".
#                        BUT THE FIRING OF PostToolUse IS NOT ITSELF A PASS. Three fields
#                        of that object each deny a clean exit 0, and the capture holds
#                        all three:
#                          returnCodeInterpretation  the harness re-interpreted a NON-ZERO
#                            status as "not an error" and named its meaning. The probe's
#                            own capture is `grep -c zzz /dev/null` — which exits 1 —
#                            arriving here with {"stdout":"0",…,"returnCodeInterpretation":
#                            "No matches found"}, in the SAME run whose `false` correctly
#                            fired PostToolUseFailure. The binary settles the rule: the
#                            default classifier is `isError = code !== 0`, but grep / rg /
#                            egrep / fgrep / find / diff / test / [ / git grep / git diff
#                            use `isError = code >= 2` with the message set IFF `code === 1`
#                            — so the field is present exactly when the exit was 1 and
#                            never when it was 0. A verification entry whose failure looks
#                            like that (`grep -q "0 failures" report.txt`) would otherwise
#                            mint a receipt claiming exit 0. It does not: see `nonzero`.
#                          interrupted            the command was cut off mid-run. What it
#                            printed before that is not a result.
#                          backgroundTaskId       the command was LAUNCHED, not finished —
#                            `run_in_background`, or a timeout that moved it to the
#                            background. The response object is returned at launch time
#                            with an empty stdout and `interrupted: false`, verified in a
#                            live 2.1.260 transcript. A `make test` that outran its timeout
#                            is not evidence that `make test` passed.
#   Codex CLI 0.152.1    PostToolUse fires for pass and fail alike, `tool_response` is a
#                        STRING holding stdout only ("" for both `true` and `false`), and
#                        there is no PostToolUseFailure event at all. A Codex receipt
#                        therefore proves the verification RAN after the last edit — never
#                        that it passed. That is the tsv's `substitute` note verbatim, and
#                        it is the cost `leopold doctor` prints on the Codex row.
#
#   The banned alternatives, for the record: re-running the command from the hook (the
#   charter forbids running the suite from a hook, and it would double every test run),
#   and reading an outcome the payload does not carry (a fabricated receipt is worse than
#   no receipt). So the status is taken from where the capture shows it, and where the
#   capture shows nothing the receipt says `exit_code: null` out loud.
#
# WHAT IT WRITES INTO state.json, and nothing else (scripts/test-hooks.sh diffs the state
# to prove it):
#   last_edit_at        every successful edit tool call that touched a file outside
#                       `.leopold/`, on either harness. The run's own bookkeeping — the
#                       plan, the decisions, the journal, this state file — is not work,
#                       and counting it made the documented turn loop unsatisfiable (see
#                       the edit half below).
#   verify_receipts[]   {command, exit_code, outcome, at, session} — appended when a Bash
#                       command lexically matches an entry under `## Verification commands`
#                       in .leopold/GUARDRAILS.md.
#   last_verify_at      the `at` of the most recent receipt whose `outcome` is evidence.
#   own_edits           the EXACT COMPLEMENT of `last_edit_at`: basename -> the second an
#                       edit tool touched that file INSIDE `.leopold/`. It exists for one
#                       reader, hooks/file-watch.sh, which has no other way to tell the
#                       run's own `[x]` flip from a second writer's — the FileChanged
#                       payload is `file_path` + `event` and carries no own/external field
#                       at all (docs/reference/hook-events.md). Keyed by basename because
#                       that payload reports a RESOLVED path (`/private/tmp/...` for a
#                       `/tmp/...` project) that no string compare against the project root
#                       survives. Bounded to the VR_OWN_KEEP newest entries, so a long run
#                       that writes many `.leopold/` files cannot grow it without limit.
# Never `iteration`, `no_progress`, `windows`, `context_mb`, `transcript_path`,
# `last_turn` or `owner` — those belong to hooks/stop-continuity.sh and to activation.
#
# `exit_code` AND `outcome` ANSWER TWO DIFFERENT QUESTIONS, which is why there are two of
# them. `exit_code` is the NUMBER the harness reported, or `null` when it reported none —
# it is never inferred. `outcome` is what the payload PROVES, as one of five words, and it
# alone decides whether `last_verify_at` moves:
#   passed      exit 0. A Claude Code PostToolUse whose response object carries none of the
#               three denials above.                                          MOVES the stamp
#   failed      PostToolUseFailure. `exit_code` is the number in `error`, else 1.       no
#   nonzero     PostToolUse, but `returnCodeInterpretation` says the harness re-interpreted
#               a non-zero status. `exit_code` stays null: the payload names the meaning,
#               not the number.                                                         no
#   incomplete  interrupted, or backgrounded at launch. It did not finish.               no
#   ran         Codex: no status anywhere in any payload.                    MOVES the stamp
#
# WHY `ran` MOVES AND `nonzero` / `incomplete` DO NOT. On Claude the stamp means what the
# plan says: the latest exit-0 time, and every shape the harness gives us to doubt that is
# honored. On Codex, where no exit status exists in any payload, it means "a verification
# command ran here" — the whole guarantee that harness offers, written into
# hooks/hook-matrix.tsv as the row's note before this hook was written. Refusing to move it
# there would not make Codex stricter; it would make the bound UNAVAILABLE on Codex (the
# gate would deny every finished item forever), which is the opposite of "both harnesses or
# neither". Refusing to move it on a Claude `nonzero` or `incomplete` costs nothing by
# comparison: the same harness reports the passing run a moment later, and the error can
# only ever ask for a LATER verification, never accept an earlier lie.
#
# NO SECTION IN GUARDRAILS, NO RECEIPTS. A brief with no `## Verification commands`
# section gets no receipts and no events: nothing declares what evidence means, so nothing
# is claimed. That is the backward-compatible half — a project that never wrote the
# section behaves exactly as it did before this hook existed. (`last_edit_at` is stamped
# either way: it is a fact about the run, not a claim about evidence, and the gate needs
# both halves the moment the section appears.)
#
# HOW A COMMAND MATCHES, LEXICALLY AND NEVER SEMANTICALLY. Both sides go through the SAME
# normalizer, which drops heredoc BODIES and shell COMMENTS and then emits an explicit
# command-start MARKER at the start of every line and in place of every shell separator
# (`; & | ( )`) — and AN ENTRY MATCHES ONLY WHERE IT BEGINS A COMMAND, at one of those
# markers. So `- make hooks-test` is matched by `make hooks-test`, `cd sub && make
# hooks-test`, `make hooks-test 2>&1` and `echo $(make hooks-test)`, and NOT by `ls -la`,
# `echo "make hooks-test"`, `echo "- ran make hooks-test after the edit" >> notes.md`, a
# heredoc that writes those words into DECISIONS.md, or `make build # make hooks-test comes
# later`. In every one of those the words are an ARGUMENT or a comment, never a command
# that ran — and a plain substring search (what this hook shipped with before the review)
# let each of them mint `{exit_code: 0, outcome: "passed"}` and move the stamp, which is
# the run narrating its own evidence in the one mechanism whose whole purpose is to stop
# unearned "done". Comments are stripped per LINE, not per command, so a multi-line Bash
# call whose first line is `# run the suite` still matches on its second. The full rule,
# with the cases it deliberately refuses, is on vr_norm below. The hook never asks what the
# model meant by a command; it compares text, which is all a hook is allowed to do here.
#
# WRITTEN UNDER THE LOCK. A turn can close several tool calls in the same second and the
# Stop hook, the compaction checkpoint and this one all read-modify-write state.json; an
# unlocked append loses receipts. So every write goes through the mkdir lock hooks/_lib.sh
# owns, and the specs in leo_core_hook_specs declare 10s against that ~5s budget
# (LEO_LOCK_HEADROOM) — a hook wired tighter is killed mid-wait and records nothing.
# scripts/test-harness-lib.sh derives that floor rather than trusting this comment.
#
# IT NEVER BLOCKS AND NEVER SPEAKS TO THE MODEL. `decision: block` IS honored at
# PostToolUse on both harnesses (the capture), and this hook does not use it: the tool has
# already run, so refusing it here would only add noise to a turn that already did the
# work. Item 12's gate is where a rule refuses, at PreToolUse and TaskCompleted, before
# the fact.
#
# Scope, in order (each case has a test in scripts/test-hooks.sh):
#   no .leopold/state.json, state that does not parse, run not active, or a session that
#     is not the run's                       -> silent. A continuity hook fails open, and
#                                               a stranger's test run is not this run's
#                                               evidence. Ownership comes from
#                                               leo_hook_gate (hooks/_lib.sh), the one
#                                               reader.
#   anything but PostToolUse/PostToolUseFailure -> silent.
#   an edit tool on PostToolUse, outside .leopold/ -> stamp `last_edit_at`.
#   an edit tool on PostToolUse, .leopold/ only    -> no `last_edit_at`: the run's own
#                                               bookkeeping is not the work a verification
#                                               covers. It IS stamped into `own_edits`,
#                                               the second-writer detector's only witness
#                                               that a change to the plan was ours.
#   an edit tool on PostToolUseFailure       -> silent: a failed edit changed nothing.
#   Bash, no `## Verification commands`      -> silent (today's behavior).
#   Bash, no entry matches                   -> silent.
#   Bash, an entry matches                   -> a receipt, `verify_recorded`, and
#                                               `last_verify_at` only when the outcome is
#                                               `passed` or `ran`.
#   any other tool                           -> silent.

input="$(cat 2>/dev/null || true)"

# The shared gate/lock/event library, resolved beside THIS script so the installed asset
# home works exactly like the checkout. Missing means a broken install: say so where a
# person will see it and let the harness carry on — this hook records evidence, it never
# refuses anything, and an unrecorded receipt is not worth interrupting a run for. (The
# gate that DOES refuse denies loudly for the same cause; this one must not.)
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
  echo "Leopold: hooks/_lib.sh is missing beside verify-receipt.sh — this run's verification receipts are NOT being recorded, so 'done means verified' cannot be proven. Re-run the Leopold installer, then: leopold doctor" >&2
  exit 0
fi

# Active run, conducted by the session in this payload, or nothing at all. Without
# `report` this exits silently on every no — the continuity direction, and the right one:
# a receipt written for a run this session does not conduct would let a stranger's test
# run close somebody else's plan item.
leo_hook_gate "$input"

# Wired on these two events; the name is checked anyway, because a hook that acts on a
# payload it was not written for is how one bad wiring becomes a false receipt.
case "${LEO_EVENT:-}" in PostToolUse|PostToolUseFailure) ;; *) exit 0 ;; esac

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"

# How many receipts are kept. `last_verify_at` is a scalar and never rolls off, so the
# fact the gate reads survives any trim; the list is the human-readable trail behind it.
# 200 is ~25 KB at the 200-char command bound below — a run that verifies more often than
# that has older receipts that no longer prove anything about the current edit.
VR_KEEP=200
# The command recorded in a receipt is bounded the way subagent-account.sh bounds
# `agent_type`: kept verbatim, never normalized, just cut with a marker if it is enormous.
VR_CMD_MAX=200
# How many `own_edits` entries are kept. The map is keyed by basename and the files a run
# actually writes under `.leopold/` are a handful (the plan, the decisions, the journal, a
# checkpoint), so 16 is far more than a run needs and still a hard ceiling — the newest
# win, and an entry that rolled off is simply a change this run cannot claim as its own.
VR_OWN_KEEP=16

# One read-modify-write of state.json, under the lock, from a jq program the caller
# supplies. A lock this hook cannot take inside its budget does not cost the write: it
# happens anyway, unlocked, and `lock_timeout` says so — the same choice every other state
# writer in hooks/ makes, because a lost receipt is cheap and a missing one is not.
vr_write() { # <jq program> [jq args...]
  local prog="$1"; shift
  local tmp
  leo_hook_lock || leo_hook_event lock_timeout
  tmp="$(mktemp 2>/dev/null || echo "$LEO_STATE.tmp")"
  if jq "$@" "$prog" "$LEO_STATE" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$LEO_STATE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
  leo_hook_unlock
}

# Every file this edit call touches, one per line: `file_path` for Claude Code's four
# tools (`notebook_path` for NotebookEdit, which names its target differently), and the
# `*** … File:` headers of a Codex patch, which may name several. Lexical, like everything
# else here.
vr_edit_paths() {
  if [ "$tool" = "apply_patch" ]; then
    printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null \
      | awk '/^\*\*\* (Add|Update|Delete) File: / {
               sub(/^\*\*\* (Add|Update|Delete) File: /, "")
               sub(/[[:space:]]+$/, ""); if (length) print }'
  else
    printf '%s' "$input" \
      | jq -r '[.tool_input.file_path?, .tool_input.notebook_path?] | map(select(type == "string" and . != "")) | .[]' 2>/dev/null
  fi
}

# True when the call touched at least one file that is NOT the run's own bookkeeping.
# A call whose paths cannot be read is treated as work: a missing exclusion only ever
# makes the gate ask for a later verification, a wrong one would let unverified work
# through.
vr_edit_is_work() {
  local _p _seen=0
  while IFS= read -r _p; do
    [ -n "$_p" ] || continue
    _seen=1
    case "$_p" in
      */.leopold/*|.leopold/*) ;;
      *) return 0 ;;
    esac
  done <<EOF
$(vr_edit_paths)
EOF
  [ "$_seen" = "1" ] && return 1
  return 0
}

# The other side of the same split: the BASENAMES of the `.leopold/` files this call
# touched, one per line, deduplicated. Same lexical path test as above, read the same way
# — so a call that edits the plan and a source file feeds both halves and neither reads
# the other's files. Basenames, because the only reader compares against a FileChanged
# `file_path` the harness has already resolved through symlinks.
vr_edit_own_names() {
  local _p
  while IFS= read -r _p; do
    [ -n "$_p" ] || continue
    case "$_p" in
      */.leopold/*|.leopold/*) printf '%s\n' "${_p##*/}" ;;
    esac
  done <<EOF
$(vr_edit_paths)
EOF
}

# ---- the edit half: a fact about the WORK, stamped by every edit tool -----------------
# Claude Code's four edit tools and Codex's one (`apply_patch`, whose `tool_input.command`
# holds the patch — Findings). On Claude a failed edit goes to PostToolUseFailure, so a
# PostToolUse here IS a successful edit; on Codex apply_patch reports pass and fail in the
# same event, so a failed patch also stamps. That direction is deliberate: an extra
# `last_edit_at` makes the gate ask for a LATER verification, never an earlier one, so the
# error can only ever be strict.
#
# EXCEPT THE RUN'S OWN BOOKKEEPING. `.leopold/` is where the run WRITES ITSELF DOWN — the
# plan it ticks, the decisions it logs, the journal, this very state file — and none of it
# is work a verification command could ever have covered. Counting it invalidated the
# documented turn loop on its correct path: skills/leopold-run/SKILL.md Step 4 orders
# (2) run a verification -> `last_verify_at`, (3) log the decision in
# .leopold/DECISIONS.md -> `last_edit_at` NEWER than it, (4) tick the box — and the gate
# next door then told a run that had just passed the suite to "run the verification
# first". The TaskCompleted half was worse than stale: the tick in step 4 is itself an
# edit, so every completion arrived with an edit newer than any receipt and NO ordering of
# the prescribed steps could clear both gates. So the stamp is the last edit OUTSIDE
# `.leopold/`, and the run's own paperwork is silent. A path this hook cannot read at all
# stamps anyway — the strict direction, which can only ask for a later verification.
#
# SILENT TO THE GATE IS NOT SILENT TO DISK. The paperwork edit is still the only proof
# that a change to `.leopold/PLAN.md` was the RUN'S, and hooks/file-watch.sh has nothing
# else: its FileChanged payload cannot tell the run's own `[x]` flip from a second
# writer's append. So a `.leopold/` edit stamps `own_edits[<basename>]` — a different
# field, read by a different hook, and deliberately NOT `last_edit_at`, whose meaning the
# evidence gate depends on. Both halves are decided from the same path list in the same
# call, so an edit that touches the plan AND a source file stamps both, once, under one
# lock.
case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit|apply_patch)
    [ "$LEO_EVENT" = "PostToolUse" ] || exit 0
    vr_own_names="$(vr_edit_own_names | sort -u 2>/dev/null || true)"
    vr_prog=""
    vr_edit_is_work && vr_prog='.last_edit_at = $at'
    if [ -n "$vr_own_names" ]; then
      # An `own_edits` that is not an object (hand-edited, half-written) is replaced
      # rather than merged into: a jq error here would drop the whole write, including
      # `last_edit_at`, and cost the evidence gate its fact.
      vr_prog="${vr_prog:+$vr_prog | }.own_edits = (
          (((.own_edits // {}) | if type == \"object\" then . else {} end)
           + (\$names | map({key: ., value: \$at}) | from_entries))
          | to_entries | sort_by(.value) | .[(0 - \$keep):] | from_entries)"
      vr_write "$vr_prog" --arg at "$now" --argjson keep "$VR_OWN_KEEP" \
        --argjson names "$(printf '%s\n' "$vr_own_names" | jq -R . | jq -sc . 2>/dev/null || echo '[]')"
    elif [ -n "$vr_prog" ]; then
      vr_write "$vr_prog" --arg at "$now"
    fi
    exit 0
    ;;
  Bash) ;;
  *) exit 0 ;;
esac

# ---- the verification half: what the brief calls evidence ---------------------------
# The `## Verification commands` section of .leopold/GUARDRAILS.md, read lexically: the
# list items under that heading, until the next heading of any level. Only MARKDOWN is
# stripped here — backticks and bold markers, because a brief may write `- \`make test\``.
# The trailing ` # comment` a brief also writes is NOT stripped here on purpose: it is
# shell syntax, not markdown, so it belongs to vr_norm below, where the command side gets
# exactly the same treatment. Stripping it on one side only is what let a command that
# merely MENTIONED an entry in a comment mint a full receipt.
[ -f "$LEO_DIR/GUARDRAILS.md" ] || exit 0
entries="$(awk '
  /^[[:space:]]*#/ {
    h = $0
    sub(/^[[:space:]]*#+[[:space:]]*/, "", h)
    inside = (tolower(h) ~ /^verification commands/) ? 1 : 0
    next
  }
  inside && /^[[:space:]]*-[[:space:]]/ { print }
' "$LEO_DIR/GUARDRAILS.md" 2>/dev/null \
  | sed -e 's/^[[:space:]]*-[[:space:]]*//' \
        -e 's/`//g' -e 's/\*\*//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
  | grep -v '^$' || true)"
# No section, or a section with no entries: nothing declares what evidence means here, so
# nothing is recorded and nothing is claimed. Today's behavior, byte for byte.
[ -n "$entries" ] || exit 0

command_raw="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -n "$command_raw" ] || exit 0

# Both sides go through the SAME normalizer, which is what makes the comparison lexical
# and symmetric, and what it produces is a token stream with an explicit COMMAND-START
# MARKER (ASCII SOH) wherever a new command can begin. In order:
#   1. the marker byte is DELETED from the input first, so a command that carries one
#      cannot forge a boundary of its own.
#   2. HEREDOC BODIES ARE DROPPED. A `<<EOF` body is data the shell feeds to a command,
#      never a command: `cat >> DECISIONS.md <<EOF / Verification: make test passed / EOF`
#      writes a sentence, it does not run `make test`. Every heredoc a line opens is
#      queued in order (`<<-` and a quoted or backslashed delimiter included), and lines
#      are dropped until each delimiter closes. `<<<` is a here-STRING, not a heredoc, and
#      opens nothing.
#   3. shell COMMENTS are dropped: a `#` at the start of a line or after whitespace, to
#      the end of THAT line. Per line, before lines join, because that is what a shell
#      does — so `# run the suite\nmake test` still matches `make test`, while
#      `make build # make test comes later` and `echo skip; # make test` match nothing.
#      A `#` inside a token (`make test URL=x#y`) is not a comment and is left alone.
#   4. a MARKER is emitted at the start of every line and in place of every shell
#      separator (`; & | ( )`); tabs become spaces and runs of spaces collapse.
#
# AND THE ENTRY MUST START AT ONE OF THOSE MARKERS. That is the whole rule: an entry
# matches when its own normalized form — which begins with a marker, because it went
# through the same normalizer — appears in the command's, followed by a space or the end.
# So `- make hooks-test` is matched by `make hooks-test`, by `cd sub && make hooks-test`,
# by `make hooks-test 2>&1` and by `echo $(make hooks-test)`, because in each of those the
# entry begins a command. It is NOT matched by `ls -la`, by `echo "make hooks-test"`, by
# `echo "- ran make hooks-test after the edit" >> notes.md`, by a heredoc that writes the
# words into DECISIONS.md, or by `make build # make hooks-test comes later` — in every one
# of those the words are an ARGUMENT or a comment, not a command that ran.
#
# A PLAIN SUBSTRING SEARCH WAS THE BUG THIS RULE CLOSES. Before the marker, any command
# whose token stream contained the entry ANYWHERE minted `{exit_code: 0, outcome:
# "passed"}` and moved `last_verify_at` — and writing a DECISIONS.md entry by heredoc and
# ticking PLAN.md by `echo` is exactly the loop skills/leopold-run/SKILL.md tells the run
# to perform. The run could mint its own evidence by narrating it. It is the same
# false-evidence class the `#` handling closed, in the one mechanism whose whole purpose
# is to stop unearned "done", so the boundary is required rather than assumed.
#
# The match is deliberately STRICT where it cannot tell: `time make test`, `sudo make test`
# and `if make test; then` record nothing, because the entry does not begin a command
# there by this rule. That direction is safe by construction — a missing receipt can only
# ever make the gate ask for a LATER verification, never accept an earlier lie.
# The hook never asks what the model meant by a command; it compares text, which is all a
# hook is allowed to do here.
VR_MARK=$'\001'
vr_norm() {
  printf '%s' "$1" | tr -d "$VR_MARK" | tr '\r' '\n' | awk '
    BEGIN {
      q1 = sprintf("%c", 39)                      # a single quote, unquotable in this program
      nq = 0; out = ""
      # <<[-] DELIM, where DELIM is "quoted", '"'"'quoted'"'"', \escaped or bare.
      hd = "<<-?[ \t]*(\"[^\"]*\"|" q1 "[^" q1 "]*" q1 "|\\\\?[A-Za-z_][A-Za-z0-9_]*)"
    }
    {
      line = $0
      # Inside a heredoc body: this is data a command was handed, not a command. Drop it,
      # and close the oldest delimiter still open when its line arrives (leading and
      # trailing whitespace ignored, which covers <<- and its tabs).
      if (nq > 0) {
        t = line
        sub(/^[[:space:]]+/, "", t); sub(/[[:space:]]+$/, "", t)
        if (t == q[1]) { for (i = 1; i < nq; i++) q[i] = q[i + 1]; nq-- }
        next
      }
      sub(/(^|[[:space:]])#.*$/, "", line)
      # Open every heredoc this line starts, in the order the shell will read them.
      # `<<<` is a here-string: blanked first so it never registers as a delimiter.
      s = line; gsub(/<<</, "   ", s)
      while (match(s, hd)) {
        tok = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
        sub(/^<<-?[ \t]*/, "", tok)
        gsub("[\"" q1 "\\\\]", "", tok)
        if (tok != "") { q[++nq] = tok }
      }
      gsub(/\t/, " ", line)
      gsub(/[;&|()]/, " \001 ", line)             # a separator ENDS a command and starts one
      out = out " \001 " line                     # and so does a new line
    }
    END { print out }
  ' | sed -e 's/  */ /g' -e 's/^ *//' -e 's/ *$//'
}
# The command carries a trailing space so an entry that ends the command still matches
# "<entry> " without a special case; the leading marker comes from vr_norm itself.
cmd_norm="$(vr_norm "$command_raw") "
matched=""
while IFS= read -r e; do
  [ -n "$e" ] || continue
  e_norm="$(vr_norm "$e")"
  # An entry that normalizes to nothing but markers and space (a bare `-`, a comment-only
  # entry) would otherwise match every command at its first boundary.
  [ -n "$(printf '%s' "$e_norm" | tr -d "${VR_MARK}[:space:]")" ] || continue
  # `[[ == *"$x"* ]]` with the pattern QUOTED is a literal substring test, so an entry
  # holding a glob character (`pytest tests/*`) matches itself and never everything —
  # and, unlike grep, it has no opinion about the marker byte making the text "binary".
  if [[ "$cmd_norm" == *"$e_norm "* ]]; then matched="$e"; break; fi
done <<EOF
$entries
EOF
# Not a verification command: silence, and no event. `ls -la` is not evidence of anything.
[ -n "$matched" ] || exit 0

# ---- the outcome, from where the capture shows it ------------------------------------
# Two values, two questions (see the header): `exit_code` is the number the harness
# reported or `null`, and `outcome` is what the payload proves. The order below is the
# order of the denials — every one of them is a field the probe captured, and the last
# branch is the only one that may claim a pass.
#
#   PostToolUseFailure                 -> `failed`. `error` is "Exit code 1" on the probed
#                                         Claude Code; the number is taken from it when it
#                                         is there, and any other failure string records 1
#                                         — the fact being recorded is "not zero", and the
#                                         harness's own number when it gives one.
#   PostToolUse, tool_response OBJECT  -> the Claude Code shape, inspected field by field:
#     .returnCodeInterpretation set    -> `nonzero`: the harness re-interpreted a non-zero
#                                         status (present iff the exit was 1 — the probe's
#                                         `grep -c zzz /dev/null` capture, and the binary's
#                                         own classifier). The number is not in the payload,
#                                         so `exit_code` stays null and the stamp holds.
#     .interrupted == true             -> `incomplete`: cut off mid-run.
#     .backgroundTaskId set            -> `incomplete`: launched, not finished.
#     none of those                    -> `passed`, exit 0.
#   PostToolUse, anything else         -> `ran`, exit_code `null`: the Codex shape, a string
#                                         of stdout with no status in it anywhere. Never
#                                         guessed at, never rounded to 0.
exit_code="null"
outcome="ran"
if [ "$LEO_EVENT" = "PostToolUseFailure" ]; then
  err="$(printf '%s' "$input" | jq -r '.error // empty' 2>/dev/null || true)"
  n="$(printf '%s' "$err" | grep -oiE 'exit code[: ]+[0-9]+' | grep -oE '[0-9]+' | head -1)"
  case "$n" in ''|*[!0-9]*) n=1 ;; esac
  exit_code="$n"; outcome="failed"
else
  outcome="$(printf '%s' "$input" | jq -r '
    if (.tool_response | type) != "object" then "ran"
    elif (.tool_response.returnCodeInterpretation // null) != null then "nonzero"
    elif (.tool_response.interrupted // false) == true then "incomplete"
    elif (.tool_response.backgroundTaskId // null) != null then "incomplete"
    else "passed" end' 2>/dev/null || true)"
  # Anything this hook did not compute itself — an empty jq, a multi-line answer, a shape
  # a future version invents — falls back to the weakest honest word rather than to a pass.
  case "$outcome" in
    passed) exit_code="0" ;;
    nonzero|incomplete|ran) exit_code="null" ;;
    *) outcome="ran"; exit_code="null" ;;
  esac
fi

# What is recorded is the command that RAN, not the entry that matched it: a receipt is
# evidence, and evidence is what happened. Whitespace is collapsed so one line of JSON
# stays one line; nothing else is rewritten.
cmd_rec="$(printf '%s' "$command_raw" | tr '\n\r\t' '   ' | sed -e 's/  */ /g' -e 's/^ *//' -e 's/ *$//')"
[ "${#cmd_rec}" -le "$VR_CMD_MAX" ] || cmd_rec="${cmd_rec:0:$((VR_CMD_MAX - 1))}…"

# `.verify_receipts` is normalized to an array before use — it is Leopold's field, so a
# hand-edited scalar where a list belongs is repaired rather than allowed to abort the
# whole write and lose the receipt with it. `last_verify_at` moves on `passed` and on `ran`
# (see the header on what that means on Codex) and on nothing else — never on the
# exit_code, which is `null` for three outcomes that mean three different things.
vr_write \
  '.verify_receipts = (((.verify_receipts // []) | if type == "array" then . else [] end)
     + [{command: $c, exit_code: $x, outcome: $o, at: $at, session: $s}])
   | .verify_receipts |= (if length > $keep then .[length - $keep:] else . end)
   | (if $o == "passed" or $o == "ran" then .last_verify_at = $at else . end)' \
  --arg c "$cmd_rec" --argjson x "$exit_code" --arg o "$outcome" --arg at "$now" \
  --arg s "${LEO_SESSION8:--}" --argjson keep "$VR_KEEP"

leo_hook_event verify_recorded "$(jq -cn --arg c "$cmd_rec" --argjson x "$exit_code" \
  --arg o "$outcome" '{command:$c,exit_code:$x,outcome:$o}' 2>/dev/null || echo '{}')"
exit 0
