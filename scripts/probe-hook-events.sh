#!/usr/bin/env bash
# Leopold — hermetic live probe of every documented hook event on the INSTALLED binaries.
#
# The question this answers, per event and per harness, is "does it fire from a headless
# session, with what payload, and which reply does the harness honor?" — captured, never
# assumed. A `strings` dump or a docs page is a hypothesis; this script is the proof the
# reference page (docs/reference/hook-events.md) quotes.
#
#   bash scripts/probe-hook-events.sh --out <dir> [--harness claude|codex|all]
#                                     [--only run1,run2,...] [--no-render] [--render-only]
#                                     [--model <claude model alias>] [--keep]
#
# What it does:
#   * fingerprints the REAL ~/.claude and ~/.codex (entry names, the same check
#     scripts/test-harness-lib.sh runs) before and after, and fails if either changed;
#   * builds a throwaway project under `mktemp -d`, git-initialised, with a CLAUDE.md /
#     AGENTS.md, a .leopold/PLAN.md, a big file to compact against, a project command
#     and a Codex role file;
#   * wires scripts/probe/dump-hook.sh on EVERY event of the matrix through the shared
#     writer (extensions/lib/harness.sh: `leo_wire_hooks_json` into the project's
#     .claude/settings.json, `leo_wire_hooks_toml` into a temp CODEX_HOME/config.toml) —
#     no installer pastes JSON or TOML — with those writers' capability gate turned OFF
#     (LEO_WIRE_UNCHECKED=1), because hooks/hook-matrix.tsv is derived from THESE
#     captures and must never decide what gets captured;
#   * drives `claude -p` (the real config dir READ-ONLY, because macOS keeps the login in
#     the Keychain — exactly how docs/reference/sdk-worker-hooks.md run 2 authenticated;
#     a temp CLAUDE_CONFIG_DIR only for the unauthenticated hook-fires-anyway pass) and
#     `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust` (a temp
#     CODEX_HOME holding a copy of auth.json, deleted afterwards) with one trigger per
#     event, and records under <out>:
#         manifest.json                 versions (verbatim --version output), runs, fingerprints
#         <harness>/<Event>.jsonl       the verbatim payloads the dump hook received
#         <harness>/<Event>.meta.jsonl  run, mode, reply given, env facts, per firing
#         <harness>/runs/<run>.*        the harness's own stream (stream-json / --json) + stderr
#         evidence.jsonl                what each reply did (honored / not / unobservable)
#         stubs/                        request logs of the API-failure and MCP stubs
#   * renders docs/reference/hook-events.md + .pt-BR.md from those files
#     (scripts/probe/render-hook-events.py) unless --no-render.
#
# It is NOT run by `make test` (it costs real model calls); `make hooks-check` lints it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../extensions/lib/harness.sh
. "$ROOT/extensions/lib/harness.sh"

# THE GATE IS OFF HERE, ON PURPOSE, AND ONLY HERE.
#
# The shared writers refuse a spec whose event hooks/hook-matrix.tsv marks unavailable
# on the target harness. That matrix is DERIVED from this script's captures — so
# letting it filter this script would make the instrument self-confirming: the day
# Codex ships StopFailure, the maintainer adds it to CODEX_EVENTS and reruns the probe,
# the gate would silently drop the hook, the event would never fire, and the renderer
# would publish a verbatim "not fired" row as CAPTURED EVIDENCE for the very row that
# caused it. The probe answers "does this event fire on the installed binary?" — it may
# never take that answer from a file. Every wire below asserts it landed in full.
export LEO_WIRE_UNCHECKED=1

DUMP="$ROOT/scripts/probe/dump-hook.sh"
STUB="$ROOT/scripts/probe/api-stub.py"
MCPSTUB="$ROOT/scripts/probe/mcp-elicit-stub.py"
RENDER="$ROOT/scripts/probe/render-hook-events.py"

# The matrix. Claude Code: the 33 events its hooks reference documents at the probed
# version. Codex CLI: the 12 events its hooks page documents. A name here that never
# fires is recorded as "not fired" with the trigger tried — never a blank row.
CLAUDE_EVENTS="SessionStart Setup UserPromptSubmit UserPromptExpansion PreToolUse PermissionRequest PermissionDenied PostToolUse PostToolUseFailure PostToolBatch Notification MessageDisplay SubagentStart SubagentStop TaskCreated TaskCompleted Stop StopFailure TeammateIdle InstructionsLoaded ConfigChange CwdChanged DirectoryAdded FileChanged WorktreeCreate WorktreeRemove PreCompact PostCompact PreModelSwitch PostModelSwitch Elicitation ElicitationResult SessionEnd"
CODEX_EVENTS="SessionStart SessionEnd SubagentStart SubagentStop PreToolUse PermissionRequest PostToolUse PreCompact PostCompact UserPromptSubmit Stop Interrupt"

CLAUDE_RUNS="tools filechanged-nested filechanged-cwd tasks tasks-exit2 subagent subagent-exit2 config-change config-change-exit2 command command-exit2 prompt-exit2 stop-exit2 stop-block posttool-block pretool-deny perm-allow perm-deny perm-host perm-auto system-message additional-context compact-auto compact-manual fail-401 fail-429 fail-500 fail-529 elicit-observe elicit-accept worktree worktree-agent setup-init setup-maintenance model-switch model-switch-exit2 add-dir teams unauth"
CODEX_RUNS="tools subagent subagent-role role-bogus role-bogus-strict subagent-exit2 stop-exit2 stop-block prompt-exit2 posttool-block pretool-deny perm-allow perm-deny perm-onrequest system-message additional-context compact interrupt fail-401 fail-429 fail-500 fail-529 exec-as-role strict-config"

OUT=""; HARNESS="all"; ONLY=""; RENDER_DOCS=1; RENDER_ONLY=0; KEEP=0
CLAUDE_MODEL="${PROBE_CLAUDE_MODEL:-haiku}"
CLAUDE_TIMEOUT="${PROBE_CLAUDE_TIMEOUT:-300}"; CODEX_TIMEOUT="${PROBE_CODEX_TIMEOUT:-240}"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --harness) HARNESS="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --no-render) RENDER_DOCS=0; shift ;;
    --render-only) RENDER_ONLY=1; shift ;;
    --model) CLAUDE_MODEL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "probe-hook-events: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "probe-hook-events: --out <dir> is required" >&2; exit 2; }
# --only names must be runs that exist, or a typo silently probes nothing.
if [ -n "$ONLY" ]; then
  for _r in $(printf '%s' "$ONLY" | tr ',' ' '); do
    case " $CLAUDE_RUNS $CODEX_RUNS " in *" $_r "*) ;; *) echo "probe-hook-events: unknown run '$_r' (claude: $CLAUDE_RUNS; codex: $CODEX_RUNS)" >&2; exit 2 ;; esac
  done
fi
case "$HARNESS" in claude|codex|all) ;; *) echo "probe-hook-events: --harness must be claude, codex or all" >&2; exit 2 ;; esac
mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[31mprobe-hook-events: %s\033[0m\n' "$*" >&2; exit 1; }
want_run() { # <name> -> 0 when --only is unset or names it
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---- render only ------------------------------------------------------------------
if [ "$RENDER_ONLY" = 1 ]; then
  [ -f "$OUT/manifest.json" ] || die "$OUT/manifest.json not found — run the probe first"
  python3 "$RENDER" "$OUT" --docs "$ROOT/docs/reference" || die "render failed"
  exit 0
fi

# ---- preconditions ------------------------------------------------------------------
for t in jq python3 git; do command -v "$t" >/dev/null 2>&1 || die "$t is required"; done
WANT_CLAUDE=0; WANT_CODEX=0
case "$HARNESS" in claude) WANT_CLAUDE=1 ;; codex) WANT_CODEX=1 ;; all) WANT_CLAUDE=1; WANT_CODEX=1 ;; esac
if [ "$WANT_CLAUDE" = 1 ]; then command -v claude >/dev/null 2>&1 || die "claude is not on PATH"; fi
if [ "$WANT_CODEX" = 1 ]; then
  command -v codex >/dev/null 2>&1 || die "codex is not on PATH"
  [ -f "$HOME/.codex/auth.json" ] || die "\$HOME/.codex/auth.json not found — log in to Codex once; the probe copies it into a temp CODEX_HOME"
fi

# The exact `--version` output — every doc header and matrix row quotes THIS, never a
# number typed by hand.
CLAUDE_VERSION=""; CODEX_VERSION=""
[ "$WANT_CLAUDE" = 1 ] && CLAUDE_VERSION="$(claude --version 2>/dev/null | head -1)"
[ "$WANT_CODEX" = 1 ]  && CODEX_VERSION="$(codex --version 2>/dev/null | head -1)"

# Fingerprint the REAL harness homes (entry names, never timestamps — a live session
# writes into its own home the whole time; a NEW top-level entry is what an escaped
# write looks like). The same check as scripts/test-harness-lib.sh, with one exclusion
# that a fifteen-minute window needs and a two-second test does not: SQLite `-wal` /
# `-shm` / `-journal` side files, which the Codex desktop app creates and removes next
# to its own databases on its own schedule (seen live: goals_1 and thread_history_1
# side files reborn mid-probe while no probe process had the real home open). The
# full name lists are kept so a real change is diagnosable, not just detected.
real_home_names() {
  local e n
  [ -d "$1" ] || return 0
  for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$e" ] || continue
    n="${e##*/}"
    case "$n" in *.sqlite-wal|*.sqlite-shm|*.sqlite-journal) continue ;; esac
    printf '%s\n' "$n"
  done | sort
}
real_codex_fingerprint()  { real_home_names "$HOME/.codex"  | cksum; }
real_claude_fingerprint() { real_home_names "$HOME/.claude" | cksum; }
FP_CODEX_BEFORE="$(real_codex_fingerprint)"; FP_CLAUDE_BEFORE="$(real_claude_fingerprint)"
mkdir -p "$OUT/fingerprints"
real_home_names "$HOME/.codex"  > "$OUT/fingerprints/codex.before.txt"
real_home_names "$HOME/.claude" > "$OUT/fingerprints/claude.before.txt"

TMP="$(mktemp -d /tmp/leopold-hookprobe.XXXXXX)"
CH="$TMP/codex-home"; CC="$TMP/claude-config-unauth"; XHOME="$TMP/codex-user-home"
mkdir -p "$OUT/claude/runs" "$OUT/codex/runs" "$OUT/stubs" "$CH" "$CC" "$XHOME"
cleanup() {
  rm -f "$CH/auth.json"
  pkill -f "$STUB" 2>/dev/null || true
  if [ "$KEEP" = 1 ]; then note "kept temp root: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

# manifest --------------------------------------------------------------------------
MANIFEST="$OUT/manifest.json"
jq -n --arg at "$(now)" --arg cv "$CLAUDE_VERSION" --arg xv "$CODEX_VERSION" --arg model "$CLAUDE_MODEL" \
      --arg fc "$FP_CLAUDE_BEFORE" --arg fx "$FP_CODEX_BEFORE" --arg h "$HARNESS" --arg only "$ONLY" \
      --arg cev "$CLAUDE_EVENTS" --arg xev "$CODEX_EVENTS" --arg tmp "$TMP" \
      --arg os "$(uname -srm)" --arg jqv "$(jq --version 2>/dev/null)" --arg pyv "$(python3 --version 2>/dev/null)" --arg bashv "$BASH_VERSION" '
  {probed_at:$at, harness:$h, only:$only,
   versions:{claude:$cv, codex:$xv, jq:$jqv, python:$pyv, bash:$bashv, os:$os},
   claude_model_alias:$model, temp_root:$tmp,
   events:{claude:($cev|split(" ")), codex:($xev|split(" "))},
   fingerprints:{claude_before:$fc, codex_before:$fx},
   runs:[], triggers:{claude:{}, codex:{}}}' > "$MANIFEST"
manifest_update() { # <jq filter> [--arg k v ...]
  local f="$1"; shift; local tmp; tmp="$(mktemp)"
  jq "$@" "$f" "$MANIFEST" > "$tmp" && mv "$tmp" "$MANIFEST"
}
record_run() { # <harness> <name> <rc> <seconds> <argv-string> <prompt> <note>
  manifest_update '.runs += [{harness:$h,name:$n,rc:($rc|tonumber),seconds:($s|tonumber),args:$a,prompt:$p,note:$note,at:$at}]' \
    --arg h "$1" --arg n "$2" --arg rc "$3" --arg s "$4" --arg a "$5" --arg p "$6" --arg note "$7" --arg at "$(now)"
}
# The trigger tried for an event, so a "not fired" row can name it. One line per attempt.
trigger() { # <harness> <event> <text>
  manifest_update '.triggers[$h][$e] = ((.triggers[$h][$e] // []) + [$t] | unique)' --arg h "$1" --arg e "$2" --arg t "$3"
}
evidence() { # <harness> <event> <reply> <result: honored|not-honored|unobservable|n/a> <text> [run]
  jq -nc --arg h "$1" --arg e "$2" --arg r "$3" --arg res "$4" --arg t "$5" --arg run "${6:-}" --arg at "$(now)" \
    '{harness:$h,event:$e,reply:$r,result:$res,evidence:$t,run:$run,at:$at}' >> "$OUT/evidence.jsonl"
}

# ---- helpers ------------------------------------------------------------------------
# A clean environment for the probed harness: nothing of the caller's session leaks in
# (this script is often run from inside an agent session, whose CLAUDE_*/CODEX_* vars
# would otherwise reach the child). Extra vars are passed as KEY=VALUE arguments.
# Claude Code keeps the real HOME: its login lives in the macOS Keychain and its
# transcripts land under the real config dir (read-only use of the login, exactly as
# docs/reference/sdk-worker-hooks.md run 2). Codex gets a temp HOME on top of the temp
# CODEX_HOME: everything it needs is in CODEX_HOME (auth.json copy, config.toml), so a
# stray "~/.codex" reference from the process cannot reach the real home at all.
clean_env() { env -i HOME="$HOME" PATH="$PATH" TERM=dumb USER="${USER:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" DISABLE_AUTOUPDATER=1 "$@"; }
codex_env() { env -i HOME="$XHOME" PATH="$PATH" TERM=dumb USER="${USER:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" CODEX_HOME="$CH" "$@"; }

count_lines() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }
meta_count() { # <harness> <event> <run> -> how many times the event fired in that run
  [ -f "$OUT/$1/$2.meta.jsonl" ] || { echo 0; return; }
  grep -c "\"run\":\"$3\"" "$OUT/$1/$2.meta.jsonl" 2>/dev/null || true
}
# How many times the hook that ONLY the rewritten settings declare fired in <run> — the
# observable side effect of a mid-session settings reload (see the ConfigChange pair).
reload_marker_count() { # <run> -> count
  [ -f "$OUT/claude/PreToolUse.meta.jsonl" ] || { echo 0; return; }
  grep -c "\"run\":\"$1\",\"mode\":\"[a-z2]*\",\"tag\":\"reloaded=1\"" "$OUT/claude/PreToolUse.meta.jsonl" 2>/dev/null || true
}
# Wait (bounded) until <file> contains <pattern>, then append <line> to <target>. This is
# the "external write from another process" trigger: the driver, not the session, edits
# the plan while the session sleeps.
external_write_when() { # <watch-file> <pattern> <target> <line> <max-seconds>
  local n=0 max=$(( $5 * 2 ))
  while [ $n -lt $max ] && ! grep -q -- "$2" "$1" 2>/dev/null; do sleep 0.5; n=$((n+1)); done
  if [ $n -lt $max ]; then sleep 1; printf '%s\n' "$4" >> "$3"; return 0; fi
  return 1
}
stub_start() { # <port> <status> <shape> <log> -> pid
  # stdout AND stderr to /dev/null: this runs inside a $(...) and a child that keeps the
  # substitution's pipe open would block the caller until the stub dies.
  python3 "$STUB" --port "$1" --status "$2" --shape "$3" --log "$4" >/dev/null 2>&1 &
  local pid=$!; sleep 0.8; echo "$pid"
}
stub_stop() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null || true; }
# The payloads of <run> for an event, from the dump hook's records (each record carries
# its own payload — the two files are never paired by line number).
run_payloads() { # <harness> <event> <run>
  [ -f "$OUT/$1/$2.meta.jsonl" ] || return 0
  jq -r --arg r "$3" 'select(.run==$r) | .payload' "$OUT/$1/$2.meta.jsonl" 2>/dev/null
}
first_transcript() { # <harness> <run> -> transcript_path of the run's SessionStart (or any) payload
  local ev tp
  for ev in SessionStart UserPromptSubmit Stop SessionEnd; do
    tp="$(run_payloads "$1" "$ev" "$2" | jq -r '.transcript_path // empty' 2>/dev/null | head -1)"
    if [ -n "$tp" ]; then printf '%s\n' "$tp"; return 0; fi
  done
  return 1
}

# ---- Claude Code ------------------------------------------------------------------------
CPR="$TMP/claude-project"
claude_project() {
  mkdir -p "$CPR/.claude/commands" "$CPR/.leopold" "$CPR/sub"
  ( cd "$CPR" && git init -q . 2>/dev/null
    printf '# probe project\n\nThis CLAUDE.md exists so InstructionsLoaded has something to load.\n' > CLAUDE.md
    printf '# Plan\n- [ ] item one\n' > .leopold/PLAN.md
    # A same-named file in the project ROOT: the FileChanged matcher is a literal file
    # name and the pilot runs only saw .leopold/PLAN.md reported when this one existed.
    printf '# Root plan (control for the FileChanged matcher)\n- [ ] root item\n' > PLAN.md
    head -c 90000 /dev/urandom | base64 > big.txt
    printf 'Reply with exactly: PROBE_COMMAND_EXPANDED\n' > .claude/commands/probecmd.md
    git add -A >/dev/null && git -c user.name=probe -c user.email=probe@example.invalid commit -qm init >/dev/null )
}
# claude_wire <run> [Event=mode ...]  — every event of the matrix, observe unless told.
claude_wire() {
  local run="$1"; shift
  local specs=() ev mode m ov
  for ev in $CLAUDE_EVENTS; do
    mode=observe
    case "$ev" in WorktreeCreate|WorktreeRemove) mode=worktree ;; esac
    for ov in "$@"; do case "$ov" in "$ev="*) mode="${ov#*=}" ;; esac; done
    m=""
    if [ "$ev" = FileChanged ]; then
      # Two entries, on purpose (pilot-verified): the path-shaped matcher REGISTERS the
      # watch on the nested file and never matches its own basename; the basename matcher
      # RECEIVES the events for every watched file of that name (root and nested).
      specs+=("FileChanged|.leopold/PLAN.md|bash $DUMP FileChanged --out $OUT --harness claude --run $run --mode $mode --tag registers=.leopold/PLAN.md|30")
      m="PLAN.md"
    fi
    specs+=("$ev|$m|bash $DUMP $ev --out $OUT --harness claude --run $run --mode $mode${m:+ --tag matches=$m}|30")
  done
  rm -f "$CPR/.claude/settings.json"
  leo_wire_hooks_json "$CPR/.claude/settings.json" probe "${specs[@]}" >/dev/null || die "could not wire $CPR/.claude/settings.json"
  # What landed, not what we asked for: a writer can exit 0 having declared less than
  # it was given. A short wire here would publish "not fired" for an event nobody ever
  # hooked, which is the one lie this page must never carry.
  [ "${LEO_WIRED_COUNT:-0}" = "${#specs[@]}" ] || \
    die "wired ${LEO_WIRED_COUNT:-0}/${#specs[@]} hooks into $CPR/.claude/settings.json (refused: ${LEO_REFUSED_EVENTS:-none})"
  # The RELOAD TWIN: the same wiring plus ONE extra PreToolUse entry, tagged so its
  # firings are countable. The ConfigChange runs copy this file over settings.json
  # mid-turn; a firing tagged `reloaded=1` afterwards is the only thing that can prove
  # the session ADOPTED the new configuration, and its absence — against a control run
  # that has it — is the only thing that can prove an exit 2 stopped the adoption.
  # Neither is visible in the stream: a ConfigChange hook never appears there at all
  # (no hook_started, no hook_response, so no exit code), which is why the reply's
  # verdict cannot be read the way every other event's is.
  if [ "${WIRE_RELOAD_MARKER:-0}" = 1 ]; then
    specs+=("PreToolUse|Bash|bash $DUMP PreToolUse --out $OUT --harness claude --run $run --mode observe --tag reloaded=1|30")
    rm -f "$CPR/.claude/settings-reloaded.json"
    leo_wire_hooks_json "$CPR/.claude/settings-reloaded.json" probe "${specs[@]}" >/dev/null \
      || die "could not wire $CPR/.claude/settings-reloaded.json"
    [ "${LEO_WIRED_COUNT:-0}" = "${#specs[@]}" ] || \
      die "wired ${LEO_WIRED_COUNT:-0}/${#specs[@]} hooks into $CPR/.claude/settings-reloaded.json (refused: ${LEO_REFUSED_EVENTS:-none})"
  fi
}
# claude_run <name> <prompt> [claude args...]  (CLAUDE_ENV="K=V K=V" for extra env)
claude_run() {
  local name="$1" prompt="$2"; shift 2
  local t0 rc; t0="$(date +%s)"
  say "claude · $name"
  # shellcheck disable=SC2086
  ( cd "$CPR" && clean_env ${CLAUDE_ENV:-} timeout "$CLAUDE_TIMEOUT" claude -p --setting-sources project --strict-mcp-config --model "$CLAUDE_MODEL" \
      --output-format stream-json --include-hook-events --verbose "$@" "$prompt" \
      < /dev/null > "$OUT/claude/runs/$name.stream.jsonl" 2> "$OUT/claude/runs/$name.stderr.txt" ); rc=$?
  record_run claude "$name" "$rc" "$(( $(date +%s) - t0 ))" "claude -p --setting-sources project --strict-mcp-config --model $CLAUDE_MODEL --output-format stream-json --include-hook-events --verbose $*" "$prompt" "${CLAUDE_ENV:-}"
  note "rc=$rc · $(( $(date +%s) - t0 ))s · result: $(claude_result "$name" | cut -c1-140)"
  return $rc
}
claude_result() { jq -r 'select(.type=="result") | ((.result // .error // "")|tostring)' "$OUT/claude/runs/$1.stream.jsonl" 2>/dev/null | head -1; }
claude_hook_outcome() { # <run> <event> -> "outcome=<o> exit_code=<n>" of the last hook_response for that event in the stream
  jq -r --arg e "$2" 'select(.type=="system" and .subtype=="hook_response" and .hook_event==$e) | "outcome=" + (.outcome|tostring) + " exit_code=" + (.exit_code|tostring)' "$OUT/claude/runs/$1.stream.jsonl" 2>/dev/null | tail -1
}
claude_stream_has() { grep -q -- "$2" "$OUT/claude/runs/$1.stream.jsonl" 2>/dev/null; }

claude_all() {
  say "Claude Code — $CLAUDE_VERSION (model alias: $CLAUDE_MODEL)"
  claude_project

  if want_run tools; then
    claude_wire tools
    ( if external_write_when "$OUT/claude/PreToolUse.jsonl" '"command":"sleep 6' "$CPR/.leopold/PLAN.md" "- [ ] external line (written by another process)" 120; then printf -- '- [ ] external root line (written by another process)\n' >> "$CPR/PLAN.md"; fi ) &
    claude_run tools "Do these steps in order with tools, one tool call per step, never two in parallel: 1) Bash: true  2) Bash: false  3) Bash: grep -c zzz /dev/null  4) Edit tool: in .leopold/PLAN.md replace 'item one' with 'item one (edited)'  5) Edit tool: in PLAN.md (project root) replace 'root item' with 'root item (edited)'  6) Bash: sleep 6  7) Bash: cat .leopold/PLAN.md  8) Bash: cd sub && pwd. Then reply with the single word DONE." --permission-mode bypassPermissions
    wait
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure PostToolBatch MessageDisplay InstructionsLoaded CwdChanged FileChanged Stop SessionEnd Notification; do
      trigger claude "$ev" "run tools: a headless \`claude -p\` turn in a project with a CLAUDE.md that runs \`true\`, \`false\`, \`grep -c zzz /dev/null\`, an Edit of .leopold/PLAN.md and of the root PLAN.md, \`sleep 6\` (the driver appends to both files from another process meanwhile), \`cat\` and, last, \`cd sub && pwd\`"
    done
    local ok0 ok1
    ok0="$(run_payloads claude PostToolUse tools | jq -r 'select(.tool_name=="Bash" and .tool_input.command=="true") | "yes"' | head -1)"
    ok1="$(run_payloads claude PostToolUseFailure tools | jq -r 'select(.tool_name=="Bash" and .tool_input.command=="false") | .error' | head -1)"
    evidence claude PostToolUse observe n/a "Bash \`true\` (exit 0) fired PostToolUse: ${ok0:-no}; the failing \`false\` fired PostToolUseFailure with error=\"${ok1:-<none>}\" — a non-zero Bash exit is routed to PostToolUseFailure UNLESS the harness re-interprets it — `grep -c zzz /dev/null` (exit 1) reached PostToolUse instead, with returnCodeInterpretation="No matches found" (Findings)" tools
    local fc; fc="$(jq -r 'select(.run=="tools") | .tag + " -> " + ((.payload|fromjson).file_path|sub(".*/claude-project/";""))' "$OUT/claude/FileChanged.meta.jsonl" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
    evidence claude FileChanged observe n/a "two entries wired: matcher .leopold/PLAN.md (registers the watch) and matcher PLAN.md (receives); firings per entry and path: ${fc:-none} — the session's own Edit and the other process's append produce payloads of the same shape (file_path + event), nothing in the payload tells them apart; the path-shaped entry never fires itself" tools
  fi
  if want_run filechanged-cwd; then
    # A cd in the session (CwdChanged) before the edits: are the watches still alive?
    claude_wire filechanged-cwd
    ( external_write_when "$OUT/claude/PreToolUse.jsonl" '"command":"sleep 5' "$CPR/.leopold/PLAN.md" "- [ ] external line after cd (written by another process)" 120 ) &
    claude_run filechanged-cwd "Do these steps in order with tools, one tool call per step: 1) Bash: cd sub && pwd  2) Edit tool: in .leopold/PLAN.md replace 'item one' with 'item one (edited after cd)'  3) Edit tool: in PLAN.md (project root) replace 'root item' with 'root item (edited after cd)'  4) Bash: sleep 5. Then reply DONE." --permission-mode bypassPermissions
    wait
    trigger claude FileChanged "run filechanged-cwd: the same wiring, with \`cd sub\` (CwdChanged) BEFORE the edits and the external append"
    evidence claude FileChanged 'observe (after a cd in the session)' n/a "after \`cd sub\` (CwdChanged) the same wiring fired $(meta_count claude FileChanged filechanged-cwd) times for two Edits and one external append — a cwd change detaches the watches" filechanged-cwd
  fi
  if want_run filechanged-nested; then
    # Same matcher, but no PLAN.md in the project root: is the nested file still watched?
    mv "$CPR/PLAN.md" "$TMP/PLAN.md.aside"
    claude_wire filechanged-nested
    ( external_write_when "$OUT/claude/PreToolUse.jsonl" '"command":"sleep 5' "$CPR/.leopold/PLAN.md" "- [ ] external nested line (written by another process)" 120 ) &
    claude_run filechanged-nested "Do these steps in order with tools, one tool call per step: 1) Edit tool: in .leopold/PLAN.md replace 'item one' with 'item one (nested edit)'  2) Bash: sleep 5. Then reply DONE." --permission-mode bypassPermissions
    wait
    mv "$TMP/PLAN.md.aside" "$CPR/PLAN.md"
    trigger claude FileChanged "run filechanged-nested: the same two entries with NO PLAN.md in the project root — an Edit of .leopold/PLAN.md plus an append from another process"
    evidence claude FileChanged 'observe (no root PLAN.md)' n/a "with no PLAN.md in the project root, FileChanged fired $(meta_count claude FileChanged filechanged-nested) times for .leopold/PLAN.md (Edit + external append): $(run_payloads claude FileChanged filechanged-nested | jq -r '.file_path|sub(".*/claude-project/";"")' | sort | uniq -c | tr -s ' ' | tr '\n' ';')" filechanged-nested
  fi

  if want_run tasks; then
    claude_wire tasks
    claude_run tasks "Use the TaskCreate tool to create a task with subject 'probe task' and description 'probe'. Then use TaskUpdate to set that task's status to completed. Then use TaskList and reply with the task's status." --permission-mode bypassPermissions
    trigger claude TaskCreated "run tasks: TaskCreate then TaskUpdate(status=completed) then TaskList"
    trigger claude TaskCompleted "run tasks: TaskCreate then TaskUpdate(status=completed) then TaskList"
  fi
  if want_run tasks-exit2; then
    claude_wire tasks-exit2 TaskCompleted=exit2
    claude_run tasks-exit2 "Use the TaskCreate tool to create a task with subject 'probe task' and description 'probe'. Then use TaskUpdate to set that task's status to completed. If that is refused, do not retry. Then use TaskList and reply with the task's status exactly as TaskList shows it." --permission-mode bypassPermissions
    evidence claude TaskCompleted exit2 "$( [ "$(claude_hook_outcome tasks-exit2 TaskCompleted | grep -c exit_code=2)" = 1 ] && echo honored || echo unobservable )" "hook_response: $(claude_hook_outcome tasks-exit2 TaskCompleted); final reply: $(claude_result tasks-exit2 | tr '\n' ' ' | cut -c1-220)" tasks-exit2
  fi

  if want_run subagent; then
    claude_wire subagent
    claude_run subagent "Use the Agent tool (subagent_type general-purpose) with the prompt: 'Run the Bash command echo PONG and reply with its output.' Wait for it and reply with what it returned." --permission-mode bypassPermissions
    trigger claude SubagentStart "run subagent: the Agent tool (subagent_type general-purpose) running one Bash command"
    trigger claude SubagentStop "run subagent: the Agent tool (subagent_type general-purpose) running one Bash command"
    evidence claude PreToolUse observe n/a "inside the subagent, PreToolUse carries agent_id: $(run_payloads claude PreToolUse subagent | jq -r 'select(.agent_id) | .agent_id' | head -1 | sed 's/^$/<absent>/')" subagent
  fi
  if want_run subagent-exit2; then
    claude_wire subagent-exit2 SubagentStop=exit2
    claude_run subagent-exit2 "Use the Agent tool (subagent_type general-purpose) with the prompt: 'Run the Bash command echo PONG and reply with its output.' Wait for it and reply with what it returned." --permission-mode bypassPermissions
    evidence claude SubagentStop exit2 "$( [ "$(meta_count claude SubagentStop subagent-exit2)" -ge 2 ] && echo honored || echo not-honored )" "SubagentStop fired $(meta_count claude SubagentStop subagent-exit2) times in the run (exit 2 once, then the subagent stopped again); stop_hook_active on the second: $(run_payloads claude SubagentStop subagent-exit2 | jq -r '.stop_hook_active' | sed -n 2p); hook_response: $(claude_hook_outcome subagent-exit2 SubagentStop)" subagent-exit2
  fi

  # The ConfigChange pair is the one reply the STREAM cannot judge: a ConfigChange hook
  # never appears there (no hook_started, no hook_response, no exit code), so
  # `claude_hook_outcome` is empty for it no matter what the harness did. The two runs
  # below are therefore a CONTROLLED PAIR over an observable side effect — the session
  # rewrites its own .claude/settings.json to one that carries an EXTRA PreToolUse hook,
  # then makes one more tool call, and the question is whether that hook fires:
  #   config-change        ConfigChange observes (exit 0) -> the control. A firing tagged
  #                        `reloaded=1` proves a mid-session settings reload is real.
  #   config-change-exit2  ConfigChange exits 2           -> honored only if the same
  #                        firing is ABSENT while the control had it, and the file on disk
  #                        still carries the edit (the block stops the reload, not the write).
  # Run the pair together: --only config-change-exit2 alone has no control and says so.
  if want_run config-change; then
    WIRE_RELOAD_MARKER=1 claude_wire config-change; WIRE_RELOAD_MARKER=0
    claude_run config-change "Run this exact Bash command: cp .claude/settings-reloaded.json .claude/settings.json && sleep 4. Then run this exact Bash command: echo PROBE_SECOND_CALL. Then reply DONE." --permission-mode bypassPermissions
    trigger claude ConfigChange "run config-change: the session's own Bash copies a settings file carrying one EXTRA PreToolUse hook over .claude/settings.json mid-session, sleeps 4s, then makes one more Bash call"
    evidence claude ConfigChange observe "$( [ "$(reload_marker_count config-change)" -gt 0 ] && echo honored || echo not-honored )" "control for the exit2 row: with ConfigChange observing, the PreToolUse hook that only the REWRITTEN settings declare fired $(reload_marker_count config-change) time(s) on the next tool call — a mid-session settings reload is real and observable" config-change
  fi
  if want_run config-change-exit2; then
    WIRE_RELOAD_MARKER=1 claude_wire config-change-exit2 ConfigChange=exit2; WIRE_RELOAD_MARKER=0
    claude_run config-change-exit2 "Run this exact Bash command: cp .claude/settings-reloaded.json .claude/settings.json && sleep 4. Then run this exact Bash command: echo PROBE_SECOND_CALL. Then reply DONE." --permission-mode bypassPermissions
    cc_ctl="$(reload_marker_count config-change)"; cc_x2="$(reload_marker_count config-change-exit2)"
    evidence claude ConfigChange exit2 "$( if [ "$cc_ctl" -gt 0 ] && [ "$cc_x2" = 0 ]; then echo honored; elif [ "$cc_ctl" = 0 ]; then echo unobservable; else echo not-honored; fi )" "the hook that only the REWRITTEN settings declare fired $cc_x2 time(s) after the exit 2, against $cc_ctl in the control run config-change$( [ "$cc_ctl" = 0 ] && echo ' (NO CONTROL: run config-change too, or this row proves nothing)' ); the stream shows nothing either way (hook_response: $(claude_hook_outcome config-change-exit2 ConfigChange)); the file on disk keeps the edit: the extra hook is still declared there = $(jq -r 'try (.hooks.PreToolUse | map(.hooks[].command) | any(test("reloaded=1"))) catch false' "$CPR/.claude/settings.json" 2>/dev/null)" config-change-exit2
  fi

  if want_run command; then
    claude_wire command
    claude_run command "/probecmd" --permission-mode bypassPermissions
    trigger claude UserPromptExpansion "run command: the user prompt is the project command /probecmd (.claude/commands/probecmd.md)"
  fi
  if want_run command-exit2; then
    claude_wire command-exit2 UserPromptExpansion=exit2
    claude_run command-exit2 "/probecmd" --permission-mode bypassPermissions
    evidence claude UserPromptExpansion exit2 "$( claude_stream_has command-exit2 PROBE_COMMAND_EXPANDED && echo not-honored || echo honored )" "hook_response: $(claude_hook_outcome command-exit2 UserPromptExpansion); the command's expansion text reached the model: $( claude_stream_has command-exit2 PROBE_COMMAND_EXPANDED && echo yes || echo no ); final reply: $(claude_result command-exit2 | tr '\n' ' ' | cut -c1-160)" command-exit2
  fi
  if want_run prompt-exit2; then
    claude_wire prompt-exit2 UserPromptSubmit=exit2
    claude_run prompt-exit2 "Reply with exactly: PROMPT_WENT_THROUGH" --permission-mode bypassPermissions
    local answered; answered="$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$OUT/claude/runs/prompt-exit2.stream.jsonl" 2>/dev/null | grep -c PROMPT_WENT_THROUGH || true)"
    evidence claude UserPromptSubmit exit2 "$( [ "${answered:-0}" = 0 ] && echo honored || echo not-honored )" "hook_response: $(claude_hook_outcome prompt-exit2 UserPromptSubmit); assistant messages carrying the prompt's marker: ${answered:-0}; Stop fired: $(meta_count claude Stop prompt-exit2); final: $(claude_result prompt-exit2 | tr '\n' ' ' | cut -c1-160)" prompt-exit2
  fi
  if want_run stop-exit2; then
    claude_wire stop-exit2 Stop=exit2
    claude_run stop-exit2 "Reply with exactly: FIRST_STOP" --permission-mode bypassPermissions
    evidence claude Stop exit2 "$( [ "$(meta_count claude Stop stop-exit2)" -ge 2 ] && echo honored || echo not-honored )" "Stop fired $(meta_count claude Stop stop-exit2) times (exit 2 once; the model continued and stopped again); stop_hook_active on the second: $(run_payloads claude Stop stop-exit2 | jq -r '.stop_hook_active' | sed -n 2p); hook_response: $(claude_hook_outcome stop-exit2 Stop)" stop-exit2
  fi
  if want_run stop-block; then
    claude_wire stop-block Stop=deny
    claude_run stop-block "Reply with exactly: FIRST_STOP" --permission-mode bypassPermissions
    evidence claude Stop 'decision:block' "$( [ "$(meta_count claude Stop stop-block)" -ge 2 ] && echo honored || echo not-honored )" "Stop fired $(meta_count claude Stop stop-block) times ({\"decision\":\"block\"} once); stop_hook_active on the second: $(run_payloads claude Stop stop-block | jq -r '.stop_hook_active' | sed -n 2p)" stop-block
  fi
  if want_run posttool-block; then
    claude_wire posttool-block PostToolUse=deny
    claude_run posttool-block "Run with Bash: echo PROBE_PT. Then reply with the tool's output and, verbatim, any hook message you were shown." --permission-mode bypassPermissions
    evidence claude PostToolUse 'decision:block' "$( claude_stream_has posttool-block PROBE_BLOCK && echo honored || echo unobservable )" "hook_response: $(claude_hook_outcome posttool-block PostToolUse); the reason PROBE_BLOCK reached the model/stream: $( claude_stream_has posttool-block PROBE_BLOCK && echo yes || echo no )" posttool-block
  fi
  if want_run pretool-deny; then
    claude_wire pretool-deny PreToolUse=deny
    claude_run pretool-deny "Run with Bash: echo PROBE_PRE. Reply with its output, or the error verbatim." --permission-mode bypassPermissions
    evidence claude PreToolUse 'permissionDecision:deny' "$( [ "$(meta_count claude PostToolUse pretool-deny)" = 0 ] && echo honored || echo not-honored )" "PostToolUse fired $(meta_count claude PostToolUse pretool-deny) times after the deny (0 = the tool never ran); reason reached the model: $( claude_stream_has pretool-deny PROBE_DENY && echo yes || echo no )" pretool-deny
  fi

  if want_run perm-allow; then
    claude_wire perm-allow PermissionRequest=allow
    claude_run perm-allow "Run with Bash: touch probe-allow.txt && echo PROBE_ALLOWED. Reply with its output or the error." --permission-prompts none
    trigger claude PermissionRequest "run perm-allow: default permission mode with --permission-prompts none; Bash touch (not auto-approved) needs a decision"
    trigger claude Notification "runs perm-allow / perm-deny / perm-host: a permission decision in a headless session (matcher permission_prompt)"
    evidence claude PermissionRequest 'decision:allow' "$( [ -f "$CPR/probe-allow.txt" ] && echo honored || echo not-honored )" "the file the command creates exists: $( [ -f "$CPR/probe-allow.txt" ] && echo yes || echo no ); PostToolUse fired: $(meta_count claude PostToolUse perm-allow)" perm-allow
  fi
  if want_run perm-deny; then
    claude_wire perm-deny PermissionRequest=deny
    claude_run perm-deny "Run with Bash: touch probe-deny.txt && echo PROBE_DENIED_TRY. Reply with its output or the error verbatim." --permission-prompts none
    evidence claude PermissionRequest 'decision:deny' "$( [ ! -f "$CPR/probe-deny.txt" ] && [ "$(meta_count claude PermissionRequest perm-deny)" -ge 1 ] && echo honored || echo not-honored )" "the file exists: $( [ -f "$CPR/probe-deny.txt" ] && echo yes || echo no ); message PROBE_DENY reached the model: $( claude_stream_has perm-deny PROBE_DENY && echo yes || echo no ); PermissionDenied fired: $(meta_count claude PermissionDenied perm-deny)" perm-deny
  fi
  if want_run perm-host; then
    claude_wire perm-host PermissionRequest=allow
    claude_run perm-host "Run with Bash: touch probe-host.txt && echo PROBE_HOST. Reply with its output or the error."
    trigger claude PermissionRequest "run perm-host: the same Bash touch with the default --permission-prompts host (a plain CLI -p has no host)"
    evidence claude PermissionRequest 'decision:allow (host prompts)' "$( [ "$(meta_count claude PermissionRequest perm-host)" -ge 1 ] && echo honored || echo not-honored )" "with --permission-prompts host (the default) the hook fired $(meta_count claude PermissionRequest perm-host) times and the file exists: $( [ -f "$CPR/probe-host.txt" ] && echo yes || echo no ) — permission_denials in the result: $(jq -r 'select(.type=="result") | (.permission_denials // [])|length' "$OUT/claude/runs/perm-host.stream.jsonl" 2>/dev/null | head -1)" perm-host
  fi
  if want_run perm-auto; then
    claude_wire perm-auto
    claude_run perm-auto "Run with Bash: touch probe-auto.txt && echo PROBE_AUTO. Reply with its output or the error." --permission-mode auto
    trigger claude PermissionDenied "run perm-auto: --permission-mode auto with a Bash touch (denied, permission_denials=$(jq -r 'select(.type=="result") | (.permission_denials // [])|length' "$OUT/claude/runs/perm-auto.stream.jsonl" 2>/dev/null | head -1)); also run perm-deny: a PermissionRequest hook answering deny"
  fi

  if want_run system-message; then
    claude_wire system-message SessionStart=systemMessage UserPromptSubmit=systemMessage PreToolUse=systemMessage PostToolUse=systemMessage Stop=systemMessage SessionEnd=systemMessage PostToolBatch=systemMessage CwdChanged=systemMessage InstructionsLoaded=systemMessage MessageDisplay=systemMessage
    claude_run system-message "Run with Bash: echo hi. Then reply DONE." --permission-mode bypassPermissions
    local tp; tp="$(first_transcript claude system-message)"
    local instream intranscript
    instream="$(jq -r 'select((.type=="system") and (.subtype!="hook_response") and (.subtype!="hook_started") and ((.|tostring)|test("PROBE_SYSMSG"))) | .subtype' "$OUT/claude/runs/system-message.stream.jsonl" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
    intranscript="$( [ -n "$tp" ] && [ -f "$tp" ] && grep -o 'PROBE_SYSMSG [A-Za-z]*' "$tp" | sort | uniq -c | tr -s ' ' | tr '\n' ';' )"
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse Stop SessionEnd PostToolBatch CwdChanged InstructionsLoaded MessageDisplay; do
      local seen; seen="$(grep -c "PROBE_SYSMSG $ev" "$OUT/claude/runs/system-message.stream.jsonl" 2>/dev/null || true)"
      evidence claude "$ev" systemMessage "$( [ "${seen:-0}" -gt 0 ] && echo honored || echo unobservable )" "marker PROBE_SYSMSG $ev appears $seen times in the stream-json output (outside hook_response echoes: ${instream:-none}); in the transcript: ${intranscript:-none}" system-message
    done
  fi
  if want_run additional-context; then
    claude_wire additional-context SessionStart=additionalContext UserPromptSubmit=additionalContext PreToolUse=additionalContext PostToolUse=additionalContext InstructionsLoaded=additionalContext CwdChanged=additionalContext PostToolBatch=additionalContext SubagentStart=additionalContext
    claude_run additional-context "Run with Bash: echo hi. Then reply with every line you were given that contains the word PROBE_CTX, verbatim, one per line; if there is none, reply NONE." --permission-mode bypassPermissions
    local reply tp2 intr; reply="$(claude_result additional-context)"; tp2="$(first_transcript claude additional-context)"
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse InstructionsLoaded PostToolBatch; do
      intr="$( [ -n "$tp2" ] && [ -f "$tp2" ] && grep -c "PROBE_CTX $ev" "$tp2" || echo 0 )"
      evidence claude "$ev" additionalContext "$( { printf '%s' "$reply" | grep -q "PROBE_CTX $ev" || [ "${intr:-0}" -gt 0 ]; } && echo honored || echo not-honored )" "the model repeated 'PROBE_CTX $ev': $( printf '%s' "$reply" | grep -q "PROBE_CTX $ev" && echo yes || echo no ); the marker is in the transcript ${intr:-0} time(s) (event fired in the run: $(meta_count claude "$ev" additional-context) times)" additional-context
    done
  fi

  if want_run compact-auto; then
    claude_wire compact-auto
    # `--autocompact 100000` (the documented flag; 100k is its floor) compacts once for
    # three 120 KB reads. The env pair CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000 +
    # CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 also fires both events (pilot-verified) but
    # compacts on every read and once looped past the run timeout. No --session-id here:
    # in the pilots auto-compaction stalled at "compacting" in 4 of 6 sessions started
    # with an explicit id and in 0 of 6 without one.
    claude_run compact-auto "Use the Read tool on big.txt (the whole file, no offset and no limit) three separate times, one call at a time. Then run Bash: wc -c big.txt. Then reply DONE." --permission-mode bypassPermissions --autocompact 100000
    if [ "$(meta_count claude PostCompact compact-auto)" = 0 ]; then
      # A compaction that never completes (the summarizer call stalling) is a transient
      # the pilots saw; one retry on a fresh session, recorded as its own run.
      note "PostCompact did not fire — retrying once on a fresh session"
      claude_wire compact-auto
      claude_run compact-auto-retry "Use the Read tool on big.txt (the whole file, no offset and no limit) three separate times, one call at a time. Then run Bash: wc -c big.txt. Then reply DONE." --permission-mode bypassPermissions --autocompact 100000
    fi
    trigger claude PreCompact "run compact-auto: --autocompact 100000 and three full reads of a 120 KB file (CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000 + CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 fired both events too in the pilot)"
    trigger claude PostCompact "run compact-auto: --autocompact 100000 and three full reads of a 120 KB file (CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000 + CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 fired both events too in the pilot)"
    evidence claude PreCompact observe n/a "auto compaction: PreCompact fired $(meta_count claude PreCompact compact-auto) times, PostCompact $(meta_count claude PostCompact compact-auto) times; compact_boundary in the stream: $(jq -c 'select(.type=="system" and .subtype=="compact_boundary") | .compact_metadata | {trigger,pre_tokens,post_tokens}' "$OUT/claude/runs/compact-auto.stream.jsonl" 2>/dev/null | head -1); SessionStart fired again after each compaction (source: $(run_payloads claude SessionStart compact-auto | jq -r '.source' | sort -u | tr '\n' ','))" compact-auto
  fi
  if want_run compact-manual; then
    local MSID; MSID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
    claude_wire compact-manual-seed
    claude_run compact-manual-seed "Use the Read tool on big.txt once (whole file). Then reply DONE." --permission-mode bypassPermissions --session-id "$MSID"
    claude_wire compact-manual
    claude_run compact-manual "/compact" --permission-mode bypassPermissions --resume "$MSID"
    if [ "$(meta_count claude PostCompact compact-manual)" = 0 ]; then
      note "PostCompact did not fire — retrying /compact once on the same session"
      claude_run compact-manual-retry "/compact" --permission-mode bypassPermissions --resume "$MSID"
    fi
    trigger claude PreCompact "run compact-manual: \`claude -p --resume <id> /compact\`"
    trigger claude PostCompact "run compact-manual: \`claude -p --resume <id> /compact\`"
    evidence claude PreCompact observe n/a "manual compaction via /compact on a resumed session: PreCompact $(meta_count claude PreCompact compact-manual), PostCompact $(meta_count claude PostCompact compact-manual) (trigger: $(run_payloads claude PreCompact compact-manual | jq -r '.trigger' | head -1))" compact-manual
  fi

  local st port pid
  for st in 401 429 500 529; do
    want_run "fail-$st" || continue
    port=$((18700 + st % 1000)); pid="$(stub_start "$port" "$st" anthropic "$OUT/stubs/claude-$st.jsonl")"
    claude_wire "fail-$st"
    CLAUDE_ENV="ANTHROPIC_BASE_URL=http://127.0.0.1:$port CLAUDE_CODE_MAX_RETRIES=0" claude_run "fail-$st" "Reply OK" --permission-mode bypassPermissions
    stub_stop "$pid"
    trigger claude StopFailure "run fail-$st: ANTHROPIC_BASE_URL at a Python-stdlib stub answering HTTP $st (CLAUDE_CODE_MAX_RETRIES=0)"
    evidence claude StopFailure observe n/a "HTTP $st from the stub ($(count_lines "$OUT/stubs/claude-$st.jsonl") request(s) to $(jq -r '.path' "$OUT/stubs/claude-$st.jsonl" 2>/dev/null | head -1)) → StopFailure error=$(run_payloads claude StopFailure "fail-$st" | jq -r '.error // .error_type // "<absent>"' | head -1); Stop fired: $(meta_count claude Stop "fail-$st"); SessionEnd fired: $(meta_count claude SessionEnd "fail-$st")" "fail-$st"
  done

  local MCPCFG="$TMP/mcp.json"
  printf '{"mcpServers":{"probeelicit":{"command":"python3","args":["%s","--log","%s/stubs/mcp-elicit.jsonl"]}}}' "$MCPSTUB" "$OUT" > "$MCPCFG"
  if want_run elicit-observe; then
    claude_wire elicit-observe
    claude_run elicit-observe "Call the MCP tool mcp__probeelicit__ask_probe with question 'What is the probe answer?' and reply with exactly the text it returned." --permission-mode bypassPermissions --mcp-config "$MCPCFG"
    trigger claude Elicitation "run elicit-observe: a stdio MCP stub whose tool sends elicitation/create back to the client"
    trigger claude ElicitationResult "run elicit-observe: the same elicitation, unanswered by any hook, in a headless session (auto-cancelled)"
    evidence claude ElicitationResult observe n/a "with no hook answer the headless session cancelled: action=$(run_payloads claude ElicitationResult elicit-observe | jq -r '.action' | head -1); the MCP server received: $(jq -c 'select(.dir=="in" and .msg.result) | .msg.result' "$OUT/stubs/mcp-elicit.jsonl" 2>/dev/null | head -1)" elicit-observe
  fi
  if want_run elicit-accept; then
    claude_wire elicit-accept Elicitation=elicit
    claude_run elicit-accept "Call the MCP tool mcp__probeelicit__ask_probe with question 'What is the probe answer?' and reply with exactly the text it returned." --permission-mode bypassPermissions --mcp-config "$MCPCFG"
    evidence claude Elicitation 'action:accept+content' "$( claude_stream_has elicit-accept PROBE_ELICIT && echo honored || echo not-honored )" "the MCP server received the hook's answer: $(jq -c 'select(.dir=="in" and .msg.result) | .msg.result' "$OUT/stubs/mcp-elicit.jsonl" 2>/dev/null | tail -1); ElicitationResult fired: $(meta_count claude ElicitationResult elicit-accept) (it fires only on the user/cancel path)" elicit-accept
  fi

  if want_run worktree; then
    claude_wire worktree
    claude_run worktree "Run with Bash: pwd. Reply with the output." --permission-mode bypassPermissions --worktree probe-wt
    trigger claude WorktreeCreate "run worktree: \`claude -p --worktree probe-wt\` in a git project (the hook creates the worktree and echoes its path — an empty answer aborts the session)"
    trigger claude WorktreeRemove "run worktree: the --worktree session exiting with a clean worktree; run worktree-agent: an Agent tool call with isolation worktree finishing"
    evidence claude WorktreeCreate worktree "$( claude_stream_has worktree ".probe-worktrees/probe-wt" && echo honored || echo not-honored )" "the session ran inside the path the hook echoed: $( claude_stream_has worktree ".probe-worktrees/probe-wt" && echo yes || echo no ); worktrees after the run: $(git -C "$CPR" worktree list 2>/dev/null | wc -l | tr -d ' ')" worktree
  fi
  if want_run worktree-agent; then
    claude_wire worktree-agent
    claude_run worktree-agent "Use the Agent tool with subagent_type general-purpose and isolation 'worktree', prompt: 'Run the Bash command pwd and reply with its output.' Wait for it and reply with what it returned." --permission-mode bypassPermissions
  fi
  if want_run setup-init; then
    claude_wire setup-init
    claude_run setup-init "Reply OK" --permission-mode bypassPermissions --init
    trigger claude Setup "run setup-init: \`claude -p --init\`; run setup-maintenance: \`claude -p --maintenance\`"
  fi
  if want_run setup-maintenance; then
    claude_wire setup-maintenance
    claude_run setup-maintenance "Reply OK" --permission-mode bypassPermissions --maintenance
  fi
  if want_run model-switch; then
    claude_wire model-switch
    claude_run model-switch "/model sonnet" --permission-mode bypassPermissions
    trigger claude PreModelSwitch "run model-switch: the /model sonnet command in a -p session started on $CLAUDE_MODEL"
    trigger claude PostModelSwitch "run model-switch: the /model sonnet command in a -p session started on $CLAUDE_MODEL"
  fi
  if want_run model-switch-exit2; then
    claude_wire model-switch-exit2 PreModelSwitch=exit2
    claude_run model-switch-exit2 "/model sonnet" --permission-mode bypassPermissions
    evidence claude PreModelSwitch exit2 "$( [ "$(meta_count claude PostModelSwitch model-switch-exit2)" = 0 ] && echo honored || echo not-honored )" "PostModelSwitch fired $(meta_count claude PostModelSwitch model-switch-exit2) times after the block (0 = the switch did not happen); final: $(claude_result model-switch-exit2 | tr '\n' ' ' | cut -c1-160)" model-switch-exit2
  fi
  if want_run add-dir; then
    claude_wire add-dir
    claude_run add-dir "/add-dir $TMP/extra-dir" --permission-mode bypassPermissions
    mkdir -p "$TMP/extra-dir"
    printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply OK"}]}}' \
      "{\"type\":\"control_request\",\"request_id\":\"probe-1\",\"request\":{\"subtype\":\"register_repo_root\",\"directory\":\"$TMP/extra-dir\"}}" > "$TMP/stdin.jsonl"
    say "claude · add-dir-control (register_repo_root control request over stream-json stdin)"
    ( cd "$CPR" && clean_env timeout "$CLAUDE_TIMEOUT" claude -p --setting-sources project --model "$CLAUDE_MODEL" --permission-mode bypassPermissions \
        --input-format stream-json --output-format stream-json --include-hook-events --verbose \
        < "$TMP/stdin.jsonl" > "$OUT/claude/runs/add-dir-control.stream.jsonl" 2> "$OUT/claude/runs/add-dir-control.stderr.txt" ); rc=$?
    record_run claude add-dir-control "$rc" 0 "claude -p --input-format stream-json (control_request register_repo_root directory=$TMP/extra-dir)" "Reply OK" ""
    note "control_response: $(jq -c 'select(.type=="control_response") | .response' "$OUT/claude/runs/add-dir-control.stream.jsonl" 2>/dev/null | head -1 | cut -c1-200)"
    trigger claude DirectoryAdded "run add-dir: the /add-dir command in -p (answer: $(claude_result add-dir | cut -c1-80)); run add-dir-control: an SDK control_request register_repo_root over stream-json stdin (response: $(jq -c 'select(.type=="control_response") | .response.subtype // .response' "$OUT/claude/runs/add-dir-control.stream.jsonl" 2>/dev/null | head -1 | cut -c1-120))"
  fi
  if want_run teams; then
    claude_wire teams
    CLAUDE_ENV="CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1" claude_run teams "If you have a TeamCreate tool, create a team named probe-team, spawn one teammate with the Agent tool (team_name probe-team, name pinger) asking it to reply PONG, wait for it to finish and go idle, then delete the team with TeamDelete; if you do not have TeamCreate, reply exactly NO_TEAM_TOOL." --permission-mode bypassPermissions
    trigger claude TeammateIdle "run teams: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and a prompt asking for TeamCreate + one teammate going idle (reply: $(claude_result teams | cut -c1-60))"
  fi
  if want_run unauth; then
    claude_wire unauth
    say "claude · unauth (temp CLAUDE_CONFIG_DIR, no login: hooks fire anyway)"
    ( cd "$CPR" && clean_env CLAUDE_CONFIG_DIR="$CC" timeout "$CLAUDE_TIMEOUT" claude -p --setting-sources project --model "$CLAUDE_MODEL" --permission-mode bypassPermissions \
        --output-format stream-json --include-hook-events --verbose "Reply OK" < /dev/null > "$OUT/claude/runs/unauth.stream.jsonl" 2> "$OUT/claude/runs/unauth.stderr.txt" ); rc=$?
    record_run claude unauth "$rc" 0 "CLAUDE_CONFIG_DIR=<temp> claude -p --setting-sources project --model $CLAUDE_MODEL --permission-mode bypassPermissions" "Reply OK" "unauthenticated pass"
    note "rc=$rc · result: $(claude_result unauth | cut -c1-100)"
    trigger claude StopFailure "run unauth: a fresh CLAUDE_CONFIG_DIR with no login (Not logged in)"
    evidence claude StopFailure observe n/a "unauthenticated temp config dir: StopFailure error=$(run_payloads claude StopFailure unauth | jq -r '.error // "<absent>"' | head -1); events that fired: $(grep -l '"run":"unauth"' "$OUT"/claude/*.meta.jsonl 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/.meta.jsonl//' | tr '\n' ' ')" unauth
  fi
}

# ---- Codex CLI ------------------------------------------------------------------------
XPR="$TMP/codex-project"
codex_project() {
  mkdir -p "$XPR/.leopold" "$XPR/.codex/agents"
  ( cd "$XPR" || exit 1
    printf '# probe project\n\nThis AGENTS.md exists so the project memory file is loaded.\n' > AGENTS.md
    printf '# Plan\n- [ ] item one\n' > .leopold/PLAN.md
    head -c 90000 /dev/urandom | base64 > big.txt
    printf 'name = "probe-reviewer"\ndescription = "Probe role: answers with a fixed token"\ndeveloper_instructions = "You are the probe reviewer role. Whatever you are asked, reply with exactly: ROLE_PROBE_REVIEWER"\nmodel_reasoning_effort = "low"\n' > .codex/agents/probe-reviewer.toml )
  cp "$HOME/.codex/auth.json" "$CH/auth.json"; chmod 600 "$CH/auth.json"
}
codex_wire() { # <run> [Event=mode ...]
  local run="$1"; shift
  local specs=() ev mode ov
  for ev in $CODEX_EVENTS; do
    mode=observe
    for ov in "$@"; do case "$ov" in "$ev="*) mode="${ov#*=}" ;; esac; done
    specs+=("$ev||bash $DUMP $ev --out $OUT --harness codex --run $run --mode $mode|10")
  done
  leo_wire_hooks_toml "$CH/config.toml" probe "${specs[@]}" >/dev/null || die "could not wire $CH/config.toml"
  [ "${LEO_WIRED_COUNT:-0}" = "${#specs[@]}" ] || \
    die "wired ${LEO_WIRED_COUNT:-0}/${#specs[@]} hooks into $CH/config.toml (refused: ${LEO_REFUSED_EVENTS:-none})"
}
# codex_run <name> <prompt> [codex args...]  (CODEX_ENV="K=V" for extra env)
codex_run() {
  local name="$1" prompt="$2"; shift 2
  local t0 rc; t0="$(date +%s)"
  say "codex · $name"
  # shellcheck disable=SC2086
  ( codex_env ${CODEX_ENV:-} timeout "$CODEX_TIMEOUT" codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C "$XPR" "$@" "$prompt" \
      < /dev/null > "$OUT/codex/runs/$name.stream.jsonl" 2> "$OUT/codex/runs/$name.stderr.txt" ); rc=$?
  record_run codex "$name" "$rc" "$(( $(date +%s) - t0 ))" "codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> $*" "$prompt" "${CODEX_ENV:-}"
  note "rc=$rc · $(( $(date +%s) - t0 ))s · last message: $(codex_last "$name" | cut -c1-140)"
  return $rc
}
codex_last() { jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' "$OUT/codex/runs/$1.stream.jsonl" 2>/dev/null | tail -1; }
codex_errors() { jq -r 'select(.type=="error" or (.item.type // "")=="error" or .type=="turn.failed") | (.message // .item.message // .error.message // "")' "$OUT/codex/runs/$1.stream.jsonl" 2>/dev/null | grep -v 'bypass-hook-trust\|clamping .* hook timeout' | head -3 | tr '\n' ' '; }
codex_stream_has() { grep -q -- "$2" "$OUT/codex/runs/$1.stream.jsonl" 2>/dev/null; }

codex_all() {
  say "Codex CLI — $CODEX_VERSION"
  codex_project
  local NET="Run the shell command: curl -sI https://example.com | head -1. If the sandbox blocks network access, request approval to run it again with network access (escalated / unsandboxed), once. Reply with the output or the error verbatim."

  if want_run tools; then
    codex_wire tools
    ( external_write_when "$OUT/codex/PreToolUse.jsonl" '"command":"sleep 6' "$XPR/.leopold/PLAN.md" "- [ ] external line (written by another process)" 120 ) &
    codex_run tools "Do these steps in order with tools, one tool call per step: 1) run the shell command: true  2) run the shell command: false (it fails; continue)  3) run: grep -c zzz /dev/null (exit 1; continue)  4) edit the file .leopold/PLAN.md with your file-edit tool so 'item one' becomes 'item one (edited)' (keep the leading '- [ ] ')  5) run the shell command: sleep 6  6) run: cat .leopold/PLAN.md. Then reply with the single word DONE." --dangerously-bypass-approvals-and-sandbox
    wait
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse Stop SessionEnd; do
      trigger codex "$ev" "run tools: a headless \`codex exec\` turn in a project with an AGENTS.md that runs \`true\`, \`false\`, \`grep -c zzz /dev/null\`, an apply_patch edit of .leopold/PLAN.md, \`sleep 6\` (the driver appends to .leopold/PLAN.md from another process meanwhile) and \`cat\`"
    done
    local missing; missing="$(comm -23 <(run_payloads codex PreToolUse tools | jq -r '.tool_use_id' | sort) <(run_payloads codex PostToolUse tools | jq -r '.tool_use_id' | sort) | wc -l | tr -d ' ')"
    evidence codex PostToolUse observe n/a "Bash \`true\`: tool_response=$(run_payloads codex PostToolUse tools | jq -c 'select(.tool_input.command=="true") | .tool_response' | head -1); Bash \`false\`: PostToolUse fired $(run_payloads codex PostToolUse tools | jq -r 'select(.tool_input.command=="false") | "yes"' | head -1 | sed 's/^$/no/') with tool_response=$(run_payloads codex PostToolUse tools | jq -c 'select(.tool_input.command=="false") | .tool_response' | head -1) — no exit code in either; PreToolUse calls without a PostToolUse in the run: $missing (failed apply_patch attempts); edit tool name: $(run_payloads codex PreToolUse tools | jq -r 'select(.tool_name!="Bash") | .tool_name' | sort -u | tr '\n' ',')" tools
  fi

  if want_run subagent; then
    codex_wire subagent
    codex_run subagent "Use spawn_agent to spawn one subagent (default role) with the message 'Reply with exactly PONG'; wait for it with wait_agent; then close it. Reply with exactly what it returned." --dangerously-bypass-approvals-and-sandbox
    trigger codex SubagentStart "run subagent: spawn_agent (default role) + wait_agent"
    trigger codex SubagentStop "run subagent: spawn_agent (default role) + wait_agent"
    evidence codex SubagentStart observe n/a "spawn tool name as seen by PreToolUse: $(run_payloads codex PreToolUse subagent | jq -r 'select(.tool_name|test("spawn")) | .tool_name' | head -1); SubagentStop carries agent_transcript_path: $(run_payloads codex SubagentStop subagent | jq -r 'has("agent_transcript_path")' | head -1)" subagent
  fi
  if want_run subagent-role; then
    codex_wire subagent-role
    codex_run subagent-role "Use spawn_agent with agent_type 'probe-reviewer' and the message 'hello'; wait for it with wait_agent; reply with exactly what it returned." --dangerously-bypass-approvals-and-sandbox
    trigger codex SubagentStart "run subagent-role: spawn_agent with agent_type probe-reviewer (.codex/agents/probe-reviewer.toml)"
    evidence codex SubagentStart 'role file' "$( codex_stream_has subagent-role ROLE_PROBE_REVIEWER && echo honored || echo not-honored )" "agent_type in SubagentStart: $(run_payloads codex SubagentStart subagent-role | jq -r '.agent_type' | head -1); the role's fixed reply came back: $( codex_stream_has subagent-role ROLE_PROBE_REVIEWER && echo yes || echo no )" subagent-role
  fi
  if want_run role-bogus || want_run role-bogus-strict; then
    printf 'name = "bogus"\ndescription = "Probe role with an unknown key"\ndeveloper_instructions = "Reply with exactly: ROLE_BOGUS"\nbogus_key = 1\n' > "$XPR/.codex/agents/bogus.toml"
    if want_run role-bogus; then
      codex_wire role-bogus
      codex_run role-bogus "Use spawn_agent with agent_type 'bogus' and message 'hi'; wait for it; reply with exactly what it returned, or the error text verbatim." --dangerously-bypass-approvals-and-sandbox
      evidence codex SubagentStart 'role file with an unknown key' n/a "without --strict-config: $(codex_errors role-bogus | cut -c1-200); reply: $(codex_last role-bogus | cut -c1-120)" role-bogus
    fi
    if want_run role-bogus-strict; then
      codex_wire role-bogus-strict
      codex_run role-bogus-strict "Use spawn_agent with agent_type 'bogus' and message 'hi'; wait for it; reply with exactly what it returned, or the error text verbatim." --dangerously-bypass-approvals-and-sandbox --strict-config
      evidence codex SubagentStart 'role file with an unknown key (--strict-config)' n/a "with --strict-config: $(codex_errors role-bogus-strict | cut -c1-200); reply: $(codex_last role-bogus-strict | cut -c1-120)" role-bogus-strict
    fi
    rm -f "$XPR/.codex/agents/bogus.toml"
  fi
  if want_run subagent-exit2; then
    codex_wire subagent-exit2 SubagentStop=exit2
    codex_run subagent-exit2 "Use spawn_agent to spawn one subagent (default role) with the message 'Reply with exactly PONG'; wait for it with wait_agent; then close it. Reply with exactly what it returned." --dangerously-bypass-approvals-and-sandbox
    evidence codex SubagentStop exit2 "$( [ "$(meta_count codex SubagentStop subagent-exit2)" -ge 2 ] && echo honored || echo not-honored )" "SubagentStop fired $(meta_count codex SubagentStop subagent-exit2) times (exit 2 once); stop_hook_active on the second: $(run_payloads codex SubagentStop subagent-exit2 | jq -r '.stop_hook_active' | sed -n 2p)" subagent-exit2
  fi
  if want_run stop-exit2; then
    codex_wire stop-exit2 Stop=exit2
    codex_run stop-exit2 "Reply with exactly: FIRST_STOP" --dangerously-bypass-approvals-and-sandbox
    evidence codex Stop exit2 "$( [ "$(meta_count codex Stop stop-exit2)" -ge 2 ] && echo honored || echo not-honored )" "Stop fired $(meta_count codex Stop stop-exit2) times (exit 2 once); stop_hook_active on the second: $(run_payloads codex Stop stop-exit2 | jq -r '.stop_hook_active' | sed -n 2p); messages: $(jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' "$OUT/codex/runs/stop-exit2.stream.jsonl" 2>/dev/null | wc -l | tr -d ' ')" stop-exit2
  fi
  if want_run stop-block; then
    codex_wire stop-block Stop=deny
    codex_run stop-block "Reply with exactly: FIRST_STOP" --dangerously-bypass-approvals-and-sandbox
    evidence codex Stop 'decision:block' "$( [ "$(meta_count codex Stop stop-block)" -ge 2 ] && echo honored || echo not-honored )" "Stop fired $(meta_count codex Stop stop-block) times ({\"decision\":\"block\"} once); stop_hook_active on the second: $(run_payloads codex Stop stop-block | jq -r '.stop_hook_active' | sed -n 2p)" stop-block
  fi
  if want_run prompt-exit2; then
    codex_wire prompt-exit2 UserPromptSubmit=exit2
    codex_run prompt-exit2 "Reply with exactly: PROMPT_WENT_THROUGH" --dangerously-bypass-approvals-and-sandbox
    evidence codex UserPromptSubmit exit2 "$( codex_stream_has prompt-exit2 PROMPT_WENT_THROUGH && echo not-honored || echo honored )" "the model answered the prompt: $( codex_stream_has prompt-exit2 PROMPT_WENT_THROUGH && echo yes || echo no ); Stop fired: $(meta_count codex Stop prompt-exit2); errors: $(codex_errors prompt-exit2 | cut -c1-160)" prompt-exit2
  fi
  if want_run posttool-block; then
    codex_wire posttool-block PostToolUse=deny
    codex_run posttool-block "Run the shell command: echo PROBE_PT. Then reply with the tool's output and, verbatim, any hook message you were shown." --dangerously-bypass-approvals-and-sandbox
    evidence codex PostToolUse 'decision:block' "$( codex_stream_has posttool-block PROBE_BLOCK && echo honored || echo unobservable )" "the reason PROBE_BLOCK reached the model/stream: $( codex_stream_has posttool-block PROBE_BLOCK && echo yes || echo no ); reply: $(codex_last posttool-block | cut -c1-160)" posttool-block
  fi
  if want_run pretool-deny; then
    codex_wire pretool-deny PreToolUse=deny
    codex_run pretool-deny "Run the shell command: echo PROBE_PRE. Reply with its output, or the error verbatim." --dangerously-bypass-approvals-and-sandbox
    evidence codex PreToolUse 'permissionDecision:deny' "$( [ "$(meta_count codex PostToolUse pretool-deny)" = 0 ] && echo honored || echo not-honored )" "PostToolUse fired $(meta_count codex PostToolUse pretool-deny) times after the deny (0 = the tool never ran); reason reached the model: $( codex_stream_has pretool-deny PROBE_DENY && echo yes || echo no )" pretool-deny
  fi
  if want_run perm-allow; then
    codex_wire perm-allow PermissionRequest=allow
    codex_run perm-allow "$NET" --approve-for-me
    trigger codex PermissionRequest "run perm-allow: --approve-for-me and a curl that needs network escalation out of the workspace-write sandbox"
    evidence codex PermissionRequest 'decision:allow' "$( codex_stream_has perm-allow 'HTTP/' && echo honored || echo not-honored )" "the escalated curl ran (an HTTP status line came back): $( codex_stream_has perm-allow 'HTTP/' && echo yes || echo no ); PermissionRequest fired: $(meta_count codex PermissionRequest perm-allow)" perm-allow
  fi
  if want_run perm-deny; then
    codex_wire perm-deny PermissionRequest=deny
    codex_run perm-deny "$NET" --approve-for-me
    evidence codex PermissionRequest 'decision:deny' "$( codex_stream_has perm-deny PROBE_DENY && echo honored || echo not-honored )" "the deny message reached the model: $( codex_stream_has perm-deny PROBE_DENY && echo yes || echo no ); an HTTP status line came back: $( codex_stream_has perm-deny 'HTTP/' && echo yes || echo no ); stderr: $(grep -o 'Rejected([^)]*)' "$OUT/codex/runs/perm-deny.stderr.txt" 2>/dev/null | head -1)" perm-deny
  fi
  if want_run perm-onrequest; then
    codex_wire perm-onrequest PermissionRequest=allow
    codex_run perm-onrequest "$NET" -s workspace-write -c 'approval_policy="on-request"'
    trigger codex PermissionRequest "run perm-onrequest: -s workspace-write -c approval_policy=\"on-request\" and the same curl (fired: $(meta_count codex PermissionRequest perm-onrequest) times)"
    evidence codex PermissionRequest 'decision:allow (approval_policy=on-request)' "$( [ "$(meta_count codex PermissionRequest perm-onrequest)" -ge 1 ] && echo honored || echo not-honored )" "under approval_policy=on-request in headless exec the hook fired $(meta_count codex PermissionRequest perm-onrequest) times; reply: $(codex_last perm-onrequest | cut -c1-160)" perm-onrequest
  fi
  if want_run system-message; then
    codex_wire system-message SessionStart=systemMessage UserPromptSubmit=systemMessage PreToolUse=systemMessage PostToolUse=systemMessage Stop=systemMessage SessionEnd=systemMessage
    codex_run system-message "Run the shell command: echo hi. Then reply DONE." --dangerously-bypass-approvals-and-sandbox
    local tp; tp="$(first_transcript codex system-message)"
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse Stop SessionEnd; do
      local seen_s seen_t; seen_s="$(grep -c "PROBE_SYSMSG $ev" "$OUT/codex/runs/system-message.stream.jsonl" 2>/dev/null || true)"; seen_t="$( [ -n "$tp" ] && [ -f "$tp" ] && grep -c "PROBE_SYSMSG $ev" "$tp" || echo 0 )"
      evidence codex "$ev" systemMessage "$( [ "${seen_s:-0}" -gt 0 ] || [ "${seen_t:-0}" -gt 0 ] && echo honored || echo unobservable )" "marker PROBE_SYSMSG $ev in the --json stream: ${seen_s:-0} times; in the rollout transcript: ${seen_t:-0} times" system-message
    done
  fi
  if want_run additional-context; then
    codex_wire additional-context SessionStart=additionalContext UserPromptSubmit=additionalContext PreToolUse=additionalContext PostToolUse=additionalContext SubagentStart=additionalContext
    codex_run additional-context "Run the shell command: echo hi. Then reply with every line you were given that contains the word PROBE_CTX, verbatim, one per line; if there is none, reply NONE." --dangerously-bypass-approvals-and-sandbox
    local reply; reply="$(codex_last additional-context)"
    for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse; do
      evidence codex "$ev" additionalContext "$( printf '%s' "$reply" | grep -q "PROBE_CTX $ev" && echo honored || echo not-honored )" "the model repeated 'PROBE_CTX $ev': $( printf '%s' "$reply" | grep -q "PROBE_CTX $ev" && echo yes || echo no )" additional-context
    done
  fi
  if want_run compact; then
    codex_wire compact
    codex_run compact "Read big.txt fully three times with three separate shell commands (cat big.txt), then run: wc -c big.txt, then reply DONE." --dangerously-bypass-approvals-and-sandbox -c model_auto_compact_token_limit=6000
    trigger codex PreCompact "run compact: -c model_auto_compact_token_limit=6000 and three full cats of a 120 KB file"
    trigger codex PostCompact "run compact: -c model_auto_compact_token_limit=6000 and three full cats of a 120 KB file"
    evidence codex PreCompact observe n/a "auto compaction: PreCompact fired $(meta_count codex PreCompact compact) times, PostCompact $(meta_count codex PostCompact compact) times (trigger: $(run_payloads codex PreCompact compact | jq -r '.trigger' | head -1))" compact
  fi
  if want_run interrupt; then
    codex_wire interrupt
    say "codex · interrupt (SIGINT while the model's shell command sleeps)"
    local t0 rc; t0="$(date +%s)"
    ( codex_env codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -C "$XPR" "Run the shell command: sleep 20. Then reply DONE." \
        < /dev/null > "$OUT/codex/runs/interrupt.stream.jsonl" 2> "$OUT/codex/runs/interrupt.stderr.txt" ) &
    local cpid=$! n=0
    while [ $n -lt 240 ] && ! grep -q '"command":"sleep 20' "$OUT/codex/PreToolUse.jsonl" 2>/dev/null; do sleep 0.5; n=$((n+1)); done
    sleep 2; pkill -INT -f "codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -C $XPR" 2>/dev/null
    wait $cpid; rc=$?
    record_run codex interrupt "$rc" "$(( $(date +%s) - t0 ))" "codex exec … (SIGINT sent to the process after PreToolUse of sleep 20)" "Run the shell command: sleep 20. Then reply DONE." "SIGINT mid-turn"
    note "rc=$rc · Interrupt fired: $(meta_count codex Interrupt interrupt)"
    trigger codex Interrupt "run interrupt: SIGINT to the codex exec process while its shell command sleeps"
    evidence codex Interrupt observe n/a "after SIGINT: Interrupt fired $(meta_count codex Interrupt interrupt), Stop fired $(meta_count codex Stop interrupt), SessionEnd fired $(meta_count codex SessionEnd interrupt)" interrupt
  fi
  local st port pid
  for st in 401 429 500 529; do
    want_run "fail-$st" || continue
    port=$((18900 + st % 1000)); pid="$(stub_start "$port" "$st" openai "$OUT/stubs/codex-$st.jsonl")"
    codex_wire "fail-$st"
    CODEX_ENV="PROBE_OPENAI_KEY=sk-probe" codex_run "fail-$st" "Reply OK" --dangerously-bypass-approvals-and-sandbox -c 'model_provider="probe"' -c 'model_providers.probe.name="probe"' -c "model_providers.probe.base_url=\"http://127.0.0.1:$port/v1\"" -c 'model_providers.probe.env_key="PROBE_OPENAI_KEY"' -c 'model_providers.probe.wire_api="responses"' -c model_providers.probe.request_max_retries=0 -c model_providers.probe.stream_max_retries=0
    stub_stop "$pid"
    trigger codex Stop "run fail-$st: a custom model provider whose base_url is a Python-stdlib stub answering HTTP $st (the turn fails; which hooks fire?)"
    evidence codex Stop "observe (API failure HTTP $st)" n/a "HTTP $st from the stub ($(count_lines "$OUT/stubs/codex-$st.jsonl") request(s): $(jq -r '.path' "$OUT/stubs/codex-$st.jsonl" 2>/dev/null | sed 's/?.*//' | sort | uniq -c | tr -s ' ' | tr '\n' ';')) → stream: $(jq -r '.type' "$OUT/codex/runs/fail-$st.stream.jsonl" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';'); hooks that fired: $(grep -l "\"run\":\"fail-$st\"" "$OUT"/codex/*.meta.jsonl 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/.meta.jsonl//' | tr '\n' ' '); error: $(codex_errors "fail-$st" | cut -c1-140)" "fail-$st"
  done
  if want_run exec-as-role; then
    local attempt i=0
    for attempt in 'agent_role="probe-reviewer"' 'agent_type="probe-reviewer"' 'role="probe-reviewer"' 'agents.probe-reviewer.config_file=".codex/agents/probe-reviewer.toml"'; do
      i=$((i+1)); codex_wire "exec-as-role-$i"
      ( codex_env timeout "$CODEX_TIMEOUT" codex exec --strict-config --json --skip-git-repo-check --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -C "$XPR" -c "$attempt" "Reply with exactly the role you were given, or NO_ROLE." \
          < /dev/null > "$OUT/codex/runs/exec-as-role-$i.stream.jsonl" 2> "$OUT/codex/runs/exec-as-role-$i.stderr.txt" ); rc=$?
      record_run codex "exec-as-role-$i" "$rc" 0 "codex exec --strict-config -c $attempt" "Reply with exactly the role you were given, or NO_ROLE." "can codex exec run AS a role?"
      evidence codex SubagentStart "codex exec -c $attempt" n/a "rc=$rc; reply: $(codex_last "exec-as-role-$i" | cut -c1-80); stderr: $(grep -v 'Reading additional\|bypass-hook-trust\|clamping' "$OUT/codex/runs/exec-as-role-$i.stderr.txt" | head -2 | tr '\n' ' ' | cut -c1-200)" "exec-as-role-$i"
      note "-c $attempt → rc=$rc: $(codex_last "exec-as-role-$i" | cut -c1-60) $(grep -v 'Reading additional\|bypass-hook-trust\|clamping' "$OUT/codex/runs/exec-as-role-$i.stderr.txt" | head -1 | cut -c1-120)"
    done
    cp "$XPR/.codex/agents/probe-reviewer.toml" "$CH/probe-reviewer.config.toml"
    codex_wire exec-as-role-profile
    ( codex_env timeout "$CODEX_TIMEOUT" codex exec --strict-config --json --skip-git-repo-check --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -C "$XPR" -p probe-reviewer "Reply with exactly the role you were given, or NO_ROLE." \
        < /dev/null > "$OUT/codex/runs/exec-as-role-profile.stream.jsonl" 2> "$OUT/codex/runs/exec-as-role-profile.stderr.txt" ); rc=$?
    record_run codex exec-as-role-profile "$rc" 0 "codex exec --strict-config -p probe-reviewer (the role file copied as CODEX_HOME/probe-reviewer.config.toml)" "Reply with exactly the role you were given, or NO_ROLE." "a role file as a --profile layer"
    evidence codex SubagentStart "codex exec -p <role file as profile>" n/a "rc=$rc; stderr: $(grep -v 'Reading additional\|bypass-hook-trust\|clamping' "$OUT/codex/runs/exec-as-role-profile.stderr.txt" | head -2 | tr '\n' ' ' | cut -c1-200)" exec-as-role-profile
    rm -f "$CH/probe-reviewer.config.toml"
  fi
  if want_run strict-config; then
    codex_wire strict-config
    codex_run strict-config "Reply OK" --dangerously-bypass-approvals-and-sandbox --strict-config
    evidence codex SessionStart "--strict-config with the probe's hook block" n/a "rc=$(jq -r '.runs[] | select(.name=="strict-config") | .rc' "$MANIFEST" | tail -1); the hook wiring the shared writer emits passes --strict-config: $( [ "$(meta_count codex SessionStart strict-config)" -ge 1 ] && echo yes || echo no )" strict-config
  fi
  rm -f "$CH/auth.json"
}

# ---- go -------------------------------------------------------------------------------
[ "$WANT_CLAUDE" = 1 ] && claude_all
[ "$WANT_CODEX" = 1 ] && codex_all

# ---- hermeticity ------------------------------------------------------------------------
FP_CODEX_AFTER="$(real_codex_fingerprint)"; FP_CLAUDE_AFTER="$(real_claude_fingerprint)"
real_home_names "$HOME/.codex"  > "$OUT/fingerprints/codex.after.txt"
real_home_names "$HOME/.claude" > "$OUT/fingerprints/claude.after.txt"
# The name-level diff (+added / -removed), empty when nothing changed.
fp_diff() { diff "$OUT/fingerprints/$1.before.txt" "$OUT/fingerprints/$1.after.txt" | grep '^[<>]' | sed 's/^< /-/; s/^> /+/' | tr '\n' ' '; }
manifest_update '.fingerprints.claude_after=$fc | .fingerprints.codex_after=$fx | .fingerprints.claude_diff=$dc | .fingerprints.codex_diff=$dx | .fingerprints.excluded="*.sqlite-wal *.sqlite-shm *.sqlite-journal" | .finished_at=$at' \
  --arg fc "$FP_CLAUDE_AFTER" --arg fx "$FP_CODEX_AFTER" --arg dc "$(fp_diff claude)" --arg dx "$(fp_diff codex)" --arg at "$(now)"
say "hermeticity"
HERMETIC=1
if [ "$FP_CLAUDE_AFTER" = "$FP_CLAUDE_BEFORE" ]; then note "ok   the real ~/.claude gained no new entries"; else note "FAIL the real ~/.claude changed: $(fp_diff claude)"; HERMETIC=0; fi
if [ "$FP_CODEX_AFTER" = "$FP_CODEX_BEFORE" ]; then note "ok   the real ~/.codex gained no new entries"; else note "FAIL the real ~/.codex changed: $(fp_diff codex)"; HERMETIC=0; fi

# ---- coverage summary -------------------------------------------------------------------
say "coverage"
for h in claude codex; do
  [ "$h" = claude ] && [ "$WANT_CLAUDE" != 1 ] && continue
  [ "$h" = codex ]  && [ "$WANT_CODEX"  != 1 ] && continue
  evs="$CLAUDE_EVENTS"; [ "$h" = codex ] && evs="$CODEX_EVENTS"
  fired=0; total=0
  for ev in $evs; do
    total=$((total+1)); n="$(count_lines "$OUT/$h/$ev.jsonl")"
    if [ "$n" -gt 0 ]; then fired=$((fired+1)); printf '    %-8s %-22s fired ×%s\n' "$h" "$ev" "$n"; else printf '    %-8s %-22s not fired — %s\n' "$h" "$ev" "$(jq -r --arg h "$h" --arg e "$ev" '(.triggers[$h][$e] // ["(no trigger recorded)"]) | join(" · ")' "$MANIFEST" | cut -c1-90)"; fi
  done
  note "$h: $fired/$total events captured"
done

# ---- render -----------------------------------------------------------------------------
if [ "$RENDER_DOCS" = 1 ] && [ -z "$ONLY" ] && [ "$HARNESS" = all ]; then
  say "render docs/reference/hook-events.md (+ .pt-BR.md)"
  python3 "$RENDER" "$OUT" --docs "$ROOT/docs/reference" || die "render failed"
elif [ "$RENDER_DOCS" = 1 ]; then
  note "partial run (--only / --harness): docs not rendered; use --render-only on a complete capture"
fi

[ "$HERMETIC" = 1 ] || die "the real harness homes changed during the probe"
say "done: $OUT"
