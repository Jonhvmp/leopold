#!/usr/bin/env bash
# Leopold's evidence gate: PreToolUse + TaskCompleted, one script, one rule.
#
# THE RULE. An item is done when a verification command the brief itself names ran after
# that item's last edit. hooks/verify-receipt.sh RECORDS the two halves of that sentence
# (`last_edit_at`, `last_verify_at`); this is the half that REFUSES. Until now the rule
# lived only in .leopold/GUARDRAILS.md and in the run skill's prose, and a rule that lives
# only in a prompt is a wish: nothing anywhere compared a test run to an edit before a box
# was ticked. The prompt stays exactly as it was — it is the belt; this is the braces.
#
# ONE SCRIPT ON TWO EVENTS, because it is ONE rule. It branches on `hook_event_name`,
# which the probe captured in every payload on both harnesses (docs/reference/
# hook-events.md, Findings), and answers in that event's own reply shape:
#
#   PreToolUse     matcher `Edit|Write|MultiEdit|apply_patch`. An edit of .leopold/PLAN.md
#                  that turns a `- [ ]` into a `- [x]` is a claim of done, and it is denied
#                  with `permissionDecision: deny` when nothing has been verified since the
#                  last edit. `available` on BOTH harnesses in hooks/hook-matrix.tsv:
#                  Claude Code's edit tools are Edit / Write / MultiEdit, Codex's is
#                  `apply_patch`, whose `tool_input.command` holds the patch (Findings).
#   TaskCompleted  no matcher, no tool. Exit 2 is honored here (the capture: "the task
#                  stays pending"), so the same test refuses the completion with the
#                  verification commands on stderr. `available` on Claude Code;
#                  `substitute` on Codex, which has no task events at all — the PLAN.md
#                  half above carries the whole bound there, and the matrix gate in
#                  extensions/lib/harness.sh refuses this spec on Codex by name.
#
# WHAT IT NEVER DOES. It never runs a verification command (the charter forbids a suite
# from a hook: record cheaply at PostToolUse, check the record at the gate). It never
# re-interprets what the model meant — the flip is read LEXICALLY out of `tool_input`,
# by counting checked boxes on each side of the edit. It writes no state at all: the
# fields it reads belong to hooks/verify-receipt.sh, and its only write is one
# `done_denied` line on the event log.
#
# WHERE IT FAILS OPEN, AND WHERE IT FAILS CLOSED, AND OVER WHAT. It is a GUARD, so an
# unreadable state.json fails closed (deny / exit 2, naming the file) — but ONLY over a
# payload that is itself a claim of done. Scope comes first and the refusal second: an
# edit of anything but .leopold/PLAN.md, an edit that ticks no box, and a brief with no
# `## Verification commands` section all leave before the state is ever consulted, so a
# malformed state file never refuses `src/foo.ts` and never blocks its own repair.
# Everything that means "this is not a Leopold run, or not one this session conducts" —
# no state, inactive, a foreign session, a driver run this is not the worker of — exits 0
# in silence, and so does a state with neither timestamp: absent means today's behavior,
# byte for byte.
#
# WHAT COUNTS AS THE LAST EDIT. `last_edit_at` is the last edit OUTSIDE `.leopold/`
# (hooks/verify-receipt.sh). The run's own bookkeeping — ticking this plan, logging a
# decision, writing the journal — is not work a verification command could have covered,
# and counting it denied the turn loop skills/leopold-run/SKILL.md prescribes on its
# correct path, and made TaskCompleted unsatisfiable outright (the tick is itself an
# edit).
#
# MUTATION-VERIFIED: see the `done-gate` block of scripts/test-hooks.sh, which lists each
# mutation and the assertions it breaks.
set -u

input="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0   # cannot parse safely -> defer to the harness

# ---- what this payload is, before anything else is read ------------------------------
# Cheap, allocation-free rejection of everything this hook has no opinion about, exactly
# as hooks/subagent-cap.sh does it: a payload that does not parse degrades to empty here
# and leaves through the same door as a tool nobody asked about.
event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"
case "$event" in
  PreToolUse)
    case "$tool" in
      Edit|Write|MultiEdit|apply_patch) ;;
      *) exit 0 ;;
    esac
    ;;
  TaskCompleted) ;;
  *) exit 0 ;;
esac

# ---- the shared library, found beside this script and nowhere else --------------------
_LEO_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/_lib.sh"
if [ -r "$_LEO_LIB" ]; then
  # shellcheck source=_lib.sh
  . "$_LEO_LIB"
else
  _cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${_cwd:-}" ] || _cwd="$PWD"
  [ -f "$_cwd/.leopold/state.json" ] || exit 0
  echo "Leopold: hooks/_lib.sh is missing beside done-gate.sh — 'done means verified' is NOT being enforced for this run, so an item can be ticked with no passing verification behind it. Re-run the Leopold installer, then: leopold doctor" >&2
  exit 0
fi

# ---- the two reply shapes, so the rest of the script says `refuse` once ---------------
# PreToolUse answers with a JSON deny on stdout and exit 0 (the capture: the tool never
# ran and the reason reached the model). TaskCompleted answers with exit 2 and the reason
# on stderr (the capture: the task stays pending). Same rule, same words, two shapes.
refuse() { # <reason> <via> [extra JSON object for the event]
  local reason="$1" via="$2" x="${3:-}"
  [ -n "$x" ] || x='{}'
  if [ "$event" = "TaskCompleted" ]; then
    printf '%s\n' "$reason" >&2
  else
    jq -cn --arg r "$reason" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  fi
  leo_hook_event done_denied "$(jq -cn --arg v "$via" --arg t "$tool" --argjson x "$x" \
    '{via:$v} + (if $t == "" then {} else {tool:$t} end)
     + (if ($x|type) == "object" then $x else {} end)' 2>/dev/null || echo '{}')"
  [ "$event" = "TaskCompleted" ] && exit 2
  exit 0
}
via="plan_edit"; [ "$event" = "TaskCompleted" ] && via="task_completed"

# ---- scope, READ here and ACTED ON further down --------------------------------------
# `report`, so the gate's answer is only recorded: nothing is decided until this payload
# has been shown to be a claim of done. The variables it sets — LEO_DIR, LEO_STATE,
# LEO_SESSION8 — are established on the way in either way, which is what lets the claim
# check below read the plan on disk.
#
# WHY THE ANSWER WAITS. This hook fails CLOSED, and a guard that fails closed must fail
# closed on the thing it guards and on NOTHING ELSE. Deciding here meant an unreadable
# state.json denied every Edit, Write, MultiEdit and apply_patch anywhere in the project —
# `src/foo.ts` refused with "this claim of done was refused" — in briefs that never
# declared what verification means (the fourth acceptance scenario says those behave
# exactly as today), and it blocked its own remediation, since the reason says "fix the
# file" and the file is fixed with one of the denied tools. So the refusal is scoped to
# the payloads that ARE a claim: the claim check and the no-section pass-through run
# first, and the state's unreadability is answered only for what survives them.
gate_ok=1; gate_reason=""
if ! leo_hook_gate "$input" report; then gate_ok=0; gate_reason="$LEO_GATE_REASON"; fi

# ---- does this payload actually CLAIM an item is done? -------------------------------
# TaskCompleted is itself the claim, so it is already answered. A PreToolUse has to be
# read: only an edit of .leopold/PLAN.md that ADDS a ticked box is a claim of done, and
# everything else — another file, a reworded item, a new unticked item — passes through.
#
# The reading is LEXICAL and never semantic: count the ticked boxes on each side of the
# edit and compare. More on the new side than on the old is a box that was just ticked
# (or a ticked item that was just added, which is the same claim). Equal or fewer is not.
if [ "$event" = "PreToolUse" ]; then
  ticked() { printf '%s' "${1:-}" | grep -o '\[[xX]\]' 2>/dev/null | grep -c . || true; }
  old=""; new=""
  case "$tool" in
    Edit|MultiEdit|Write)
      path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || true)"
      case "$path" in
        */.leopold/PLAN.md|.leopold/PLAN.md) ;;
        *) exit 0 ;;
      esac
      case "$tool" in
        Edit)
          old="$(printf '%s' "$input" | jq -r '.tool_input.old_string // ""' 2>/dev/null || true)"
          new="$(printf '%s' "$input" | jq -r '.tool_input.new_string // ""' 2>/dev/null || true)"
          ;;
        MultiEdit)
          # Every edit in the batch is one claim: the counts are summed across the whole
          # array, so a batch that unticks one box and ticks two is still a net claim.
          old="$(printf '%s' "$input" | jq -r '[(.tool_input.edits // [])[] | .old_string // ""] | join("\n")' 2>/dev/null || true)"
          new="$(printf '%s' "$input" | jq -r '[(.tool_input.edits // [])[] | .new_string // ""] | join("\n")' 2>/dev/null || true)"
          ;;
        Write)
          # A Write carries the WHOLE file and no `old_string` at all, so the old side is
          # the plan as it stands on disk. A Write that creates the file compares against
          # nothing, which makes any ticked box in it a claim — the fail-closed direction,
          # and the same answer an Edit would give.
          new="$(printf '%s' "$input" | jq -r '.tool_input.content // ""' 2>/dev/null || true)"
          old="$(cat "$LEO_DIR/PLAN.md" 2>/dev/null || true)"
          ;;
      esac
      ;;
    apply_patch)
      # Codex's edit tool: one `command` string holding a patch, whose hunks name their
      # own files. Only the .leopold/PLAN.md hunks are read — a patch that touches the
      # plan AND a source file must not be judged by the source file's `[x]`.
      patch="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"
      case "$patch" in *.leopold/PLAN.md*) ;; *) exit 0 ;; esac
      old="$(printf '%s' "$patch" | awk '
        /^\*\*\* (Add|Update|Delete) File: / { inplan = ($0 ~ /\.leopold\/PLAN\.md[[:space:]]*$/) ? 1 : 0; next }
        /^\*\*\* / { inplan = 0; next }
        inplan && /^-/ { print substr($0, 2) }' 2>/dev/null || true)"
      new="$(printf '%s' "$patch" | awk '
        /^\*\*\* (Add|Update|Delete) File: / { inplan = ($0 ~ /\.leopold\/PLAN\.md[[:space:]]*$/) ? 1 : 0; next }
        /^\*\*\* / { inplan = 0; next }
        inplan && /^\+/ { print substr($0, 2) }' 2>/dev/null || true)"
      ;;
  esac
  n_old="$(ticked "$old")"; n_new="$(ticked "$new")"
  case "$n_old" in ''|*[!0-9]*) n_old=0 ;; esac
  case "$n_new" in ''|*[!0-9]*) n_new=0 ;; esac
  [ "$n_new" -gt "$n_old" ] || exit 0
fi

# ---- what the brief calls verification ------------------------------------------------
# The `## Verification commands` section of .leopold/GUARDRAILS.md, read exactly as
# hooks/verify-receipt.sh reads it — same awk, same stripping — because the gate must
# NAME the commands whose receipts it is asking for. The two copies are deliberate: the
# project's rule is that a function moves into hooks/_lib.sh at its THIRD caller, and
# with two the drift is instead pinned by a test (scripts/test-hooks.sh asserts both
# hooks read the identical entry list out of one GUARDRAILS.md).
#
# NO SECTION, NO GATE. A brief that never said what evidence means here cannot have a
# claim of done refused for lacking it — and a project that predates this hook runs
# exactly as it did.
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
[ -n "$entries" ] || exit 0

# ---- and NOW the scope answer, on a payload that is a claim of done -------------------
# Everything that means "not a Leopold run, or not one this session conducts" leaves in
# silence — today's behavior, byte for byte. The one exception is a state.json that does
# not parse: the receipts live in that file, so the only honest answer to "has anything
# been verified since the last edit?" is that nothing can say so, and a guard answers a
# claim it cannot check with no.
if [ "$gate_ok" = "0" ]; then
  case "$gate_reason" in
    state_unreadable)
      refuse "Leopold: .leopold/state.json does not parse, so this run's verification receipts cannot be read and the evidence gate fails closed — this claim of done was refused. Fix the file (or re-run /leopold-brief); ticking items works again as soon as it parses. Nothing else is blocked: only a claim of done goes through this gate." "$via" ;;
    *) exit 0 ;;
  esac
fi

# ---- has anything been verified since the last edit? ---------------------------------
# `last_edit_at` is the last edit OUTSIDE `.leopold/` (hooks/verify-receipt.sh): the
# run's own paperwork — ticking this plan, logging a decision, writing the journal — is
# not work a verification could have covered, and counting it would deny the turn loop
# the run skill prescribes on its correct path.
#
# Both stamps are ISO-8601 UTC seconds (`%Y-%m-%dT%H:%M:%SZ`), a format whose string order
# IS its chronological order, so a lexical compare is the whole comparison.
#
#   neither field          -> allow. Today's behavior: nothing has ever been recorded, so
#                             nothing is claimed. (A run that predates the receipts hook,
#                             or one whose first edit has not landed yet.)
#   last_verify_at only    -> allow. Verified, nothing edited since.
#   last_edit_at only      -> REFUSE. Edited, never verified.
#   both, verify > edit    -> allow.
#   both, verify <= edit   -> REFUSE. Equal counts as stale on purpose: the stamps are
#                             one-second grained, and a guard that cannot tell which came
#                             first inside the same second answers the way that can only
#                             ever ask for a LATER verification, never accept an earlier
#                             lie. Re-running the command clears it.
last_edit="$(jq -r '.last_edit_at // ""' "$LEO_STATE" 2>/dev/null || true)"
last_verify="$(jq -r '.last_verify_at // ""' "$LEO_STATE" 2>/dev/null || true)"
case "$last_edit" in null) last_edit="" ;; esac
case "$last_verify" in null) last_verify="" ;; esac

fresh=0
if [ -z "$last_edit" ] && [ -z "$last_verify" ]; then fresh=1
elif [ -z "$last_edit" ] && [ -n "$last_verify" ]; then fresh=1
elif [ -n "$last_verify" ] && [[ "$last_verify" > "$last_edit" ]]; then fresh=1
fi
[ "$fresh" = "1" ] && exit 0

# ---- refuse, naming the evidence that would clear it ----------------------------------
# The list the reason prints: the entries, joined with `; `, each with its trailing shell
# comment removed. A brief writes `` - `make test`     # the gate ``; the recorder next
# door matches the COMMAND `make test` and ignores the comment (it strips one per line,
# the way a shell reads it), so the gate must ask for the same string. Printing the
# comment back would hand the run a line that is not the command whose receipt is wanted.
cmd_list="$(printf '%s\n' "$entries" | awk '
  { sub(/(^|[[:space:]])#.*$/, ""); sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "") }
  length { printf "%s%s", (n++ ? "; " : ""), $0 }
  END { print "" }')"
since="last edit ${last_edit:-none}, last passing verification ${last_verify:-none}"
if [ "$event" = "TaskCompleted" ]; then
  refuse "Leopold: done means verified — $since. run the verification first: $cmd_list. Then complete the task. (Verification commands come from .leopold/GUARDRAILS.md; the receipts come from hooks/verify-receipt.sh.)" \
    "$via" "$(jq -cn --arg e "${last_edit:-}" --arg v "${last_verify:-}" \
      --arg id "$(printf '%s' "$input" | jq -r '.task_id // ""' 2>/dev/null || true)" \
      '{last_edit_at:$e,last_verify_at:$v} + (if $id == "" then {} else {task_id:$id} end)' 2>/dev/null || echo '{}')"
fi
refuse "Leopold: this edit ticks a box in .leopold/PLAN.md, and done means verified — $since. Nothing has verified this work since it was last edited, so the claim was refused. run the verification first: $cmd_list. When one of them passes, tick the box and it goes through. Nothing else is blocked — only the tick." \
  "$via" "$(jq -cn --arg e "${last_edit:-}" --arg v "${last_verify:-}" --argjson o "${n_old:-0}" --argjson n "${n_new:-0}" \
    '{last_edit_at:$e,last_verify_at:$v,boxes_before:$o,boxes_after:$n}' 2>/dev/null || echo '{}')"
