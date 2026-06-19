#!/usr/bin/env bash
# Leopold PreToolUse guard: keeps irreversible / outbound actions locked while a
# Leopold autonomous run is active. This is defense-in-depth on top of Claude
# Code's own permission system. It never loosens anything; it only adds denials.
#
# Hook contract (Claude Code PreToolUse): read JSON on stdin. To block, print a
# hookSpecificOutput object with permissionDecision "deny" and exit 0. To allow,
# exit 0 with no output. Detection is intentionally over-broad: when in doubt it
# blocks, because a blocked-but-safe op just means the human runs it.
#
# Each denial below has a matching case in scripts/test-guard.sh (red-team suite).

input="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0   # cannot parse safely -> defer to CC perms

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -z "${cwd:-}" ] && cwd="$PWD"
LEO="$cwd/.leopold"
STATE="$LEO/state.json"

# Only guard during an active autonomous run.
[ -f "$STATE" ] || exit 0
# Fail CLOSED on a malformed state.json: if the file exists but does not parse,
# we cannot prove the run is inactive, so we keep guarding (and say so).
if ! jq -e . "$STATE" >/dev/null 2>&1; then
  active="true"
else
  active="$(jq -r '.active // false' "$STATE" 2>/dev/null || echo true)"
fi
[ "$active" = "true" ] || exit 0

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"

deny() {
  local r="$1" ts
  jq -cn --arg r "$r" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
  printf '{"ts":"%s","event":"guard_block","tool":"%s"}\n' "$ts" "$tool" >> "$LEO/events.jsonl" 2>/dev/null || true
  exit 0
}

has_token() { [ -f "$LEO/$1" ]; }
matches()   { printf '%s' "$1" | grep -qiE -- "$2"; }   # $1 text, $2 ERE (case-insensitive)

# Resolve the git subcommand, skipping leading global options AND their values
# (-c k=v, -C path, --git-dir, --work-tree, --namespace, --exec-path, --config-env).
# This is what closes the `git -c user.name=x commit` / `git -C /r commit` bypass.
git_subcmd() {  # $1 = normalized command -> echoes the subcommand (or empty)
  local toks=() i n t want=0
  read -ra toks <<< "$1"
  n=${#toks[@]}; i=0
  # match 'git', '/usr/bin/git', './git', 'env git' ... by basename
  while [ "$i" -lt "$n" ] && [ "${toks[$i]##*/}" != "git" ]; do i=$((i+1)); done
  i=$((i+1))
  while [ "$i" -lt "$n" ]; do
    t="${toks[$i]}"
    if [ "$want" -eq 1 ]; then want=0; i=$((i+1)); continue; fi
    case "$t" in
      -c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env) want=1 ;;
      --*=*|-*) : ;;          # self-contained option, skip
      *) printf '%s' "$t"; return ;;
    esac
    i=$((i+1))
  done
}

case "$tool" in
  Task|Agent)
    # Subagent budget. Fanning out into many subagents is the single biggest cost
    # multiplier in an autonomous run: each subagent loads the parent session's
    # (often multi-MB) context, and the model will happily spawn them in bursts of
    # 10+. Cap the TOTAL per run (default 8) and deny past it — the run then keeps
    # going serially instead of exploding. Raise max_subagents in GUARDRAILS.md for
    # runs that genuinely need more. Counter lives in state.json (best-effort).
    max_sub="$(jq -r '.max_subagents // 8' "$STATE" 2>/dev/null || echo 8)"
    case "$max_sub" in (*[!0-9]*|"") max_sub=8 ;; esac
    spawned="$(jq -r '.subagents_spawned // 0' "$STATE" 2>/dev/null || echo 0)"
    case "$spawned" in (*[!0-9]*|"") spawned=0 ;; esac
    if [ "$spawned" -ge "$max_sub" ] 2>/dev/null; then
      deny "Leopold guard: subagent budget exhausted ($spawned/$max_sub this run). Spawning many subagents multiplies cost — each one re-loads the full session context. Do this task yourself in-turn (work serially). To allow more, raise max_subagents in GUARDRAILS.md and restart the run."
    fi
    gtmp="$(mktemp 2>/dev/null || echo "$STATE.gtmp")"
    jq --argjson s "$((spawned+1))" '.subagents_spawned=$s' "$STATE" > "$gtmp" 2>/dev/null && mv "$gtmp" "$STATE" || rm -f "$gtmp" 2>/dev/null
    ;;

  Bash)
    cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
    # normalize: newlines/tabs -> space, collapse runs (defeats whitespace/tab evasion).
    norm="$(printf '%s' "$cmd" | tr '\n\t' '  ' | tr -s ' ')"

    # Opt-in deny-by-default (LEOPOLD_PARANOID=1): only a small allowlist of
    # read/build/test/lint commands passes; everything else is denied. Best-effort
    # (it keys off the first command word), kept off by default in favor of the
    # hardened denylist below. Documented in docs/guardrails.md.
    if [ "${LEOPOLD_PARANOID:-0}" = "1" ]; then
      first="$(printf '%s' "$norm" | awk '{print $1}')"; base="${first##*/}"; ok=0
      case "$base" in
        ls|cat|head|tail|wc|grep|rg|awk|sed|find|file|stat|tree|pwd|cd|echo|printf|true|jq|make|node|npx|tsc|mkdir|cp|touch|test|diff|cmp) ok=1 ;;
        git) case "$(git_subcmd "$norm")" in add|status|diff|log|show|rev-parse|branch|fetch|remote|config) ok=1 ;; esac ;;
        npm|pnpm|yarn) matches "$norm" '[[:space:]](run|test|ci|pack|install|build|typecheck|lint)([[:space:]]|$)' && ok=1 ;;
      esac
      [ "$ok" = 1 ] || deny "Leopold PARANOID: '$base' is not on the allowlist (read/build/test/lint/git add). Unset LEOPOLD_PARANOID to use the default denylist."
    fi

    # --- destructive deletes (rm recursive+force, in any spelling) ----------
    if matches "$norm" '(^|[^[:alnum:]_-])rm([[:space:]]|$)'; then
      rec=0; force=0
      matches "$norm" '(--recursive|(^|[[:space:]])-[a-z]*r)' && rec=1
      matches "$norm" '(--force|(^|[[:space:]])-[a-z]*f)'     && force=1
      [ "$rec" = 1 ] && [ "$force" = 1 ] && \
        deny "Leopold guard: recursive+forced rm is forbidden in autonomous mode (any spelling). Stop and let the human run it."
    fi
    # find-based deletion
    if matches "$norm" '(^|[^[:alnum:]_-])find([[:space:]]|$)'; then
      matches "$norm" '[[:space:]]-delete([[:space:]]|$)' && \
        deny "Leopold guard: 'find ... -delete' is forbidden in autonomous mode."
      matches "$norm" '-exec[[:space:]]+rm([[:space:]]|$)' && \
        deny "Leopold guard: 'find ... -exec rm' is forbidden in autonomous mode."
    fi

    # --- git, by resolved subcommand (bypass-resistant) ---------------------
    gsub="$(git_subcmd "$norm")"
    case "$gsub" in
      reset)  matches "$norm" '(^|[[:space:]])--hard([[:space:]]|$)' && \
                deny "Leopold guard: 'git reset --hard' is forbidden in autonomous mode." ;;
      clean)  matches "$norm" '(--force|(^|[[:space:]])-[a-z]*f)' && \
                deny "Leopold guard: 'git clean -f' is forbidden in autonomous mode." ;;
      branch) matches "$norm" '(^|[[:space:]])-D([[:space:]]|$)' && \
                deny "Leopold guard: 'git branch -D' is forbidden in autonomous mode." ;;
      push)
        matches "$norm" '(--force|--force-with-lease|(^|[[:space:]])-f([[:space:]]|$))' && \
          deny "Leopold guard: force-push is forbidden in autonomous mode."
        has_token ALLOW_PUSH || \
          deny "Leopold guard: git push is locked. Pushing is the user's call; report readiness instead." ;;
      commit)
        has_token ALLOW_GIT || \
          deny "Leopold guard: git commit is locked. Stage the work (git add) and report instead. To allow this session: touch .leopold/ALLOW_GIT" ;;
    esac

    # --- outbound: PRs / releases / publishing ------------------------------
    if matches "$norm" '(^|[^[:alnum:]_-])gh([[:space:]].*)?(pr[[:space:]]+(create|merge)|release[[:space:]]+create)'; then
      has_token ALLOW_PUSH || \
        deny "Leopold guard: opening/merging PRs and creating releases is locked. Report readiness instead."
    fi
    if matches "$norm" '(npm|pnpm|yarn)[[:space:]]+publish|cargo[[:space:]]+publish|twine[[:space:]]+upload|pip[[:space:]].*upload'; then
      has_token ALLOW_PUBLISH || \
        deny "Leopold guard: publishing packages is locked in autonomous mode."
    fi
    ;;

  Edit|Write|MultiEdit|NotebookEdit)
    path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)"
    case "$path" in
      */GUARDRAILS.md)             deny "Leopold guard: GUARDRAILS.md is immutable during an autonomous run." ;;
      */settings.json|*/settings.local.json) deny "Leopold guard: editing Claude Code settings is forbidden in autonomous mode." ;;
      */leopold/hooks/*|*/.leopold/state.json) deny "Leopold guard: the guardrail hooks and run state are immutable during an autonomous run." ;;
    esac
    ;;
esac

exit 0
