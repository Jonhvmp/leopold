#!/usr/bin/env bash
# Leopold PreToolUse guard: keeps git commit and git push locked while a Leopold
# autonomous run is active. That is the ENTIRE scope — the run stages work and the
# human commits/pushes. Nothing else is blocked; the worker is free to run, edit,
# delete, refactor and spawn as it sees fit. It never loosens Claude Code's own
# permission system; it only adds the two git denials.
#
# Hook contract (Claude Code PreToolUse): read JSON on stdin. To block, print a
# hookSpecificOutput object with permissionDecision "deny" and exit 0. To allow,
# exit 0 with no output.
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

# git commit/push are the only guarded tools, so anything but Bash is allowed.
[ "$tool" = "Bash" ] || exit 0

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

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
# normalize: newlines/tabs -> space, collapse runs (defeats whitespace/tab evasion).
norm="$(printf '%s' "$cmd" | tr '\n\t' '  ' | tr -s ' ')"

# --- git commit / push, by resolved subcommand (bypass-resistant) -----------
case "$(git_subcmd "$norm")" in
  push)
    matches "$norm" '(--force|--force-with-lease|(^|[[:space:]])-f([[:space:]]|$))' && \
      deny "Leopold guard: force-push is forbidden in autonomous mode."
    has_token ALLOW_PUSH || \
      deny "Leopold guard: git push is locked. Pushing is the user's call; report readiness instead. To allow this run: touch .leopold/ALLOW_PUSH" ;;
  commit)
    has_token ALLOW_GIT || \
      deny "Leopold guard: git commit is locked. Stage the work (git add) and report instead. To allow this run: touch .leopold/ALLOW_GIT" ;;
esac

exit 0
