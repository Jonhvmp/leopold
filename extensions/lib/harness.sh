#!/usr/bin/env bash
# Leopold — shared harness wiring helper.
#
# Leopold runs on more than one agent harness, and every harness wants the same
# hook declared in a different file format: Claude Code reads JSON out of
# ~/.claude/settings.json, Codex CLI reads TOML out of ~/.codex/config.toml.
# The format-specific writer lives HERE and only here. Four extensions plus the
# two installers call it; nobody pastes a TOML writer into their own install.sh.
# That duplication is exactly how the two harnesses silently drift apart.
#
# Contract for every writer (the one scripts/install-codex.sh proved in the field):
#   1. back the target up before touching it            (<file>.<tag>.bak)
#   2. write into a temp file, never in place
#   3. idempotent — wiring the same hook N times leaves exactly one entry
#   4. VALIDATE the result before it lands
#   5. on invalid output: leave the original alone, print the block the user can
#      paste by hand, return non-zero. Never leave a config the harness cannot read.
#
# Usage:
#   . "$(dirname "${BASH_SOURCE[0]}")/../lib/harness.sh"
#   leo_wire_hooks leopold-enhance "UserPromptSubmit||python3 $DIR/enhance.py --event user-prompt|30"
#
# A hook spec is a single pipe-delimited string:  EVENT|MATCHER|COMMAND|TIMEOUT
# MATCHER and TIMEOUT may be empty. EVENT, COMMAND and TIMEOUT must not contain a
# literal "|" (hook commands are an interpreter plus a path plus flags — they
# never do). MATCHER MAY contain "|" — both harnesses read matchers as regex, so
# alternation ("mcp__.*|WebFetch") is a legitimate matcher; the parser anchors
# EVENT at the front and COMMAND|TIMEOUT at the back and gives MATCHER the rest.

# The tree this copy of harness.sh was installed from: <root>/extensions/lib/harness.sh
# in the checkout AND in the asset home, so <root>/hooks resolves in both. Resolved
# once, at source time, because a caller may `cd` before it wires anything.
_LEO_LIB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd || true)"

# ---- homes ------------------------------------------------------------------

leo_claude_home() { printf '%s\n' "${CLAUDE_HOME:-$HOME/.claude}"; }
leo_codex_home()  { printf '%s\n' "${CODEX_HOME:-$HOME/.codex}"; }
leo_settings_file() { printf '%s\n' "$(leo_claude_home)/settings.json"; }
leo_config_file()   { printf '%s\n' "$(leo_codex_home)/config.toml"; }

# The asset home: hooks, templates, extensions. Stays under ~/.claude whenever
# Claude Code is in play so existing installs keep working without a migration;
# a Codex-only machine gets its own. Mirrors install.sh — keep the two in step.
leo_asset_home() {
  if [ -n "${LEOPOLD_HOME:-}" ]; then printf '%s\n' "$LEOPOLD_HOME"; return; fi
  case " $(leo_harness_targets) " in
    *" claude "*) printf '%s\n' "$(leo_claude_home)/leopold" ;;
    *)            printf '%s\n' "$(leo_codex_home)/leopold" ;;
  esac
}

# An extension's data home: its engine plus whatever state it keeps.
#
# ONE directory for the whole machine, deliberately independent of which harness
# is being wired. These payloads hold user-level state — the enhancer's on/off
# switch and learned profile, ovmem's committed-transcript offsets and access log —
# and that state is about the USER, not about the agent they happened to open. A
# per-harness dir would give one person two contradictory answers and two
# half-learned profiles.
#
# Resolution order (mirrored EXACTLY by payload/enhance.py and payload/ovmem.py —
# keep the three in step), where <claude> is CLAUDE_HOME or ~/.claude and <codex>
# is CODEX_HOME or ~/.codex:
#   1. LEOPOLD_HOME/<name>   the documented asset-home override
#   2. an existing install   <claude>/<name>, else <codex>/<name>
#   3. an existing home      <claude>, else <codex>
#   4. <claude>/<name>       the historical default, so a fresh Claude box is unchanged
# Claude first at every step: an existing ~/.claude install must never be migrated.
# Each caller layers its own explicit override (LEOPOLD_ENHANCE_DIR, LEOPOLD_OVMEM_DIR)
# on top, for installers and hermetic tests.
_leo_data_dir() { # <name>
  local n="${1:?_leo_data_dir: name}"
  if [ -n "${LEOPOLD_HOME:-}" ]; then printf '%s\n' "$LEOPOLD_HOME/$n"; return; fi
  local c x; c="$(leo_claude_home)"; x="$(leo_codex_home)"
  if [ -d "$c/$n" ]; then printf '%s\n' "$c/$n"; return; fi
  if [ -d "$x/$n" ]; then printf '%s\n' "$x/$n"; return; fi
  if [ -d "$c" ]; then printf '%s\n' "$c/$n"; return; fi
  if [ -d "$x" ]; then printf '%s\n' "$x/$n"; return; fi
  printf '%s\n' "$c/$n"
}

# The prompt enhancer's data home: engine, state.json, learned profile, ledger.
leo_enhance_dir() {
  if [ -n "${LEOPOLD_ENHANCE_DIR:-}" ]; then printf '%s\n' "$LEOPOLD_ENHANCE_DIR"; return; fi
  _leo_data_dir enhance
}

# ovmem's data home: engine, cleanup, dashboard, per-session commit offsets.
leo_ovmem_dir() {
  if [ -n "${LEOPOLD_OVMEM_DIR:-}" ]; then printf '%s\n' "$LEOPOLD_OVMEM_DIR"; return; fi
  _leo_data_dir ovmem
}

# ---- harness resolution -----------------------------------------------------

# Which harnesses to wire, honoring LEOPOLD_HARNESS (auto|claude|codex|all).
# "auto" takes whatever is actually on this machine; if neither is, Claude Code
# is assumed so a fresh box still ends in a usable state.
leo_harness_targets() {
  local want="${LEOPOLD_HARNESS:-auto}" claude=0 codex=0
  case "$want" in
    claude|claude-code) claude=1 ;;
    codex|openai)       codex=1 ;;
    all|both)           claude=1; codex=1 ;;
    auto)
      if command -v claude >/dev/null 2>&1 || [ -d "$(leo_claude_home)" ]; then claude=1; fi
      if command -v codex  >/dev/null 2>&1 || [ -d "$(leo_codex_home)"  ]; then codex=1;  fi
      if [ "$claude" = 0 ] && [ "$codex" = 0 ]; then claude=1; fi
      ;;
    *) echo "harness.sh: unknown LEOPOLD_HARNESS \"$want\" (use: auto, claude, codex, all)" >&2; return 2 ;;
  esac
  local out=""
  if [ "$claude" = 1 ]; then out="claude"; fi
  if [ "$codex"  = 1 ]; then out="${out:+$out }codex"; fi
  printf '%s\n' "$out"
}

leo_has_harness() { case " $(leo_harness_targets) " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Human label for a harness id — one spelling, used by every script that reports.
leo_harness_label() {
  case "$1" in claude) printf 'Claude Code\n' ;; codex) printf 'Codex CLI\n' ;; *) printf '%s\n' "$1" ;; esac
}

# ---- skills ------------------------------------------------------------------

# Where a harness discovers skills. Same SKILL.md format on both, different root:
# Claude Code reads <claude>/skills, Codex CLI reads <codex>/skills (verified on
# codex-cli 0.146.0 — install.sh and scripts/install-codex.sh already ship Leopold's
# own skills to exactly these two paths). One writer for the path so an extension
# never has to spell a harness home itself.
leo_skills_dir() { # <harness>
  case "$1" in
    claude) printf '%s\n' "$(leo_claude_home)/skills" ;;
    codex)  printf '%s\n' "$(leo_codex_home)/skills" ;;
    *) return 1 ;;
  esac
}

# ---- project memory file ----------------------------------------------------

# The per-project memory file each harness actually reads. Claude Code reads
# CLAUDE.md; Codex CLI reads AGENTS.md and does NOT read CLAUDE.md — verified on
# codex-cli 0.146.0 by dropping both files in a temp project and running
# `codex debug prompt-input`: only the AGENTS.md text reaches the model. Both
# harnesses generate their own file with the same `/init` command.
leo_memory_file() { # <harness>
  case "$1" in claude) printf 'CLAUDE.md\n' ;; codex) printf 'AGENTS.md\n' ;; *) return 1 ;; esac
}

# Every memory file wanted on this machine, in harness order. Two harnesses means
# two files: neither reads the other's, so writing only one silently half-informs
# the agent the user happens to open.
leo_memory_files() {
  local h out=""
  for h in $(leo_harness_targets); do out="${out:+$out }$(leo_memory_file "$h")"; done
  printf '%s\n' "$out"
}

# ---- the core hook specs ----------------------------------------------------

# leo_core_hook_specs <leopold asset home>
#
# THE list of Leopold's own hooks — one EVENT|MATCHER|COMMAND|TIMEOUT line each, in
# the order they were added. Both installers read it: install.sh feeds it to
# leo_wire_hooks_json, scripts/install-codex.sh to leo_wire_hooks_toml, and the
# plugin manifest hooks/hooks.json is pinned to it (event + matcher + script) by
# scripts/test-harness-lib.sh. There is no second copy of this list anywhere, which
# is the whole point: a hook added here reaches every install path at once, and a
# hook that only one installer knows about cannot exist.
#
# The matcher is a regex on the tool name and both harnesses read it as one, so the
# alternation is written once and each harness ignores the alternatives it has no
# tool for (Codex's edit tool is `apply_patch`; guard-irreversible.sh re-checks
# `tool_name` itself and exits 0 for anything but Bash either way).
#
# PermissionRequest takes NO matcher on purpose: the policy answers the prompt for every
# tool, and the one exception it makes is decided by handing the payload to the git lock,
# not by matching a tool name here. hooks/hook-matrix.tsv marks it `available` on Claude
# Code and `substitute` on Codex (deny honored, allow not) — both wire it, and the gate
# below is what enforces that.
#
# PreCompact and PostCompact are ONE script wired twice — it branches on
# `hook_event_name`, which both harnesses send on both events. Neither takes a matcher
# (there is no tool involved) and both are `available` on both harnesses in the matrix.
# The timeout is 10s rather than 5: PreCompact reads PLAN.md, DECISIONS.md, the event log
# and `git status` before it writes, and a checkpoint that times out is a window lost.
#
# StopFailure is the first spec the matrix refuses on a harness: `available` on Claude
# Code, `unavailable` on Codex, where an API error ends a run as a plain stop with no
# failure hook at all. It is listed here ONCE all the same — the gate below drops it for
# Codex by name and says so — because the alternative is two lists, and a hook that only
# one installer knows about is exactly what this function exists to prevent. Its timeout
# is the Stop hook's 15, not the 5 a small hook looks like it needs, because it takes the
# same ~5s state lock: at 5 the harness kills it INSIDE leo_hook_lock while a compaction
# or a stop holds the lock, the unlocked fallback write never runs, and the run stays
# `active: true` forever — the one failure this hook exists to end. hooks/_lib.sh names
# the budget (LEO_LOCK_TRIES × LEO_LOCK_SLEEP + LEO_LOCK_HEADROOM) and
# scripts/test-harness-lib.sh derives the floor for every lock-taking spec from it.
# SubagentStart and SubagentStop are the second script wired twice, and for the same
# reason: hooks/subagent-account.sh branches on `hook_event_name` and both events carry
# the SAME accounting keys on both harnesses (`agent_id`, `agent_type`, and on stop
# `agent_transcript_path`), so a second script would be a second copy of one ledger.
# Neither takes a matcher — no tool is named in either payload — and all four rows are
# `available` in the matrix. The timeout is 10, not 5, because the hook counts under the
# state lock: same arithmetic as StopFailure above, derived in scripts/test-harness-lib.sh.
#
# The subagent CAP is a third PreToolUse entry, beside the git lock. It is a separate
# script on purpose: guard-irreversible.sh denies two git commands and nothing else, and
# folding a budget ceiling into it would put the product's core promise and a cost knob in
# one file. Its matcher is the union of both harnesses' spawn tools — `Agent|Task` on
# Claude Code, `collaborationspawn_agent` on Codex (the name Findings records the spawn
# arriving under) — deliberately wide, because hooks/subagent-cap.sh re-checks `tool_name`
# itself and answers for nothing else. It writes no state, so it is wired at the git
# lock's 5s.
#
# The verification receipts are the third script wired twice, and the second spec the
# matrix refuses on a harness. hooks/verify-receipt.sh branches on `hook_event_name`
# because THE EXIT STATUS OF A COMMAND IS NOT IN EITHER HARNESS'S PostToolUse PAYLOAD:
# on Claude Code MOST non-zero Bash exits fire `PostToolUseFailure` instead (`error` is the
# string "Exit code 1"), so the two events are the two halves of one receipt and a second
# script would split one contract in two. Not all of them, though — the firing of
# PostToolUse is not itself a pass, and the hook reads the three response fields that say
# so (`returnCodeInterpretation`, `interrupted`, `backgroundTaskId`) rather than inferring
# a 0 from the event; that is the hook's business, not the wiring's, and it is why both
# events go to ONE script. Codex has no PostToolUseFailure at all — the
# matrix marks that row `unavailable` and the gate below drops it there by name, exactly
# as it does StopFailure — and its `PostToolUse` row is `substitute`: the event fires for
# pass and fail alike with `tool_response` as stdout only, so a Codex receipt proves the
# verification RAN and never that it passed. Wired anyway (the note carries the cost, and
# doctor prints it), because the alternative is no evidence on Codex at all.
# The matcher is the git lock's alternation plus `apply_patch`, Codex's edit tool
# (Findings) — the hook re-checks `tool_name` itself and answers for Bash and the edit
# tools only. The timeout is 10, not 5: it appends the receipt under the state lock, same
#
# The evidence GATE is the fourth script wired twice, and it is the first one whose two
# events answer in DIFFERENT SHAPES: hooks/done-gate.sh denies a PreToolUse with
# `permissionDecision: deny` and refuses a TaskCompleted with exit 2 on stderr, one rule
# read out of `hook_event_name`. Its PreToolUse matcher is the EDIT tools only — the git
# lock's alternation minus Bash and NotebookEdit, plus Codex's `apply_patch` — because the
# only claim of done it reads is an edit of .leopold/PLAN.md that ticks a box; both rows
# are `available` in the matrix. TaskCompleted takes no matcher (no tool is named in the
# payload) and is the THIRD spec the matrix refuses on a harness: `available` on Claude
# Code, `substitute` on Codex, which has no task events at all — the row's evidence anchor
# is not `#taskcompleted-codex-cli`, which is how the gate below knows to drop it there
# rather than wire a weaker version of it. The PLAN.md half carries the whole bound on
# Codex, and doctor says so. Wired at 5, not 10: the gate READS state and never writes it,
# so it never takes the state lock.
#
# THE SECOND-WRITER DETECTOR IS FOUR ENTRIES FOR TWO FILES, and that is not a mistake to
# tidy up. `FileChanged`'s matcher is a LITERAL FILE NAME — probed live on Claude Code
# 2.1.260, one headless session per wiring, an Edit of each file plus an append from
# another process (hooks/file-watch.sh carries the table): an alternation
# (`PLAN.md|DECISIONS.md`) fired 0 times, basenames alone fired 0 times, paths alone fired
# 0 times, and all four together fired 8. The path-shaped entry REGISTERS the watch and
# never fires; the basename-shaped entry RECEIVES. Both halves are needed per file, and a
# regex that matches nothing would be a detector that silently detects nothing. The four
# share one command, which is why the JSON writer keys its dedupe on (event, matcher,
# command) — see leo_wire_hooks_json. `.leopold/state.json` is deliberately NOT among
# them: the run's own hooks rewrite it several times a turn with no tool call to correlate
# against, so watching it would warn about the run's own bookkeeping every turn, and its
# second-writer bound is already enforced by the ownership gate (.leopold/DECISIONS.md).
# ConfigChange takes no matcher (no tool is named in the payload) and is the FOURTH spec
# the matrix refuses on a harness: Codex has neither event, so both are Claude-Code-only
# and doctor states the consequence in words. The four FileChanged entries are wired at 10
# and ConfigChange at 5, and the difference is the STATE LOCK, not the event: file-watch.sh
# writes no state but takes .leopold/.state.lock to make its own de-duplication atomic (the
# harness delivers each change twice, ~11ms apart, as two processes), and every hook that
# takes that lock has to be able to finish waiting for it inside its own timeout — the
# floor is derived in scripts/test-harness-lib.sh from the budget in hooks/_lib.sh, not
# typed here. config-guard.sh neither writes state nor takes the lock.
leo_core_hook_specs() {
  local home="${1:?leo_core_hook_specs: leopold asset home}"
  printf '%s\n' \
    "Stop||$home/hooks/stop-continuity.sh|15" \
    "PreToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|$home/hooks/guard-irreversible.sh|5" \
    "PermissionRequest||$home/hooks/permission-policy.sh|5" \
    "PreCompact||$home/hooks/compact-checkpoint.sh|10" \
    "PostCompact||$home/hooks/compact-checkpoint.sh|10" \
    "StopFailure||$home/hooks/stop-failure.sh|15" \
    "SubagentStart||$home/hooks/subagent-account.sh|10" \
    "SubagentStop||$home/hooks/subagent-account.sh|10" \
    "PreToolUse|Agent|Task|collaborationspawn_agent|$home/hooks/subagent-cap.sh|5" \
    "PostToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch|$home/hooks/verify-receipt.sh|10" \
    "PostToolUseFailure|Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch|$home/hooks/verify-receipt.sh|10" \
    "PreToolUse|Edit|Write|MultiEdit|apply_patch|$home/hooks/done-gate.sh|5" \
    "TaskCompleted||$home/hooks/done-gate.sh|5" \
    "FileChanged|.leopold/PLAN.md|$home/hooks/file-watch.sh|10" \
    "FileChanged|PLAN.md|$home/hooks/file-watch.sh|10" \
    "FileChanged|.leopold/DECISIONS.md|$home/hooks/file-watch.sh|10" \
    "FileChanged|DECISIONS.md|$home/hooks/file-watch.sh|10" \
    "ConfigChange||$home/hooks/config-guard.sh|5"
}

# ---- dispatcher -------------------------------------------------------------

# leo_wire_hooks <tag> <spec>...
# Writes the same hooks into every resolved harness, in that harness's format.
# Returns non-zero if ANY target failed (and says which) — a half-wired install
# that reports success is the one failure mode this cannot have.
leo_wire_hooks() {
  local tag="${1:?leo_wire_hooks: tag}"; shift
  local rc=0 h total=0 evs="" refs=""
  for h in $(leo_harness_targets); do
    case "$h" in
      claude) leo_wire_hooks_json "$(leo_settings_file)" "$tag" "$@" || rc=1 ;;
      codex)  leo_wire_hooks_toml "$(leo_config_file)"   "$tag" "$@" || rc=1 ;;
    esac
    # Aggregate the per-writer accounting, tagged by harness, so a caller of the
    # dispatcher can report what landed WHERE rather than reading the last harness's
    # numbers as if they were the whole install's.
    total=$((total + LEO_WIRED_COUNT))
    if [ -n "$LEO_WIRED_EVENTS" ];   then evs="${evs:+$evs }$h:$LEO_WIRED_EVENTS"; fi
    if [ -n "$LEO_REFUSED_EVENTS" ]; then refs="${refs:+$refs }$h:$LEO_REFUSED_EVENTS"; fi
  done
  LEO_WIRED_COUNT="$total"; LEO_WIRED_EVENTS="$evs"; LEO_REFUSED_EVENTS="$refs"
  return $rc
}

# ---- internals --------------------------------------------------------------

# Field extraction honoring the format comment up top: EVENT is everything before
# the first "|", COMMAND and TIMEOUT are the last two fields, and MATCHER is the
# whole middle rejoined — so a regex-alternation matcher ("mcp__.*|WebFetch")
# survives the pipe delimiter. A plain 4-field spec parses exactly as before.
_leo_spec_field() { # <spec> <1-based index: 1 EVENT, 2 MATCHER, 3 COMMAND, 4 TIMEOUT>
  printf '%s' "$1" | awk -F'|' -v i="$2" '{
    if (i == 1)      printf "%s", $1
    else if (i == 3) printf "%s", $(NF-1)
    else if (i == 4) printf "%s", $NF
    else { m = ""; for (f = 2; f <= NF-2; f++) m = m (f > 2 ? "|" : "") $f; printf "%s", m }
  }'
}

# The public read side of a spec, for a caller that has to reason about one it was
# handed — an installer checking that what it declared actually landed in the file.
# Same parser as the writers use, so nobody re-splits a spec by hand.
leo_spec_event()   { _leo_spec_field "$1" 1; }
leo_spec_matcher() { _leo_spec_field "$1" 2; }
leo_spec_command() { _leo_spec_field "$1" 3; }
leo_spec_timeout() { _leo_spec_field "$1" 4; }

_leo_say()  { printf '   %s\n' "$*"; }
_leo_warn() { printf '   warn: %s\n' "$*" >&2; }

# ---- the capability matrix --------------------------------------------------
#
# hooks/hook-matrix.tsv is DERIVED from the live probe's captures
# (docs/reference/hook-events.md): one row per capability x event x harness, with
# the status word and the evidence anchor of the section that proves it. The
# writers read it so a spec for an event a harness does not have is refused HERE,
# once, instead of landing in that harness's config as a hook it can never fire.
#
# What the writers ask it is narrower than what doctor will ask it: "does this event
# FIRE on this harness?". THE STATUS WORD ANSWERS THAT, and the evidence anchor is
# read for exactly one thing — splitting the two kinds of `substitute`:
#
#   available                          -> the probe watched the event fire here.
#                                         WIRE IT, whatever section the row cites.
#                                         (scripts/test-hook-matrix.sh pins every
#                                         `available` row to a captured firing, so
#                                         the status word IS the capture signal.)
#   substitute + `#<event>-<harness>`  -> the event fires here with a weaker guarantee
#                                         (Codex PermissionRequest honors deny only,
#                                         Codex PostToolUse fires pass and fail
#                                         alike): still wire it, the note carries
#                                         the cost
#   substitute + any other anchor      -> the BOUND is substituted because the event
#                                         is not on this harness at all (Codex has no
#                                         TaskCompleted; the PLAN.md PreToolUse gate
#                                         carries it): do not wire
#   unavailable                        -> not here, no substitute: do not wire
#
# An event with no row at all is none of the matrix's business — the enhancer's
# UserPromptSubmit, Serena's and ovmem's session hooks — and is wired unchanged.
# So is every event when the tsv itself cannot be found, and that says so loudly.
#
# WHY THE ANCHOR NEVER OVERRULES `available`: it used to, and that was a fail-CLOSED
# hole. A row is free to cite whatever heading proves it, several already cite the
# shared Findings section, and a row that says `available` while the gate reads its
# anchor and answers "unavailable" contradicts the row it just read — silently, with
# every test green, on the surface that carries the git lock. The status column is the
# contract; the anchor is evidence for a human. scripts/test-hook-matrix.sh pins the
# one coupling that remains: a `substitute` row cites `#<event>-<harness>` if and only
# if the captured matrix shows that event firing on that harness.
#
# THE ASYMMETRY THAT MATTERS: only a matrix that ANSWERS may drop a hook — `unavailable`,
# or a `substitute` whose evidence says the event is not on this harness. Not found, not
# readable, awk failed, the file vanished mid-run — every one of those is "I could not
# ask", and the answer to that is wire it and say so. A gate that reads its own inability
# to open a file as a refusal is one `chmod 000` away from silently disarming the git
# lock, which is the exact opposite of what it exists for. The probe that PRODUCES the
# matrix turns the gate off entirely (LEO_WIRE_UNCHECKED=1): filtering the instrument by
# its own output would make it self-confirming — a new event could never be captured,
# because it would never be wired, because no row yet says it exists.

_leo_harness_slug() { case "$1" in claude) printf 'claude-code' ;; codex) printf 'codex-cli' ;; *) printf '%s' "$1" ;; esac; }
_leo_harness_word() { case "$1" in claude) printf 'Claude' ;;      codex) printf 'Codex' ;;     *) printf '%s' "$1" ;; esac; }

# Every path the matrix is looked for, in order: the asset home first (that is the copy
# an installed hook path points into), the checkout beside this file second,
# LEO_MATRIX_TSV over both for hermetic tests. One list, so the resolver below and the
# "why is there no matrix" message can never disagree about where it looked.
_leo_matrix_candidates() {
  if [ -n "${LEO_MATRIX_TSV:-}" ]; then printf '%s\n' "$LEO_MATRIX_TSV"; return 0; fi
  printf '%s\n' "$(leo_asset_home)/hooks/hook-matrix.tsv"
  if [ -n "${_LEO_LIB_ROOT:-}" ]; then printf '%s\n' "${_LEO_LIB_ROOT}/hooks/hook-matrix.tsv"; fi
  return 0
}

# The first candidate that exists AND can be read. Readable is part of "there": a file
# we cannot open tells us nothing, so it must fall into the loud unchecked path rather
# than make awk fail and every capability look unavailable. Prints nothing when there
# is no usable matrix.
leo_matrix_file() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -f "$f" ] && [ -r "$f" ]; then printf '%s\n' "$f"; return 0; fi
  done <<< "$(_leo_matrix_candidates)"
  return 0
}

# The first candidate that is there but unopenable — so the message can say "cannot be
# read" instead of "not found", which sends a reader looking for the wrong problem.
_leo_matrix_blocked() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -e "$f" ] && [ ! -r "$f" ]; then printf '%s\n' "$f"; return 0; fi
  done <<< "$(_leo_matrix_candidates)"
  return 0
}

# The version the matrix was probed against, quoted verbatim in its header line
# (`# probed: claude "..." codex "..."`) out of the reference page's Versions table.
# Every message about a missing capability names it, so a reader knows which binary
# the claim is about.
leo_matrix_version() { # <harness>
  local ha="$1" f
  case "$ha" in claude|codex) ;; *) return 0 ;; esac
  f="$(leo_matrix_file)"; [ -n "$f" ] || return 0
  grep -m1 '^# probed:' "$f" 2>/dev/null | sed -n "s/.* $ha \"\([^\"]*\)\".*/\1/p"
}

# The line every refusal prints, so the two writers and (later) doctor say it once.
_leo_unwired_line() { # <harness> <event>
  local v; v="$(leo_matrix_version "$1")"
  printf '%s: unavailable on %s%s — not wired' "$2" "$(_leo_harness_word "$1")" "${v:+ $v}"
}

# Said once per process: a machine wiring hooks with no USABLE matrix is wiring them
# blind. Loud, and it wires everything — never a refusal.
_leo_matrix_note_missing() {
  if [ -n "${LEO_MATRIX_MISSING_SAID:-}" ]; then return 0; fi
  LEO_MATRIX_MISSING_SAID=1
  local blocked; blocked="$(_leo_matrix_blocked)"
  if [ -n "$blocked" ]; then
    _leo_warn "hook-matrix.tsv is at $blocked but cannot be read (permissions?)."
  else
    _leo_warn "hook-matrix.tsv not found (looked at: $(_leo_matrix_candidates | tr '\n' ' ' | sed 's/ *$//'))."
  fi
  _leo_warn "Wiring every hook UNCHECKED: an event a harness does not have will be declared"
  _leo_warn "anyway, and leopold doctor cannot state capability per harness. Re-run the"
  _leo_warn "Leopold installer to restore it."
  return 0
}

# The other half of the same rule: the matrix was found and readable and the READER
# still could not answer — no awk on PATH, the file removed between the test and the
# read, a locale blow-up. Same verdict: wire it, say so.
_leo_matrix_note_unreadable() { # <file> <awk exit status>
  if [ -n "${LEO_MATRIX_UNREADABLE_SAID:-}" ]; then return 0; fi
  LEO_MATRIX_UNREADABLE_SAID=1
  _leo_warn "could not read $1 (awk exited $2) — wiring every hook UNCHECKED."
  _leo_warn "\"cannot tell\" is not \"unavailable\": nothing is dropped on a failed read."
  return 0
}

# The deliberate escape, for the probe that produces the matrix in the first place.
# Announced once so a run with the gate off never looks like a run with it on.
_leo_matrix_note_unchecked() {
  if [ -n "${LEO_WIRE_UNCHECKED_SAID:-}" ]; then return 0; fi
  LEO_WIRE_UNCHECKED_SAID=1
  _leo_warn "hook-matrix gate OFF (LEO_WIRE_UNCHECKED=1) — every spec is wired as asked."
  return 0
}

_leo_event_wired_here() { # <harness> <event> -> 0 wire it, 1 the matrix REFUSES it
  local ha="$1" ev="$2" f want rc
  if [ "${LEO_WIRE_UNCHECKED:-0}" = "1" ]; then _leo_matrix_note_unchecked; return 0; fi
  f="$(leo_matrix_file)"
  if [ -z "$f" ]; then _leo_matrix_note_missing; return 0; fi
  want="#$(printf '%s' "$ev" | tr '[:upper:]' '[:lower:]')-$(_leo_harness_slug "$ha")"
  awk -F'\t' -v ev="$ev" -v ha="$ha" -v want="$want" '
    /^[[:space:]]*#/ { next }
    $2 == ev && $3 == ha {
      seen = 1
      # available: the status word is the answer, the anchor is not consulted.
      if ($4 == "available") wire = 1
      # substitute: the anchor splits "fires here, weaker guarantee" from "the bound
      # is carried elsewhere because the event is not here at all".
      else if ($4 == "substitute" && $5 == want) wire = 1
    }
    END { if (!seen) exit 0; exit (wire ? 0 : 1) }
  ' "$f" 2>/dev/null
  rc=$?
  # 0 the matrix says wire it (or carries no row, which is none of its business);
  # 1 the matrix REFUSES it — `unavailable`, or a `substitute` whose evidence says the
  #   event is not on this harness at all. The only two answers allowed to drop a hook;
  # anything else awk itself failed, and a question we could not ask is not a no.
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) _leo_matrix_note_unreadable "$f" "$rc"; return 0 ;;
  esac
}

# ---- what actually landed ---------------------------------------------------
#
# The installers print the line that tells a user their git lock is armed, and that
# line has to be a REPORT, not a hope: a writer can legitimately exit 0 having
# declared nothing (every spec refused by the matrix). Each writer call rewrites
# these, and the callers read them instead of trusting their own arguments:
#   LEO_WIRED_COUNT     hooks actually declared by the last call — 0 means NOTHING landed
#   LEO_WIRED_EVENTS    their events, space-separated, in spec order
#   LEO_REFUSED_EVENTS  the events the matrix refused, space-separated
LEO_WIRED_COUNT=0
LEO_WIRED_EVENTS=""
LEO_REFUSED_EVENTS=""

# Records the specs that reached the file. Called only after the write landed.
_leo_wire_record() {
  local sp
  LEO_WIRED_COUNT=0; LEO_WIRED_EVENTS=""
  for sp in "$@"; do
    LEO_WIRED_COUNT=$((LEO_WIRED_COUNT + 1))
    LEO_WIRED_EVENTS="${LEO_WIRED_EVENTS:+$LEO_WIRED_EVENTS }$(_leo_spec_field "$sp" 1)"
  done
}

# _leo_filter_specs <harness> <spec>...
# Sets LEO_KEPT_SPECS to the specs this harness can actually fire and LEO_DROPPED_SPECS
# to the ones the matrix refused, printing the refusal line for each drop. Returns 1
# when nothing is left — not as an error but as an answer, so the caller can take out a
# stale block instead of writing an empty one.
LEO_KEPT_SPECS=()
LEO_DROPPED_SPECS=()
_leo_filter_specs() {
  local ha="${1:?_leo_filter_specs: harness}"; shift
  local sp ev
  LEO_KEPT_SPECS=(); LEO_DROPPED_SPECS=()
  LEO_WIRED_COUNT=0; LEO_WIRED_EVENTS=""; LEO_REFUSED_EVENTS=""
  for sp in "$@"; do
    ev="$(_leo_spec_field "$sp" 1)"
    if _leo_event_wired_here "$ha" "$ev"; then
      LEO_KEPT_SPECS+=("$sp")
    else
      LEO_DROPPED_SPECS+=("$sp")
      LEO_REFUSED_EVENTS="${LEO_REFUSED_EVENTS:+$LEO_REFUSED_EVENTS }$ev"
      _leo_say "$(_leo_unwired_line "$ha" "$ev")"
    fi
  done
  [ "${#LEO_KEPT_SPECS[@]}" -gt 0 ]
}

# ---- JSON (Claude Code settings.json) ---------------------------------------

# Renders the hooks as a settings.json fragment, for the manual-paste path.
leo_hooks_json_block() {
  local spec ev m cmd t
  echo '{'
  echo '  "hooks": {'
  local first=1
  for spec in "$@"; do
    ev="$(_leo_spec_field "$spec" 1)"; m="$(_leo_spec_field "$spec" 2)"
    cmd="$(_leo_spec_field "$spec" 3)"; t="$(_leo_spec_field "$spec" 4)"
    if [ "$first" != 1 ]; then echo ','; fi
    first=0
    printf '    "%s": [{%s"hooks": [{"type": "command", "command": "%s"%s}]}]' \
      "$ev" "${m:+\"matcher\": \"$m\", }" "$cmd" "${t:+, \"timeout\": $t}"
  done
  echo
  echo '  }'
  echo '}'
}

# The (EVENT, COMMAND) pairs the matrix just refused, as a JSON array — the exact set a
# re-install has to take back OUT of settings.json.
#
# The pair, never the command alone. One hook script is legitimately declared on more
# than one event (this run's bounds share PreToolUse with the git lock and the persona
# guard, and later ones share a script across events), so a command-only sweep would walk
# every event key in the file and delete that script's LIVE hooks along with the refused
# one — under any tag, on any event — and then report the refused event as the only thing
# it had touched. Scoped to the pairs, the removal can only take out what was refused.
_leo_refused_pairs_json() {
  local sp
  [ "${#LEO_DROPPED_SPECS[@]}" -gt 0 ] || { printf '[]'; return 0; }
  for sp in "${LEO_DROPPED_SPECS[@]}"; do
    jq -nc --arg e "$(_leo_spec_field "$sp" 1)" --arg c "$(_leo_spec_field "$sp" 3)" \
       '{event: $e, command: $c}'
  done | jq -sc .
}

# Which of the refused events does <settings.json> ACTUALLY declare the refused command
# on? The JSON twin of the TOML writer's block rewrite: the TOML block is regenerated
# from the kept specs and so loses a refused event by construction, while a JSON merge
# only ever adds — so a hook a PRE-GATE Leopold wired for an event this harness cannot
# fire would sit in the user's settings forever. This is what says "there is something to
# take out", and its output is what the removal line names: an event whose hook is not in
# the file is not reported as removed.
# Prints the events, space-separated and deduplicated; nothing when there is none.
_leo_json_refused_present() { # <settings.json>
  [ -f "$1" ] || return 0
  [ "${#LEO_DROPPED_SPECS[@]}" -gt 0 ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  # `. as $q` first: inside `index(...)` the dot is the array being searched, not the
  # pair under test, and `index(.)` is an array-in-array search that answers for the
  # wrong question entirely.
  jq -r --argjson p "$(_leo_refused_pairs_json)" '
    . as $s
    | [ $p[]
        | . as $q
        | select( [ ($s.hooks[$q.event] // [])[]? | .hooks[]? | .command // "" ]
                  | index($q.command) != null )
        | $q.event ]
    | unique | join(" ")
  ' "$1" 2>/dev/null
}

# leo_wire_hooks_json <settings.json> <tag> <spec>...
leo_wire_hooks_json() {
  local file="${1:?}" tag="${2:?}"; shift 2

  # JSON is Claude Code's format, so the matrix is asked about Claude Code. A spec for
  # an event this harness does not have is refused here, once.
  local keep=0
  if _leo_filter_specs claude "$@"; then keep=1; fi
  if [ "$keep" = 1 ]; then set -- "${LEO_KEPT_SPECS[@]}"; else set --; fi

  # Nothing to declare and nothing stale to remove: leave the file exactly as it is,
  # untouched down to its mtime — no backup, no rewrite, no empty block. An all-refused
  # list is an ANSWER, not a failure, so this exits 0 with LEO_WIRED_COUNT at 0 and the
  # caller reports what actually landed.
  # Which refused hooks are actually IN the file, by (event, command). Empty means
  # there is nothing stale to take out — not "the command appears somewhere".
  local prune_events="" prune=0
  prune_events="$(_leo_json_refused_present "$file")"
  if [ -n "$prune_events" ]; then prune=1; fi
  if [ "$keep" = 0 ] && [ "$prune" = 0 ]; then return 0; fi

  # A prune can only be pending when jq answered the question above, so from here on
  # there is nothing to remove and something to declare.
  if ! command -v jq >/dev/null 2>&1; then
    _leo_warn "jq not found — add this to $file by hand:"
    leo_hooks_json_block "$@" | sed 's/^/     /'
    return 1
  fi

  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || echo '{}' > "$file"
  local bak="$file.$tag.bak"
  cp "$file" "$bak"

  local tmp cur spec ev m cmd t ms _s
  tmp="$(mktemp)"; cur="$(mktemp)"
  cp "$file" "$cur"

  # Out first, in second — and both from the same list, so an event that moves from
  # wired to refused (a harness upgrade, a corrected row) leaves no orphan behind.
  if [ "$prune" = 1 ]; then
    # One refused (event, command) at a time, and ONLY under that event's key: an entry
    # left with no hooks goes, and the event key goes when nothing is left under it.
    # Every other event, every other tag, every hook of the user's own is out of reach
    # of this by construction.
    if ! jq --argjson p "$(_leo_refused_pairs_json)" '
      if (.hooks | type) == "object" then
        reduce $p[] as $q (.;
          if (.hooks[$q.event] | type) == "array" then
              .hooks[$q.event] |= (
                  map(if (.hooks | type) == "array"
                      then .hooks |= map(select((.command // "") != $q.command))
                      else . end)
                | map(select((.hooks | type) != "array" or (.hooks | length) > 0)) )
            | (if (.hooks[$q.event] | length) == 0 then del(.hooks[$q.event]) else . end)
          else . end)
      else . end
    ' "$cur" > "$tmp" 2>/dev/null; then
      _leo_warn "could not remove the refused hooks from $file — leaving your settings untouched."
      rm -f "$tmp" "$cur"
      return 1
    fi
    mv "$tmp" "$cur"; tmp="$(mktemp)"
    # The events actually removed, not every event the matrix refused: a refusal for an
    # event that was never wired here has nothing to report.
    _leo_say "removed the hooks for $prune_events from $file"
  fi

  for spec in "$@"; do
    ev="$(_leo_spec_field "$spec" 1)"; m="$(_leo_spec_field "$spec" 2)"
    cmd="$(_leo_spec_field "$spec" 3)"; t="$(_leo_spec_field "$spec" 4)"
    # Every matcher THIS list declares for this (event, command) — usually one, four for
    # the FileChanged detector. It is what makes the (matcher, command) key safe on an
    # upgrade: an entry a previous Leopold wired for this command under a matcher the list
    # no longer declares is RETIRED below rather than left beside the new one, so "one
    # Leopold hook per event and script per matcher we ship" stays true and a matcher that
    # changed between releases is corrected in place.
    ms="$(for _s in "$@"; do
            [ "$(_leo_spec_field "$_s" 1)" = "$ev" ] || continue
            [ "$(_leo_spec_field "$_s" 3)" = "$cmd" ] || continue
            _leo_spec_field "$_s" 2; echo
          done | jq -R . | jq -sc . 2>/dev/null || echo '[]')"
    if ! jq --arg ev "$ev" --arg m "$m" --arg cmd "$cmd" --arg t "$t" --argjson ms "$ms" '
      .hooks //= {} | .hooks[$ev] //= []
      # Retire this command from any entry of this event whose matcher is not one we ship.
      | .hooks[$ev] |= (
          map(if (any(.hooks[]?; .command == $cmd)) and (([(.matcher // "")] | inside($ms)) | not)
              then (.hooks |= map(select(.command != $cmd))) else . end)
          | map(select((.hooks | type) != "array" or (.hooks | length) > 0)))
      # Add only when this exact (matcher, command) is not already declared for the event.
      # The MATCHER is part of the key because one script is legitimately declared several
      # times on one event under different matchers: FileChanged needs a path-shaped entry
      # to register a watch and a basename-shaped one to receive it (probed — see
      # leo_core_hook_specs), and keying on the command alone silently dropped every entry
      # after the first, leaving a detector wired and dead. An entry whose matcher differs
      # is a different declaration, and a re-install still adds none of them twice.
      | (if any(.hooks[$ev][]?; ((.matcher // "") == $m)
                                and any(.hooks[]?; .command == $cmd)) then .
         else .hooks[$ev] += [
           (if $m == "" then {} else {matcher: $m} end)
           + {hooks: [ {type: "command", command: $cmd}
                       + (if $t == "" then {} else {timeout: ($t | tonumber)} end) ]}
         ] end)
      # keep an already-wired entry in step with the timeout we ship now
      | .hooks[$ev] |= map(.hooks |= map(
          if .command == $cmd and $t != "" then .timeout = ($t | tonumber) else . end))
    ' "$cur" > "$tmp" 2>/dev/null; then
      _leo_warn "the merged $file would not be valid JSON — leaving your settings untouched."
      _leo_warn "add this by hand:"
      leo_hooks_json_block "$@" | sed 's/^/     /'
      rm -f "$tmp" "$cur"
      return 1
    fi
    mv "$tmp" "$cur"; tmp="$(mktemp)"
  done

  if ! jq -e . "$cur" >/dev/null 2>&1; then
    _leo_warn "the merged $file would not be valid JSON — leaving your settings untouched."
    leo_hooks_json_block "$@" | sed 's/^/     /'
    rm -f "$tmp" "$cur"
    return 1
  fi

  mv "$cur" "$file"; rm -f "$tmp"
  # Paranoia: if anything downstream corrupted the landed file, put the backup back.
  if ! jq -e . "$file" >/dev/null 2>&1; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  # Only now — after the write landed and validated — is there anything to report.
  _leo_wire_record "$@"
  if [ "$LEO_WIRED_COUNT" -gt 0 ]; then
    _leo_say "hooks -> $file (backup at $bak)"
  else
    _leo_say "hooks pruned in $file (backup at $bak) — nothing left to declare"
  fi
}

# ---- TOML (Codex CLI config.toml) -------------------------------------------

# TOML basic strings: only backslash and double quote need escaping for the
# values we write (absolute paths and flags).
_leo_toml_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# The managed block is marker-delimited so a re-install replaces it EXACTLY and a
# hand-written config is never reformatted. TOML has no merge tool we can rely on
# being present, so we edit text and then validate.
# Tag "leopold" keeps the original markers: existing installs must be replaced,
# not shadowed by a second block.
_leo_toml_begin() { if [ "$1" = leopold ]; then echo "# >>> leopold (managed) >>>"; else echo "# >>> leopold:$1 (managed) >>>"; fi; }
_leo_toml_end()   { if [ "$1" = leopold ]; then echo "# <<< leopold (managed) <<<"; else echo "# <<< leopold:$1 (managed) <<<"; fi; }

# leo_hooks_toml_block <tag> <spec>...
# Set LEO_TOML_COMMENT to prepend explanatory "# ..." lines inside the block.
leo_hooks_toml_block() {
  local tag="${1:?}"; shift
  local spec ev m cmd t
  _leo_toml_begin "$tag"
  if [ -n "${LEO_TOML_COMMENT:-}" ]; then printf '%s\n\n' "$LEO_TOML_COMMENT"; fi
  for spec in "$@"; do
    ev="$(_leo_spec_field "$spec" 1)"; m="$(_leo_spec_field "$spec" 2)"
    cmd="$(_leo_spec_field "$spec" 3)"; t="$(_leo_spec_field "$spec" 4)"
    echo "[[hooks.$ev]]"
    if [ -n "$m" ]; then echo "matcher = \"$(_leo_toml_str "$m")\""; fi
    echo ""
    echo "[[hooks.$ev.hooks]]"
    echo "type = \"command\""
    echo "command = \"$(_leo_toml_str "$cmd")\""
    if [ -n "$t" ]; then echo "timeout = $t"; fi
    echo ""
  done
  _leo_toml_end "$tag"
}

# Can we actually parse TOML on this machine? macOS without the Xcode CLT ships no
# python3 at all, and Python < 3.11 has no tomllib — on those boxes every write below
# lands unvalidated, so nothing here may DEPEND on validation to stay correct.
_leo_toml_can_validate() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c 'import tomllib' >/dev/null 2>&1
}

# Say it once, out loud, when we are about to write TOML we cannot check. A silent
# unvalidated write is exactly the kind of "looks like success" this must not do.
_leo_toml_note_no_validation() { # <file>
  _leo_toml_can_validate && return 0
  [ -n "${LEO_TOML_NOVALIDATE_SAID:-}" ] && return 0
  LEO_TOML_NOVALIDATE_SAID=1
  _leo_warn "no python3 with tomllib here — writing $1 without a TOML syntax check."
  _leo_warn "Leopold's own edits stay idempotent without it (marker- and header-matched),"
  _leo_warn "and a backup is written next to the file before every change."
}

_leo_toml_validate() { # <file> -> 0 ok, 1 broken, 0 (skipped) when no tomllib
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$1" <<'PY'
import sys
try:
    import tomllib
except ModuleNotFoundError:      # Python < 3.11: skip validation rather than fail the install
    sys.exit(0)
with open(sys.argv[1], "rb") as fh:
    tomllib.load(fh)
PY
}

# leo_wire_hooks_toml <config.toml> <tag> <spec>...
leo_wire_hooks_toml() {
  local file="${1:?}" tag="${2:?}"; shift 2

  # TOML is Codex CLI's format. Same refusal as the JSON writer, and it matters more
  # here: Codex has five of the events Claude Code fires and none of them would ever
  # arrive, so an unfilterable spec would leave a dead [[hooks.X]] table in the
  # user's config.toml forever.
  local begin end
  begin="$(_leo_toml_begin "$tag")"; end="$(_leo_toml_end "$tag")"

  if ! _leo_filter_specs codex "$@"; then
    # EVERY spec refused. Not an error — the matrix answered. But returning here with
    # the file untouched is only right when there is nothing of ours in it: a managed
    # block written by a PRE-GATE Leopold (or before a row was corrected) is now exactly
    # the dead [[hooks.X]] table this gate exists to prevent, so it comes out. A config
    # with no block for this tag is left byte-identical, backup included.
    if [ -f "$file" ] && grep -qF "$begin" "$file" 2>/dev/null; then
      _leo_say "every hook in this list is refused here — removing the managed block a previous install left behind"
      leo_unwire_hooks_toml "$file" "$tag" || return 1
    fi
    return 0
  fi
  set -- "${LEO_KEPT_SPECS[@]}"

  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  _leo_toml_note_no_validation "$file"
  local bak="$file.$tag.bak"
  cp "$file" "$bak"

  local tmp; tmp="$(mktemp)"
  # Drop any previous block for this tag — that is what makes a re-install idempotent.
  #
  # The block's own leading blank line goes with it. Every block is appended with one
  # blank line in front, so lifting one out of the MIDDLE of the file used to leave
  # that blank behind while the fresh copy brought a new one: config.toml grew by an
  # empty line on every single re-install, forever. Blank lines anywhere else —
  # including inside a multi-line TOML string — are buffered and re-emitted exactly
  # as found, so this only ever touches the gap the removed block leaves.
  awk -v b="$begin" -v e="$end" '
    function flush(  i) { for (i = 1; i <= nb; i++) print ""; nb = 0 }
    $0 == b          { nb = 0; skip = 1; next }   # drop the blank(s) that led into it
    $0 == e          { skip = 0; next }
    skip             { next }
    /^[[:space:]]*$/ { nb++; next }
    { flush(); print }
    END { flush() }
  ' "$file" > "$tmp"

  # Trim trailing blank lines, then append the fresh block.
  awk 'BEGIN{n=0} {lines[NR]=$0}
       END{last=NR; while (last>0 && lines[last] ~ /^[[:space:]]*$/) last--;
           for(i=1;i<=last;i++) print lines[i]}' "$tmp" > "$tmp.trim" && mv "$tmp.trim" "$tmp"

  {
    if [ -s "$tmp" ]; then echo ""; fi
    leo_hooks_toml_block "$tag" "$@"
  } >> "$tmp"

  if ! _leo_toml_validate "$tmp" 2>/dev/null; then
    _leo_warn "the merged $file would not parse as TOML — leaving your config untouched."
    _leo_warn "add this to $file by hand:"
    leo_hooks_toml_block "$tag" "$@" | sed 's/^/     /'
    rm -f "$tmp"
    return 1
  fi

  mv "$tmp" "$file"
  if ! _leo_toml_validate "$file" 2>/dev/null; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  _leo_wire_record "$@"
  _leo_say "hooks -> $file (backup at $bak)"
}

# ---- project permissions / trust --------------------------------------------
#
# The per-project "stop asking me about routine work" knob. Each harness spells it
# differently and both spellings live HERE, next to the hook writers, for the same
# reason: two copies of the same wiring is how the harnesses drift apart.
#   Claude Code  <project>/.claude/settings.json  -> .permissions.allow[]
#   Codex CLI    ~/.codex/config.toml             -> [projects."<path>"] trust_level
# Same contract as the hook writers: back up, write to a temp file, idempotent,
# validate, roll back rather than leave something the harness cannot read.

# The allowlist Leopold seeds for routine dev work. The git lock still denies
# commit/push during a run, so being generous here is safe.
leo_project_allow_json() {
  cat <<'JSON'
[
  "Read(*)","Grep(*)","Glob(*)",
  "Bash(git status:*)","Bash(git diff:*)","Bash(git log:*)","Bash(git add:*)","Bash(git show:*)","Bash(git branch:*)","Bash(git fetch:*)",
  "Bash(ls:*)","Bash(cat:*)","Bash(rg:*)","Bash(find:*)","Bash(tree:*)","Bash(pwd)","Bash(echo:*)",
  "Bash(npm run:*)","Bash(npm test:*)","Bash(npm ci:*)","Bash(npm install:*)","Bash(pnpm:*)","Bash(yarn:*)","Bash(npx:*)",
  "Bash(node:*)","Bash(tsc:*)","Bash(make:*)","Bash(python3:*)","Bash(pytest:*)","Bash(cargo:*)","Bash(go:*)"
]
JSON
}

# leo_seed_permissions_json <project-dir>
# Merges the allowlist into <project>/.claude/settings.json. Merge, never clobber.
leo_seed_permissions_json() {
  local proj="${1:?leo_seed_permissions_json: project dir}"
  local file="$proj/.claude/settings.json"
  if ! command -v jq >/dev/null 2>&1; then
    _leo_warn "jq not found — skipping the Claude Code allowlist in $file"
    return 1
  fi
  mkdir -p "$proj/.claude"
  [ -f "$file" ] || echo '{}' > "$file"
  local bak="$file.leopold.bak" tmp
  cp "$file" "$bak"
  tmp="$(mktemp)"
  if ! jq --argjson add "$(leo_project_allow_json)" '
        .permissions = (.permissions // {})
        | .permissions.allow = ((.permissions.allow // []) + $add | unique)
      ' "$file" > "$tmp" 2>/dev/null; then
    _leo_warn "could not merge the allowlist into $file — leaving it untouched"
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  if ! jq -e . "$file" >/dev/null 2>&1; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  _leo_say "permissions -> $file ($(jq '.permissions.allow | length' "$file") allow rules, backup at $bak)"
}

# _leo_toml_project_trust <config.toml> <project-path> -> the project's current
# trust_level, or nothing when it has no entry.
_leo_toml_project_trust() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import sys
try:
    import tomllib
except ModuleNotFoundError:      # Python < 3.11: treat as "unknown", the caller appends
    sys.exit(0)
try:
    with open(sys.argv[1], "rb") as fh:
        d = tomllib.load(fh)
except Exception:
    sys.exit(0)
p = d.get("projects", {}).get(sys.argv[2])
if isinstance(p, dict) and p.get("trust_level"):
    print(p["trust_level"])
PY
}

# _leo_toml_has_project_table <config.toml> <project-path> -> 0 when the file already
# declares [projects."<path>"].
#
# This is the idempotency guard that does NOT need python3. TOML forbids declaring the
# same table twice, so appending a second [projects."<path>"] header makes Codex unable
# to parse its own config — and on a box without tomllib the validate-and-roll-back net
# is not there to catch it. The literal header is an exact test: the closing `"]` means
# a longer path can never contain a shorter one's header as a substring.
_leo_toml_has_project_table() {
  [ -f "$1" ] || return 1
  grep -qF -- "[projects.\"$(_leo_toml_str "$2")\"]" "$1"
}

# leo_trust_project_toml <config.toml> <project-path>
# Marks the project trusted for Codex, in the exact shape Codex writes itself:
#   [projects."/abs/path"]
#   trust_level = "trusted"
# Idempotent (an existing entry is left alone) and it never rewrites a trust level
# the user already chose — overriding somebody's own decision is not ours to make.
leo_trust_project_toml() {
  local file="${1:?}" proj="${2:?}" cur
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"

  if ! _leo_toml_validate "$file" 2>/dev/null; then
    _leo_warn "$file does not parse as TOML — not touching it. Add this by hand:"
    printf '     [projects."%s"]\n     trust_level = "trusted"\n' "$(_leo_toml_str "$proj")" >&2
    return 1
  fi

  cur="$(_leo_toml_project_trust "$file" "$proj")"
  if [ "$cur" = "trusted" ]; then
    _leo_say "project already trusted in $file"
    return 0
  fi
  if [ -n "$cur" ]; then
    _leo_warn "$file already sets trust_level = \"$cur\" here — leaving your choice alone"
    return 0
  fi

  # No trust level came back: either the project genuinely has no entry, or tomllib is
  # not installed and _leo_toml_project_trust could not tell us. The table header is the
  # authority either way — appending a second [projects."<path>"] is what breaks the file.
  if _leo_toml_has_project_table "$file" "$proj"; then
    _leo_say "project already has a [projects.\"...\"] entry in $file — leaving it alone"
    _leo_say "(if Codex still asks about this project, add trust_level = \"trusted\" under it)"
    return 0
  fi

  _leo_toml_note_no_validation "$file"

  # Its own backup name: the hook writer owns "<file>.leopold.bak", and `leopold up`
  # calls both in one breath — sharing the name would throw away the pre-install copy.
  local bak="$file.leopold-trust.bak" tmp
  cp "$file" "$bak"
  tmp="$(mktemp)"
  cp "$file" "$tmp"
  {
    if [ -s "$tmp" ]; then echo ""; fi
    printf '[projects."%s"]\n' "$(_leo_toml_str "$proj")"
    printf 'trust_level = "trusted"\n'
  } >> "$tmp"

  if ! _leo_toml_validate "$tmp" 2>/dev/null; then
    _leo_warn "the merged $file would not parse as TOML — leaving your config untouched. Add by hand:"
    printf '     [projects."%s"]\n     trust_level = "trusted"\n' "$(_leo_toml_str "$proj")" >&2
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  if ! _leo_toml_validate "$file" 2>/dev/null; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  _leo_say "project trust -> $file (backup at $bak)"
}

# leo_seed_project_permissions <project-dir>
# The dispatcher: seeds whatever each harness on this machine needs, in its own
# format. Non-zero if ANY target failed, and it says which.
leo_seed_project_permissions() {
  local proj="${1:?}" rc=0 h
  for h in $(leo_harness_targets); do
    case "$h" in
      claude) leo_seed_permissions_json "$proj" || rc=1 ;;
      codex)  leo_trust_project_toml "$(leo_config_file)" "$proj" || rc=1 ;;
    esac
  done
  return $rc
}

# ---- unwiring ---------------------------------------------------------------
#
# The mirror of the writers above, and here for the same reason: an extension
# that can install into two harnesses must be able to REMOVE itself from two
# harnesses, and the moment each one hand-rolls that we are back to two copies
# of the format knowledge drifting apart.

# leo_unwire_hooks_json <settings.json> <tag> <command-regex>
# Drops every hook whose command matches the regex, then prunes the entries and
# events left empty. Same contract as the writer: back up, temp file, validate,
# roll back rather than land something Claude Code cannot read.
leo_unwire_hooks_json() {
  local file="${1:?}" tag="${2:?}" re="${3:?}"
  [ -f "$file" ] || return 0
  command -v jq >/dev/null 2>&1 || { _leo_warn "jq not found — remove the hooks matching /$re/ from $file by hand."; return 1; }

  local bak="$file.$tag.bak" tmp
  cp "$file" "$bak"
  tmp="$(mktemp)"
  if ! jq --arg re "$re" '
    if .hooks then .hooks |= ( to_entries
      | map(.value |= ( map(.hooks |= map(select((.command // "") | test($re) | not)))
                        | map(select((.hooks | length) > 0)) ))
      | map(select((.value | length) > 0))
      | from_entries ) else . end
  ' "$file" > "$tmp" 2>/dev/null || ! jq -e . "$tmp" >/dev/null 2>&1; then
    _leo_warn "unwiring would not produce valid JSON — leaving $file untouched."
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  _leo_say "hooks removed from $file (backup at $bak)"
}

# leo_unwire_hooks_toml <config.toml> <tag>
# Deletes the tag's managed block. Nothing else in the file is touched, which is
# exactly why the writer delimits it with markers in the first place.
leo_unwire_hooks_toml() {
  local file="${1:?}" tag="${2:?}" begin end bak tmp
  [ -f "$file" ] || return 0
  begin="$(_leo_toml_begin "$tag")"; end="$(_leo_toml_end "$tag")"
  grep -qF "$begin" "$file" 2>/dev/null || return 0

  bak="$file.$tag.bak"
  cp "$file" "$bak"
  tmp="$(mktemp)"
  awk -v b="$begin" -v e="$end" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip   { print }
  ' "$file" > "$tmp"
  if ! _leo_toml_validate "$tmp" 2>/dev/null; then
    _leo_warn "unwiring would not produce valid TOML — leaving $file untouched."
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  _leo_say "hooks removed from $file (backup at $bak)"
}

# ---- persona guard ----------------------------------------------------------
#
# The persona module's hook-level navigation bound (hooks/persona-guard.sh):
# while a persona run is active, MCP navigation is checked against the active
# flow's domain allowlist AT THE HOOK, on both harnesses — verified live against
# claude 2.1.235 and codex-cli 0.147.0 (docs/reference/persona-guard-hooks.md:
# PreToolUse fires for `mcp__<server>__<tool>` calls with the same payload and
# deny contract on both). The conductor wires this at persona-run start and
# unwires it at run end, so the hook exists in a harness config ONLY while a
# run is active; the hook itself additionally no-ops without an active
# `.leopold/persona/ACTIVE.json`, so a stale wire can never bound a normal
# session. Spelled here, next to the other writers, because the wire/unwire
# pair IS format knowledge — an extension or the driver calling anything more
# specific than these two functions is how the harnesses drift.

LEO_PERSONA_GUARD_TAG="leopold-persona-guard"

# The matcher routes BOTH navigation surfaces the hook judges: MCP tool calls
# (`mcp__<server>__<tool>`) and the built-in WebFetch — the alternation was part
# of the live verification (docs/reference/persona-guard-hooks.md, the deny
# probe ran with `mcp__.*|WebFetch`). A matcher that names only `mcp__.*` would
# leave the hook's WebFetch branch reachable by no production wiring: an
# off-allowlist WebFetch during an active run would sail past the hook layer.
leo_wire_persona_guard() { # <absolute path to persona-guard.sh>
  local hook="${1:?leo_wire_persona_guard: hook path}"
  leo_wire_hooks "$LEO_PERSONA_GUARD_TAG" "PreToolUse|mcp__.*|WebFetch|bash $hook|5"
}

leo_unwire_persona_guard() {
  local rc=0 h
  for h in $(leo_harness_targets); do
    case "$h" in
      claude) leo_unwire_hooks_json "$(leo_settings_file)" "$LEO_PERSONA_GUARD_TAG" 'persona-guard\.sh' || rc=1 ;;
      codex)  leo_unwire_hooks_toml "$(leo_config_file)"   "$LEO_PERSONA_GUARD_TAG" || rc=1 ;;
    esac
  done
  return $rc
}

# ---- Codex agent roles (the driver's review lenses) --------------------------
#
# Codex CLI has something Claude Code does not: a NATIVE agent role. A role file at
# `$CODEX_HOME/agents/<role>.toml` declares a name, a description and
# `developer_instructions`, plus any config.toml key (`model`, `sandbox_mode`,
# `model_reasoning_effort`), and `spawn_agent(agent_type=<role>)` runs a subagent as
# that role — the probe captured it arriving back as `agent_type` in `SubagentStart`
# (docs/reference/hook-events.md, "#subagentstart-codex-cli"; hooks/hook-matrix.tsv,
# row `review-lens-roles`).
#
# Two facts from that capture bound everything below, and neither is negotiable:
#
#   1. ONE unknown key makes Codex ignore the WHOLE file ("Ignoring malformed agent
#      role definition ... unknown field"), with and without --strict-config. So this
#      writer emits known keys only: name / description / developer_instructions, and
#      the two config keys it actually needs. A lens whose file is ignored is a lens
#      that silently reviews nothing.
#   2. `codex exec` CANNOT run as a role. `-c agent_role=`, `-c agent_type=` and
#      `-c role=` are rejected as unknown config fields and a role file is not a valid
#      `--profile` layer; only `-c agents.<role>.config_file=<path>` is accepted, and
#      it DECLARES the role rather than adopting it. So these files exist for
#      in-session `spawn_agent`, the driver's own read-only mapping (`--sandbox
#      read-only`) is what constrains a headless lens, and `leopold doctor` says
#      exactly that instead of implying a parity Codex does not have.
#
# The lens texts below are the shell's copy of `REVIEW_LENSES` in
# packages/driver/src/review.ts — an installer cannot import TypeScript, and the
# driver's array is the source of truth. packages/driver/test/codex-agent-roles.test.ts
# renders these very specs through this writer and asserts every field against that
# array, so the copy cannot drift: change a focus there without changing it here and
# the driver's test suite fails.

# One lens per line: LENS|READONLY|MODEL_ENV|DESCRIPTION|FOCUS
# FOCUS is everything after the fourth "|", so the instruction text may contain one.
leo_review_lens_specs() {
  cat <<'SPECS'
correctness|1|LEOPOLD_CODEX_REVIEW_MODEL|Leopold review lens: correctness — logic bugs, edge cases, unhandled errors, wrong assumptions.|Your lens is CORRECTNESS: logic bugs, broken edge cases, unhandled errors, off-by-one, wrong assumptions about inputs or state, regressions in behavior the surrounding code depends on. If the /code-review skill is available, invoke it on the diff and fold its findings in.
security|1|LEOPOLD_CODEX_REVIEW_MODEL|Leopold review lens: security — injection, authn/authz, secrets, trust boundaries.|Your lens is SECURITY: injection, authn/authz gaps, secret handling, data exposure, unsafe defaults, trust-boundary mistakes. If the /security-review skill is available, invoke it; otherwise apply that rigor yourself.
does-it-work|1|LEOPOLD_CODEX_REVIEW_MODEL|Leopold review lens: does-it-actually-work — was the change verified, wired in, and honestly tested?|Your lens is DOES-IT-ACTUALLY-WORK: was the change genuinely verified, or only claimed? Check that the build/tests the item needed would actually pass (run them read-only if cheap), that new code is actually wired in and reachable, and that nothing was left a stub or placeholder. Scrutinize any new or changed TESTS for reward-hacking: a test that mocks the very unit under test, asserts nothing meaningful, or would still pass if the change's core logic were reverted is worse than no test — flag it blocking. Tests must exercise behavior (inputs → observable effects), not restate the implementation.
conformance|1|LEOPOLD_CODEX_REVIEW_MODEL|Leopold review lens: conformance — every acceptance scenario the item promised, verified against the diff.|Your lens is CONFORMANCE: the plan item promised specific behavior as acceptance scenarios (listed below). For EACH scenario, verify the uncommitted diff actually makes it true — trace the code path end to end, and run it read-only if that is cheap. A scenario that is unmet, only partially met, or not implemented at all is a BLOCKING finding; put the exact scenario text in the issue so the fix is unambiguous. Judge ONLY whether the promised behavior is delivered — another panelist covers code quality. If a scenario is genuinely ambiguous, say so in the issue rather than guessing it passes.
SPECS
}

_leo_lens_field() { # <spec> <1 LENS, 2 READONLY, 3 MODEL_ENV, 4 DESCRIPTION, 5 FOCUS (the rest)>
  printf '%s' "$1" | awk -v i="$2" -F'|' '{
    if (i < 5) { print $i; exit }
    out = $5
    for (j = 6; j <= NF; j++) out = out "|" $j
    print out
  }'
}

leo_lens_name()  { _leo_lens_field "$1" 1; }
leo_lens_role()  { printf 'leopold-lens-%s' "$(_leo_lens_field "$1" 1)"; }

# The role file for one lens, rendered. Kept separate from the writer so a caller (and
# the parity test) can see exactly what would land without touching the filesystem.
# leo_codex_role_file_body <spec>
leo_codex_role_file_body() {
  local spec="${1:?leo_codex_role_file_body: spec}"
  local lens ro menv desc focus model
  lens="$(_leo_lens_field "$spec" 1)"
  ro="$(_leo_lens_field "$spec" 2)"
  menv="$(_leo_lens_field "$spec" 3)"
  desc="$(_leo_lens_field "$spec" 4)"
  focus="$(_leo_lens_field "$spec" 5)"
  # Per-role model: whatever $MODEL_ENV holds, else nothing at all — an absent key is
  # how a role inherits the harness default, and "" would pin it to a model named "".
  model=""
  # Indirection through a NAME the spec supplies, so the name is checked before it is
  # expanded: a spec is Leopold's own data, and it still does not get to run shell.
  case "$menv" in
    [A-Za-z_][A-Za-z0-9_]*) eval "model=\${$menv:-}" ;;
    "") ;;
    *) _leo_warn "lens \"$lens\": ignoring model env name \"$menv\" (not an identifier)" ;;
  esac
  echo "# Leopold review lens \"$lens\" — a Codex agent role."
  echo "# Written by the Leopold installer (extensions/lib/harness.sh). Re-running the"
  echo "# installer replaces this file; the lens text lives in the driver's REVIEW_LENSES"
  echo "# (packages/driver/src/review.ts) and a parity test pins the two together."
  echo "# Spawn it in a Codex session with: spawn_agent(agent_type=\"leopold-lens-$lens\")"
  echo "name = \"leopold-lens-$lens\""
  echo "description = \"$(_leo_toml_str "$desc")\""
  echo "developer_instructions = \"$(_leo_toml_str "$focus")\""
  if [ "$ro" = "1" ]; then echo "sandbox_mode = \"read-only\""; fi
  if [ -n "$model" ]; then echo "model = \"$(_leo_toml_str "$model")\""; fi
}

# Same content? `$(<file)` is a bash builtin read, so this needs nothing on PATH.
# `cmp` is not guaranteed to be there: an installer can run under a deliberately small
# PATH (scripts/test-codex-install.sh seals one to prove the install is hermetic), and a
# comparison that ERRORS reads as "different" — which would rewrite and back up every
# role file on every install, i.e. silently lose idempotency exactly where it is tested.
_leo_same_text() { # <a> <b>
  [ -f "$1" ] && [ -f "$2" ] && [ "$(<"$1")" = "$(<"$2")" ]
}

# leo_write_codex_agent_roles <codex-home> <lens-spec>...
# One file per lens under <codex-home>/agents/. Idempotent (a file whose bytes already
# match is left alone, mtime included) and backed up like the hook writers: the previous
# content goes to <file>.leopold.bak before it is replaced, and a file that would not
# parse as TOML is rolled back rather than shipped. Sets LEO_ROLES_WRITTEN (files that
# changed) and LEO_ROLES_TOTAL (files that are now correct).
leo_write_codex_agent_roles() {
  local home="${1:?leo_write_codex_agent_roles: <codex-home>}"; shift
  [ "$#" -gt 0 ] || return 0
  local dir="$home/agents"
  if ! mkdir -p "$dir" 2>/dev/null; then
    _leo_warn "could not create $dir — the Codex review-lens roles were not installed"
    return 1
  fi
  LEO_ROLES_WRITTEN=0; LEO_ROLES_TOTAL=0
  local spec lens file tmp bak rc=0
  for spec in "$@"; do
    [ -n "$spec" ] || continue
    lens="$(_leo_lens_field "$spec" 1)"
    [ -n "$lens" ] || { _leo_warn "a lens spec with no lens name was skipped"; rc=1; continue; }
    file="$dir/leopold-lens-$lens.toml"
    tmp="$(mktemp)" || { rc=1; continue; }
    leo_codex_role_file_body "$spec" > "$tmp"
    _leo_toml_note_no_validation "$file"
    if ! _leo_toml_validate "$tmp" 2>/dev/null; then
      _leo_warn "the role file for lens \"$lens\" would not parse as TOML — $file left untouched"
      rm -f "$tmp"; rc=1; continue
    fi
    LEO_ROLES_TOTAL=$((LEO_ROLES_TOTAL+1))
    if _leo_same_text "$tmp" "$file"; then
      rm -f "$tmp"; continue          # already exactly this — no write, no backup churn
    fi
    if [ -f "$file" ]; then
      bak="$file.leopold.bak"
      cp "$file" "$bak" 2>/dev/null || _leo_warn "could not back up $file"
    fi
    if mv "$tmp" "$file"; then
      chmod 644 "$file" 2>/dev/null || true
      LEO_ROLES_WRITTEN=$((LEO_ROLES_WRITTEN+1))
    else
      _leo_warn "could not write $file"
      rm -f "$tmp"; rc=1
    fi
  done
  return $rc
}

# ---- MCP servers ------------------------------------------------------------
#
# Both harnesses ship an MCP registry and both drive it from their own CLI, with
# different flags: Claude Code needs an explicit `--scope user`, Codex is global
# by default and writes [mcp_servers.<name>] into config.toml (verified against
# codex-cli 0.146.0, CODEX_HOME honored). One place knows that difference.

# Is the harness's own CLI available to talk to its registry?
leo_mcp_cli() { # <harness>
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 && printf 'claude\n' ;;
    codex)  command -v codex  >/dev/null 2>&1 && printf 'codex\n'  ;;
    *) return 1 ;;
  esac
}

# leo_mcp_present <harness> <name> — 0 when registered.
# `codex mcp get <missing>` and `claude mcp get <missing>` both exit non-zero.
leo_mcp_present() {
  local cli; cli="$(leo_mcp_cli "$1")" || return 1
  [ -n "$cli" ] || return 1
  "$cli" mcp get "$2" >/dev/null 2>&1
}

# leo_mcp_add <harness> <name> <command> [args...]
# Idempotent by construction: `claude mcp add` errors on a duplicate, so the
# caller checks leo_mcp_present first; `codex mcp add` replaces the entry in
# place. Both are safe to call after that check.
leo_mcp_add() {
  local h="${1:?}" name="${2:?}"; shift 2
  local cli; cli="$(leo_mcp_cli "$h")" || return 1
  [ -n "$cli" ] || return 1
  case "$h" in
    claude) claude mcp add --scope user "$name" -- "$@" >/dev/null 2>&1 ;;
    codex)  codex  mcp add "$name" -- "$@" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# The exact command a user would run by hand — printed whenever the CLI is not
# on PATH, so "couldn't register it" is never a dead end.
leo_mcp_add_cmd() { # <harness> <name> <command> [args...]
  local h="${1:?}" name="${2:?}"; shift 2
  case "$h" in
    claude) printf 'claude mcp add --scope user %s -- %s\n' "$name" "$*" ;;
    codex)  printf 'codex mcp add %s -- %s\n' "$name" "$*" ;;
    *) return 1 ;;
  esac
}

leo_mcp_remove() { # <harness> <name>
  local cli; cli="$(leo_mcp_cli "$1")" || return 1
  [ -n "$cli" ] || return 1
  case "$1" in
    claude) claude mcp remove "$2" -s user >/dev/null 2>&1 ;;
    codex)  codex  mcp remove "$2"        >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
