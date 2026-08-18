#!/usr/bin/env bash
# Leopold Stop hook: state-coupled autonomous continuity.
#
# When the main agent finishes a turn, this hook reads .leopold/state.json and
# PLAN.md in the project. If a Leopold run is active and work remains with no
# stop condition met, it blocks the stop and re-injects a compact "continue"
# instruction. Otherwise it allows the session to halt.
#
# Hook contract (Claude Code Stop): read JSON on stdin. To keep going, print
# {"decision":"block","reason":"..."} and exit 0. To allow stopping, exit 0 with
# no output. Failure mode is intentionally fail-open (allow stop): a broken hook
# must never trap a session in a loop.

input="$(cat 2>/dev/null || true)"

# jq is required to parse state safely; without it, allow the stop.
command -v jq >/dev/null 2>&1 || exit 0

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -z "${cwd:-}" ] && cwd="$PWD"
LEO="$cwd/.leopold"
STATE="$LEO/state.json"

# Not a Leopold run -> normal stop.
[ -f "$STATE" ] || exit 0

now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"

# Fail SAFE and LOUD on a broken state file. Malformed JSON, or a missing/non-numeric
# budget field, means the iteration budget cannot be trusted -- the run could loop
# forever on a silently-skipped budget. Stop the run and say why, rather than continue
# blindly or die in silence.
state_invalid() {
  printf '{"ts":"%s","event":"state_invalid","reason":"%s"}\n' "$now" "$1" >> "$LEO/events.jsonl" 2>/dev/null || true
  echo "Leopold: .leopold/state.json is invalid ($1) -- stopping the run (fail-safe). Fix the file or re-run /leopold-brief." >&2
  printf '{"active":false,"stopped_reason":"state_invalid"}\n' > "$STATE" 2>/dev/null || true
  exit 0
}
jq -e . "$STATE" >/dev/null 2>&1 || state_invalid "malformed JSON"

active="$(jq -r '.active // false' "$STATE" 2>/dev/null || echo false)"
[ "$active" = "true" ] || exit 0

# A present-but-non-numeric budget field is the real hole: it would make the
# `iter >= max` test below error out (and get swallowed), silently skipping the
# budget -> unbounded loop. So any present budget field must be an integer. Missing
# fields fall back to the safe defaults below (50 / 0 / 3), so the budget still holds.
for f in iteration max_iterations consecutive_failures max_failures windows max_windows; do
  v="$(jq -r --arg k "$f" '.[$k] // empty' "$STATE" 2>/dev/null)"
  if [ -n "$v" ] && ! printf '%s' "$v" | grep -qE '^[0-9]+$'; then
    state_invalid "non-numeric $f ($v)"
  fi
done

log_event() { printf '%s\n' "$1" >> "$LEO/events.jsonl" 2>/dev/null || true; }

allow_stop() {
  local r="$1" tmp
  tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
  jq --arg r "$r" '.active=false | .stopped_reason=$r' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
  log_event "{\"ts\":\"$now\",\"event\":\"stop\",\"reason\":\"$r\"}"
  # Safety hygiene: always clear the kill switch and per-session git opt-in tokens
  # so the next run re-locks git and does not halt immediately on a stale STOP.
  rm -f "$LEO/STOP" "$LEO/ALLOW_GIT" "$LEO/ALLOW_PUSH" "$LEO/ALLOW_PUBLISH" 2>/dev/null || true
  # on_finish policy (GUARDRAILS.md): archive the run logs on a clean finish.
  if [ "$r" = "plan_complete" ]; then
    arch="$LEO/runs/$(date -u +%Y%m%dT%H%M%SZ)"
    if grep -qiE '^[[:space:]]*-?[[:space:]]*on_finish:[[:space:]]*archive' "$LEO/GUARDRAILS.md" 2>/dev/null; then
      mkdir -p "$arch" 2>/dev/null || true
      [ -f "$LEO/DECISIONS.md" ] && mv "$LEO/DECISIONS.md" "$arch/" 2>/dev/null || true
      [ -f "$LEO/events.jsonl" ] && mv "$LEO/events.jsonl" "$arch/" 2>/dev/null || true
      cp "$LEO/PLAN.md" "$arch/" 2>/dev/null || true
    fi
    # The checkpoint is RUN state and this run is over: it goes with the run, always
    # (on_finish or not). Left in place, a dead window's state would seed the NEXT
    # run on this project as if it were a continuation.
    if [ -f "$LEO/CHECKPOINT.md" ]; then
      mkdir -p "$arch" 2>/dev/null || true
      mv "$LEO/CHECKPOINT.md" "$arch/" 2>/dev/null || true
    fi
  fi
  exit 0
}

# Kill switch.
if [ -f "$LEO/STOP" ]; then allow_stop "kill_switch"; fi

iter="$(jq -r '.iteration // 0' "$STATE" 2>/dev/null || echo 0)"
max_iter="$(jq -r '.max_iterations // 50' "$STATE" 2>/dev/null || echo 50)"
fails="$(jq -r '.consecutive_failures // 0' "$STATE" 2>/dev/null || echo 0)"
max_fails="$(jq -r '.max_failures // 3' "$STATE" 2>/dev/null || echo 3)"

# Window identity for THIS turn, resolved ONCE: the roll branch below enforces the
# ceiling and the re-injected reason names it (`Window N/max`), so the number the agent
# is told and the number the roll enforces cannot drift apart. `windows` counts from 1
# (state carries it across reseeds); `max_windows` is state > GUARDRAILS.md > 10.
windows="$(jq -r '.windows // 1' "$STATE" 2>/dev/null || echo 1)"
case "$windows" in (*[!0-9]*|"") windows=1 ;; esac
max_windows="$(jq -r '.max_windows // empty' "$STATE" 2>/dev/null || true)"
if [ -z "$max_windows" ]; then
  mw_line="$(grep -m1 -iE '^[[:space:]]*-?[[:space:]]*(\*\*)?max_windows(\*\*)?[[:space:]]*:' "$LEO/GUARDRAILS.md" 2>/dev/null || true)"
  max_windows="$(printf '%s' "${mw_line#*:}" | grep -oE '[0-9]+' 2>/dev/null | head -1)"
fi
case "$max_windows" in (*[!0-9]*|"") max_windows=10 ;; esac

# Budgets. An iteration budget is a COST CEILING the user set: it stops, always.
if [ "$iter" -ge "$max_iter" ] 2>/dev/null; then allow_stop "iteration_budget"; fi

# Repeated failure is NOT a budget. Failing the same way three times is the run running
# out of ideas, and "a person should look at this" is a decision an agent can make: it
# gets ONE more attempt, and that attempt must take a genuinely different approach,
# decided under the role the failure calls for and written to DECISIONS.md with a
# Reversal. This mirrors packages/driver/src/rescue.ts so the in-session engine and the
# driver give a stuck item the same number of last chances -- one.
#
# THE CEILING DOES NOT MOVE: max_failures is never written, the extra attempt is charged
# as a turn like any other, and `failure_rescue_used` marks it spent for the whole run
# (persisted, so a resumed run inherits it). The second time the ceiling is reached the
# run stops with `repeated_failure`, exactly as it always did.
RESCUE_NOTE=""
RESCUE_GRANT=0
if [ "$fails" -ge "$max_fails" ] 2>/dev/null; then
  rescued="$(jq -r '.failure_rescue_used // false' "$STATE" 2>/dev/null || echo false)"
  if [ "$rescued" = "true" ]; then allow_stop "repeated_failure"; fi
  # Decided here, SPENT at the bottom. Four more `allow_stop` checks come after this
  # point (context_budget, plan_complete, awaiting_human, no_progress); marking the
  # rescue used up here burned it on a turn that never happened and wrote a
  # `failure_rescue` event claiming an attempt nobody ever made.
  RESCUE_GRANT=1
  RESCUE_NOTE="LAST ATTEMPT ON THIS ITEM. It has failed $fails times in a row -- the ceiling this run allows ($max_fails) -- and the run gets exactly ONE more attempt before it stops. Do NOT refine the approach that failed: work out what the previous framing got wrong, then SYNTHESIZE the role this failure actually needs (name, the expertise it demands, what it optimizes for, bound by .leopold/CHARTER.md's hard rules), take that role, and attack the item a genuinely different way -- a different entry point, mechanism, decomposition or dropped assumption. Append the call to .leopold/DECISIONS.md naming the role, the approach, why it differs from what failed, and a Reversal line. You may NOT raise max_failures or any budget, clear the kill switch, or edit .leopold/GUARDRAILS.md; git stays locked. If this attempt fails too, say so plainly and the run stops. "
fi

# Context budget — a WINDOW ROLL, not a death. A long run accumulates context every turn;
# on a big-context model it never auto-compacts, so each turn re-bills the whole (growing)
# transcript (one report: a session ballooned to ~6MB over 681 turns). The window is a
# consumable, the RUN is not:
#   * At ~80% of max_context_mb (default 5) the turn is blocked with a CHECKPOINT
#     instruction: write or merge .leopold/CHECKPOINT.md — the ONE contract defined in
#     packages/driver/src/checkpoint.ts (fixed sections, merge-don't-nest, 32768-byte cap
#     that fails loud; packages/driver/test/checkpoint.test.ts fails the build if this
#     hook's wording drifts from that contract) — then continue the plan.
#   * At 100% the stop happens with the same reason it always had (`context_budget` —
#     consumers read it), but the state says roll: `windows` is incremented, the
#     checkbox vector is snapshotted for the cross-window progress gate, and
#     `checkpoint_written` records whether the agent actually wrote the checkpoint.
#     A missing checkpoint is LOUD in the stop message, never silent, and the message
#     always names the resume path. The brief persists -> /leopold-run (relaunched by
#     `leopold watch` under `continuity: auto`, or by a human) reseeds the next window.
#   * Rolling is free, PRODUCING is mandatory: each roll records how many plan items the
#     ending window closed (checkbox vector diff vs the window-start snapshot). Two
#     consecutive windows closing zero items stop the run (`no_progress_across_windows`)
#     with no resume pointer, and `max_windows` (state > GUARDRAILS > 10) caps the total
#     windows one run may consume.
CHECKPOINT_SECTIONS="In-Flight Item, Files and Code, Errors and Fixes, Decisions This Run, Learned Constraints, Current Work, Next Step"
max_ctx_mb="$(jq -r '.max_context_mb // 5' "$STATE" 2>/dev/null || echo 5)"
case "$max_ctx_mb" in (*[!0-9]*|"") max_ctx_mb=5 ;; esac
ctx_mb=0
CHECKPOINT_NOTE=""
tpath="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
if [ -n "$tpath" ] && [ -f "$tpath" ]; then
  ctx_bytes="$(wc -c < "$tpath" 2>/dev/null || echo 0)"
  ctx_mb="$(awk "BEGIN{printf \"%.1f\", ${ctx_bytes:-0}/1048576}" 2>/dev/null || echo 0)"
  if [ "$max_ctx_mb" -gt 0 ] 2>/dev/null; then
    ctx_pct="$(( ${ctx_bytes:-0} * 100 / (max_ctx_mb * 1048576) ))" 2>/dev/null || ctx_pct=0
  else
    # max_context_mb: 0 always stopped immediately, PLAIN — no roll, no windows++, no
    # resume pointer. Whoever set 0 asked for no context spend at all; handing them a
    # relaunch loop instead would be the opposite.
    allow_stop "context_budget"
  fi
  # A finished plan NEVER rolls, whatever the transcript weighs. The final turn is
  # exactly when the transcript is largest, so "closed the last item while crossing the
  # budget" is common — and it must end as plan_complete (which archives the checkpoint
  # and the run), not as a roll with a resume pointer to nothing, and never as a
  # no_progress verdict on a run that just finished. Falling through reaches the
  # plan_complete check below, the one place that owns the completion path.
  roll_open="$(grep -cE '^[[:space:]]*- \[ \]' "$LEO/PLAN.md" 2>/dev/null || true)"
  if [ "$ctx_pct" -ge 100 ] 2>/dev/null && [ "${roll_open:-0}" -gt 0 ] 2>/dev/null; then
    # The window is full: roll it. Same bytes threshold as ever (bytes >= max*1MiB), same
    # stopped_reason — the new semantics ride NEW state fields only.
    #
    # `checkpoint_written` means what it says: the file must LOOK like the contract this
    # hook just described (title line + under the 32768-byte cap), not merely exist — a
    # leftover or garbage file claiming "the next window continues from it" points the
    # relaunch at a lie.
    checkpoint_written=false
    if [ -s "$LEO/CHECKPOINT.md" ] \
       && head -1 "$LEO/CHECKPOINT.md" 2>/dev/null | grep -q '^# Leopold Checkpoint' \
       && [ "$(wc -c < "$LEO/CHECKPOINT.md" 2>/dev/null || echo 99999)" -le 32768 ] 2>/dev/null; then
      checkpoint_written=true
    fi
    # Current checkbox vector (one char per checkbox, file order: x=closed, o=open).
    plan_vec="$(grep -E '^[[:space:]]*- \[( |x|X)\]' "$LEO/PLAN.md" 2>/dev/null \
      | sed -E 's/^[[:space:]]*- \[[xX]\].*/x/; s/^[[:space:]]*- \[ \].*/o/' | tr -d '\n')"

    # ---- The livelock gate: rolling is free, producing is mandatory ------------------
    # Items CLOSED in the ending window = the diff of the current vector against the
    # snapshot taken when this window STARTED (`window_plan_vector`, carried through the
    # reseed). A checkbox counts when it is `x` now and was not `x` then; a box beyond
    # the snapshot's length is a new item, and closing one is progress too. A fresh run
    # has no snapshot, so every checked box counts — that can only make window 1 look
    # MORE productive, the safe direction for a gate that ends runs. A reseed is not
    # progress; only checked boxes are.
    prev_vec="$(jq -r '.window_plan_vector // ""' "$STATE" 2>/dev/null || true)"
    closed="$(awk -v p="$prev_vec" -v c="$plan_vec" 'BEGIN{n=0
      for(i=1;i<=length(c);i++){pc=(i<=length(p))?substr(p,i,1):"o"
        if(substr(c,i,1)=="x" && pc!="x")n++}
      print n}' 2>/dev/null || echo 0)"
    case "$closed" in (*[!0-9]*|"") closed=0 ;; esac
    zstreak="$(jq -r '.window_zero_streak // 0' "$STATE" 2>/dev/null || echo 0)"
    case "$zstreak" in (*[!0-9]*|"") zstreak=0 ;; esac
    if [ "$closed" -eq 0 ] 2>/dev/null; then zstreak=$((zstreak + 1)); else zstreak=0; fi
    # The per-window progress record is appended UNCONDITIONALLY — the stopped state
    # must say what each window produced, especially the windows that produced nothing.
    tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
    jq --argjson c "$closed" --argjson z "$zstreak" \
       '.window_progress=((.window_progress // []) + [$c]) | .window_zero_streak=$z' \
       "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
    if [ "$zstreak" -ge 2 ] 2>/dev/null; then
      # Two consecutive windows closed zero plan items: the run is rolling without
      # producing. Stop with the honest reason and write NO resume pointer — windows is
      # not incremented, no fresh snapshot is taken, and the reason is not
      # `context_budget`, so nothing relaunches a third window to "give it one more
      # shot". That third window is the livelock this gate exists to stop.
      stuck="$(grep -m1 -E '^[[:space:]]*- \[ \]' "$LEO/PLAN.md" 2>/dev/null \
        | sed -E 's/^[[:space:]]*- \[ \][[:space:]]*//')"
      log_event "$(jq -cn --arg ts "$now" --argjson a "$((windows - 1))" --argjson b "$windows" \
        --arg s "${stuck:-}" \
        '{ts:$ts,event:"no_progress_across_windows",windows:[$a,$b],stuck_item:$s}' \
        2>/dev/null || echo '{}')"
      {
        echo "Leopold: windows $((windows - 1)) and $windows both closed ZERO plan items -- the run stopped producing, so it stops running (no_progress_across_windows)."
        [ -n "${stuck:-}" ] && echo "Stuck on: $stuck"
        echo "No resume pointer was written and nothing relaunches this run. A person should look at the stuck item; when it is unblocked, /leopold-run starts a deliberate new attempt."
      } >&2
      allow_stop "no_progress_across_windows"
    fi

    # ---- max_windows: the ceiling on total context windows for one RUN ---------------
    # Resolved once at the top (state.json > GUARDRAILS.md > 10). When the ending window
    # IS the ceiling, the run stops naming it — no roll, no resume pointer.
    if [ "$windows" -ge "$max_windows" ] 2>/dev/null; then
      log_event "$(jq -cn --arg ts "$now" --argjson w "$windows" --argjson m "$max_windows" \
        '{ts:$ts,event:"max_windows",window:$w,max_windows:$m}' 2>/dev/null || echo '{}')"
      {
        echo "Leopold: window $windows is the last this run allows (max_windows: $max_windows) -- the window ceiling is reached, so the run stops here."
        echo "No resume pointer was written and nothing relaunches this run. Raise max_windows in .leopold/GUARDRAILS.md if the run genuinely needs more windows, then /leopold-run."
      } >&2
      allow_stop "max_windows"
    fi

    # The window produced (or the streak is still under the gate) and the ceiling holds:
    # roll it. Snapshot the checkbox vector at the moment this window ends — the gate
    # diffs the NEXT roll against it.
    next_windows=$((windows + 1))
    tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
    jq --argjson w "$next_windows" --argjson cw "$checkpoint_written" --arg vec "$plan_vec" \
       '.windows=$w | .checkpoint_written=$cw | .window_plan_vector=$vec' \
       "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
    log_event "$(jq -cn --arg ts "$now" --argjson w "$windows" --argjson cw "$checkpoint_written" \
      --arg vec "$plan_vec" --argjson cm "${ctx_mb:-0}" --argjson ic "$closed" --argjson z "$zstreak" \
      '{ts:$ts,event:"window_roll",window:$w,checkpoint_written:$cw,plan_vector:$vec,context_mb:$cm,items_closed:$ic,zero_streak:$z}' \
      2>/dev/null || echo '{}')"
    {
      echo "Leopold: the context window is full (${ctx_mb} MB, budget ${max_ctx_mb} MB) -- window $windows closed. This is a window roll, not a death: the run's state and brief persist."
      if [ "$checkpoint_written" = "true" ]; then
        echo "Checkpoint: .leopold/CHECKPOINT.md is written; the next window continues from it."
      else
        echo "WARNING: no .leopold/CHECKPOINT.md was written before the window filled -- the next window resumes from the brief and PLAN.md alone, without this window's working state."
      fi
      echo "Resume: run /leopold-run in this project (under continuity: auto, leopold watch relaunches it automatically)."
    } >&2
    allow_stop "context_budget"
  elif [ "$ctx_pct" -ge 80 ] 2>/dev/null; then
    # Proactive maintenance: checkpoint BEFORE the window dies, while there is still
    # context to write it from. Re-injected every turn in the band so the checkpoint
    # stays current (the instruction is merge-shaped, so repeating it is idempotent).
    # The `checkpoint_instruction` event is logged at the bottom, once the turn is
    # certain — the same decided-here-spent-there split the rescue uses, so the event
    # stream never claims an instruction a stop condition swallowed.
    CHECKPOINT_NOTE="CONTEXT WINDOW AT ${ctx_pct}% OF BUDGET (${ctx_mb} of ${max_ctx_mb} MB). Before anything else this turn, write or merge .leopold/CHECKPOINT.md so the next window can continue this run when this one fills. The format is fixed: the title line \`# Leopold Checkpoint\`, then exactly these seven \`##\` sections, in this order: ${CHECKPOINT_SECTIONS}. It carries RUN state only -- never restate MISSION, CHARTER, GUARDRAILS or the plan; the next window re-reads those files itself. If the file already exists, MERGE into ONE flat document: In-Flight Item, Current Work and Next Step are replaced by the current view; in the other sections keep still-true lines, append new ones, drop stale ones -- never paste a prior checkpoint (its title or any duplicate heading) inside the new one. Keep the whole file under 32768 bytes; if it will not fit, consolidate harder -- never truncate. Then continue the plan as normal. "
  fi
fi

# ---- The plan grammar: node kinds -------------------------------------------------
# PLAN.md is a graph. An item may declare a node kind -- `@node work|gate|human|tool|
# verify|feedback`, or the shorthands `@work` / `@gate` / `@human` / `@tool` /
# `@verify` / `@feedback` -- inline
# after the checkbox or on a marker line under it, each optionally followed by a label
# (`@gate security Review auth`). The last kind written wins; an item that declares none
# is `work`, so a plan written before this grammar existed parses to exactly what it
# parsed to before and takes an identical path through this hook.
#
# The in-session engine acts on ONE kind: `human`, and what it does with one depends on
# the judgment posture (`autonomy`, resolved below). The others -- including `feedback`,
# whose plan amendments are bounded and applied by the driver (packages/driver/src/
# amend.ts) -- are the driver's business, and re-inject exactly as they always have.
#
# This mirrors packages/driver/src/plan.ts. The two cannot share code -- this hook is
# bash + jq on purpose, so it runs with no Node and no install -- so
# packages/driver/test/hook-kinds.test.ts parses the same plans with both and fails the
# build the moment they disagree.

DEP_RE='^\((after|deps)[[:space:]]*:[[:space:]]*[0-9,[:space:]]+\)[[:space:]]*'
KIND_RE='^@(node([[:space:]]+|[[:space:]]*:[[:space:]]*))?(work|gate|human|tool|verify|feedback)'
CHECKBOX_RE='^[[:space:]]*- \[( |x|X)\](.*)$'
LABEL_EXPLICIT_RE='^[A-Za-z][A-Za-z0-9_./-]*:([[:space:]]+|$)'
LABEL_BARE_RE='^[a-z][a-z0-9_./-]*([[:space:]]+|$)'
SEP_RE='^[[:space:]]*:?[[:space:]]*'

_trim() { # echo $1 without leading/trailing blanks
  local s="$1"
  while [ "${s#[[:space:]]}" != "$s" ]; do s="${s#[[:space:]]}"; done
  while [ "${s%[[:space:]]}" != "$s" ]; do s="${s%[[:space:]]}"; done
  printf '%s' "$s"
}
_ltrim() { local s="$1"; while [ "${s#[[:space:]]}" != "$s" ]; do s="${s#[[:space:]]}"; done; printf '%s' "$s"; }
_lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Does $1 start with a node-kind marker? Sets KIND_MATCH (the kind) and KIND_REST (what
# follows it, label stripped); returns 1 when there is no marker. $2 is 1 on the item's
# own line, where a bare lowercase label only counts when item text follows it.
match_kind() {
  local s="$1" inline="$2" low after tail
  low="$(_lower "$s")"
  [[ "$low" =~ $KIND_RE ]] || return 1
  KIND_MATCH="${BASH_REMATCH[3]}"
  after="${s:${#BASH_REMATCH[0]}}"
  # A marker ends at a word boundary: `@workflow` is prose, not `@work`.
  case "$after" in [A-Za-z0-9_]*) return 1 ;; esac
  [[ "$after" =~ $SEP_RE ]] && after="${after:${#BASH_REMATCH[0]}}"
  if [[ "$after" =~ $LABEL_EXPLICIT_RE ]]; then
    after="${after:${#BASH_REMATCH[0]}}"
  elif [ "$KIND_MATCH" != "tool" ] && [[ "$after" =~ $LABEL_BARE_RE ]]; then
    # Never on a `@tool` node: its text IS the command, so `make` in `@tool make test`
    # is a word of the command, not a label. Tool nodes label the explicit way.
    tail="${after:${#BASH_REMATCH[0]}}"
    if [ "$inline" -eq 0 ] || [ -n "$(_trim "$tail")" ]; then after="$tail"; fi
  fi
  KIND_REST="$after"
  return 0
}

# The kind and text an item's own line declares -> ITEM_KIND, ITEM_TEXT. Strips the one
# leading `(after: 1, 3)` marker and any node-kind markers, in either order.
parse_item_line() {
  local rest="$1" saw_dep=0 low s
  ITEM_KIND="work"
  while :; do
    if [ "$saw_dep" -eq 0 ]; then
      low="$(_lower "$rest")"
      if [[ "$low" =~ $DEP_RE ]]; then
        saw_dep=1
        rest="${rest:${#BASH_REMATCH[0]}}"
        continue
      fi
    fi
    s="$(_ltrim "$rest")"
    if match_kind "$s" 1; then
      ITEM_KIND="$KIND_MATCH"
      rest="$(_trim "$KIND_REST")"
      continue
    fi
    break
  done
  ITEM_TEXT="$(_trim "$rest")"
}

# The first OPEN item of a plan -> FIRST_OPEN_INDEX (1-based over all checkboxes, 0 when
# there is none), FIRST_OPEN_KIND, FIRST_OPEN_TEXT. That item is the one the re-injected
# instruction tells the agent to pick, so it is the node the in-session engine is at.
plan_scan_first_open() {
  FIRST_OPEN_INDEX=0; FIRST_OPEN_KIND=""; FIRST_OPEN_TEXT=""
  [ -f "$1" ] || return 0
  local idx=0 line body bare
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ $CHECKBOX_RE ]]; then
      [ "$FIRST_OPEN_INDEX" -gt 0 ] && break   # the open item's marker lines ended
      idx=$((idx + 1))
      [ "${BASH_REMATCH[1]}" = " " ] || continue
      body="${BASH_REMATCH[2]}"
      case "$body" in [[:space:]]*) body="${body#?}" ;; esac
      parse_item_line "$body"
      FIRST_OPEN_INDEX=$idx; FIRST_OPEN_KIND="$ITEM_KIND"; FIRST_OPEN_TEXT="$ITEM_TEXT"
      continue
    fi
    [ "$FIRST_OPEN_INDEX" -gt 0 ] || continue
    bare="$(_trim "$line")"
    case "$bare" in
      @*) if match_kind "$bare" 0; then FIRST_OPEN_KIND="$KIND_MATCH"; fi ;;
    esac
  done < "$1"
  return 0
}

# Plan complete? (no unchecked checkboxes remain)
PLAN="$LEO/PLAN.md"
open_items="$(grep -cE '^[[:space:]]*- \[ \]' "$PLAN" 2>/dev/null || true)"
open_items="${open_items:-0}"
if [ "$open_items" -eq 0 ] 2>/dev/null; then allow_stop "plan_complete"; fi

# ---- The judgment posture: autonomy full | ask ------------------------------------
# ONE posture, read from the same two places by both engines. This mirrors
# resolveAutonomy()/autonomyFrom() in packages/driver/src/config.ts: explicit
# `LEOPOLD_AUTONOMY` > GUARDRAILS.md > `full`, and the same three spellings of "ask"
# (ask|halt|human). The driver's extra source is its CLI flag, which an in-session run has
# no equivalent of; there is deliberately no third channel here, because a posture the
# hook read and the driver did not is exactly the drift this file exists to prevent.
#
# A value neither engine recognizes is treated as ABSENT rather than as the strict posture
# -- an unreadable line must not silently halt a run -- and the default is `full`, so a
# brief that never mentions autonomy is autonomous.
autonomy_word() { # $1 = raw value -> full | ask | "" (unrecognized)
  case "$(_lower "$(_trim "${1:-}")")" in
    full) printf 'full' ;;
    ask|halt|human) printf 'ask' ;;
    *) printf '' ;;
  esac
}
AUTONOMY="$(autonomy_word "${LEOPOLD_AUTONOMY:-}")"
if [ -z "$AUTONOMY" ]; then
  g_line="$(grep -m1 -iE '^[[:space:]]*-?[[:space:]]*(\*\*)?autonomy(\*\*)?[[:space:]]*:' "$LEO/GUARDRAILS.md" 2>/dev/null || true)"
  g_val="$(_trim "${g_line#*:}")"
  AUTONOMY="$(autonomy_word "${g_val%%[![:alnum:]]*}")"   # first word: drops a trailing `# comment`
fi
[ -n "$AUTONOMY" ] || AUTONOMY="full"

# A `@human` node is where the plan asked a PERSON to decide, and under the default
# posture no person is coming: the run SYNTHESIZES the role that decision needs, assumes
# it, does the work and records the call with its Reversal. That is the driver's behavior
# (packages/driver/src/loop.ts -> processItem, persona.ts), so the in-session engine does
# the same thing here and a plan means the same on both engines. Under `autonomy: ask`
# both engines end the turn at the node instead, with the same `awaiting_human` reason and
# the same event -- the posture, not the engine, decides.
#
# The seam this rests on is untouched: a persona DECIDES, it never executes. What ENFORCES
# that is narrower than it is tempting to write, and the note below is careful about the
# difference: hooks/guard-irreversible.sh denies `git commit` and `git push` and says so
# itself ("that is the ENTIRE scope"); scripts/test-guard.sh deliberately asserts that
# `gh pr create`, `gh release create`, `npm publish` and `cargo publish` are ALLOWED and
# that edits -- GUARDRAILS.md included -- are never guarded, and no hook protects the
# budgets in state.json either. Telling a synthesized role that a hook will catch
# `npm publish` is exactly how it stops holding back on the one node kind where
# irreversible calls live, so the note names the two real denials as enforced and the rest
# as rules the role has to keep on its own. Same sentence, same split, as
# packages/driver/src/persona.ts (NO_EXECUTION_CLAUSE) -- the two engines must not drift on
# where the trust boundary actually sits.
plan_scan_first_open "$PLAN"
HUMAN_NOTE=""
if [ "$FIRST_OPEN_KIND" = "human" ]; then
  if [ "$AUTONOMY" = "ask" ]; then
    log_event "$(jq -cn --arg ts "$now" --argjson i "$FIRST_OPEN_INDEX" --arg t "$FIRST_OPEN_TEXT" \
      '{ts:$ts,event:"awaiting_human",item:$i,text:$t}' 2>/dev/null || echo '{}')"
    {
      echo "Leopold: plan item $FIRST_OPEN_INDEX is a @human node -- a person decides it (autonomy: ask)."
      [ -n "$FIRST_OPEN_TEXT" ] && echo "  $FIRST_OPEN_TEXT"
      echo "The run is paused (awaiting_human). Answer it, mark the item [x] in .leopold/PLAN.md, then /leopold-run to resume."
    } >&2
    allow_stop "awaiting_human"
  fi
  # ONCE per node, not once per turn. This branch is re-entered every turn the @human item
  # stays open, so a node that takes five turns wrote five identical `persona` records --
  # and leopold-watch.py renders `persona` as sev-high, so the Canvas showed five
  # high-severity entries for one decision. The driver logs it once per node, inside
  # processItem; the marker keeps the two engines saying the same thing.
  persona_logged="$(jq -r '.persona_logged_item // empty' "$STATE" 2>/dev/null || true)"
  if [ "$persona_logged" != "$FIRST_OPEN_INDEX" ]; then
    log_event "$(jq -cn --arg ts "$now" --argjson i "$FIRST_OPEN_INDEX" --arg t "$FIRST_OPEN_TEXT" \
      '{ts:$ts,event:"persona",fork:"human",engine:"hook",item:$i,text:$t}' 2>/dev/null || echo '{}')"
    tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
    jq --argjson i "$FIRST_OPEN_INDEX" '.persona_logged_item=$i' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
  fi
  {
    echo "Leopold: plan item $FIRST_OPEN_INDEX is a @human node -- no person is coming (autonomy: full)."
    [ -n "$FIRST_OPEN_TEXT" ] && echo "  $FIRST_OPEN_TEXT"
    echo "The run synthesizes the role this decision needs and decides it; the call lands in .leopold/DECISIONS.md with a Reversal. git stays locked."
  } >&2
  HUMAN_NOTE="THIS ITEM IS A @human NODE (plan item $FIRST_OPEN_INDEX${FIRST_OPEN_TEXT:+: $FIRST_OPEN_TEXT}). The plan asked a person to decide it and no person is coming -- you decide it, and you do the work. Before anything else, SYNTHESIZE the role this decision actually needs: a name, a specific role title, the expertise the item genuinely demands, what that role optimizes for, and the hard rules from .leopold/CHARTER.md that bind it (lift them verbatim -- 'an agent' is not a persona, it is the same generic answer with a hat on). Then TAKE that role and complete the item under it. Append the call to .leopold/DECISIONS.md naming the persona (name and role), the fork (the @human node and what it asked), the charter basis for the call, and a Reversal line saying concretely how a human undoes it -- a decision with no Reversal is not done. You DECIDE; you do not ship. Two things are enforced for you: the Leopold guard denies \`git commit\` and \`git push\` (force-push always), and that is its entire scope -- stage the work and say what you decided. EVERYTHING ELSE IS ON YOU, because nothing blocks it: do not run git tag, do not publish a package, do not cut a release, do not open an external PR, and never raise a budget or iteration limit, clear the kill switch, or edit .leopold/GUARDRAILS.md. Treat those as hard denials even though no hook will stop you. Mark the item [x] in .leopold/PLAN.md when the work is done. "
fi

# Loop detection: if the SET of open plan items is byte-identical for N consecutive
# turns, the run is thrashing without progress (no item checked off, no item added) ->
# stop and report rather than burn the whole iteration budget hammering one spot.
max_np="$(jq -r '.max_no_progress // 6' "$STATE" 2>/dev/null || echo 6)"
case "$max_np" in (*[!0-9]*|"") max_np=6 ;; esac
sig="$(grep -E '^[[:space:]]*- \[ \]' "$PLAN" 2>/dev/null | cksum | awk '{print $1}')"
last_sig="$(jq -r '.progress_sig // empty' "$STATE" 2>/dev/null || true)"
np="$(jq -r '.no_progress // 0' "$STATE" 2>/dev/null || echo 0)"
case "$np" in (*[!0-9]*|"") np=0 ;; esac
if [ "$sig" = "$last_sig" ] && [ -n "$last_sig" ]; then np=$((np + 1)); else np=0; fi
if [ "$np" -ge "$max_np" ] 2>/dev/null; then allow_stop "no_progress"; fi

# Otherwise: continue. The turn is now certain, so a rescue decided above is spent HERE —
# and only here, so it is charged against an attempt that actually runs.
if [ "$RESCUE_GRANT" = "1" ]; then
  tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
  jq '.failure_rescue_used=true' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
  log_event "$(jq -cn --arg ts "$now" --argjson f "$fails" --argjson m "$max_fails" \
    '{ts:$ts,event:"failure_rescue",engine:"hook",failures:$f,max_failures:$m,extra_attempts:1}' 2>/dev/null || echo '{}')"
fi
if [ -n "$CHECKPOINT_NOTE" ]; then
  log_event "$(jq -cn --arg ts "$now" --argjson p "${ctx_pct:-0}" --argjson cm "${ctx_mb:-0}" \
    '{ts:$ts,event:"checkpoint_instruction",context_pct:$p,context_mb:$cm}' 2>/dev/null || echo '{}')"
fi

# Increment the iteration counter; persist the progress signature.
next=$((iter + 1))
tmp="$(mktemp 2>/dev/null || echo "$STATE.tmp")"
jq --argjson n "$next" --arg t "$now" --argjson np "$np" --arg sig "$sig" --argjson cm "${ctx_mb:-0}" --arg tp "${tpath:-}" \
   '.iteration=$n | .last_turn=$t | .no_progress=$np | .progress_sig=$sig | .context_mb=$cm
    | (if $tp != "" then .transcript_path=$tp else . end)' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE" || true
log_event "{\"ts\":\"$now\",\"event\":\"turn_start\",\"iteration\":$next,\"open_items\":$open_items,\"no_progress\":$np}"

# The re-grounding sentence, defined ONCE for the whole bash surface and injected into
# every continued turn. A continuation follows narration from earlier in the window (or
# a reseeded one), and the workspace may have outrun it. The driver's retry and rescue
# leads carry the SAME words (packages/driver/src/worker.ts, REGROUND_SENTENCE);
# packages/driver/test/reground.test.ts fails the build the moment the two surfaces
# drift, and scripts/test-hooks.sh asserts this is the hook's only copy.
REGROUND_SENTENCE="Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current."

reason="${CHECKPOINT_NOTE}${RESCUE_NOTE}${HUMAN_NOTE}Leopold autonomous mode is ACTIVE (turn $next/$max_iter, $open_items open plan items). Window $windows/$max_windows. $REGROUND_SENTENCE Do not stop. Steps: (1) Read .leopold/PLAN.md and pick the next unchecked item. (2) Complete it; reach for the gstack playbook skill that fits the situation. (3) On any fork, apply .leopold/CHARTER.md and the decision protocol: if the call is reversible OR the charter is clear, decide it yourself, append the decision to .leopold/DECISIONS.md, and keep going; stop only for an irreversible AND ambiguous fork, a charter contradiction, or a mission-premise change. (4) Mark the finished item as done ([x]) in PLAN.md. Hard rules: the guard denies git commit and git push. Nothing else is enforced for you, so the rest is yours to keep: no tagging, no publishing, no external PR, no raising a budget. Never edit files outside this project, and never touch .leopold/GUARDRAILS.md or the hooks. When the plan is complete or a stop condition is met, write a short final summary and then stop. End that summary with a section titled \"What I decided for you\": every call you made on the human's behalf, read back from .leopold/DECISIONS.md, riskiest first, one line each naming the persona and the Reversal -- and nothing at all if you made none."

jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
