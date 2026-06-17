#!/usr/bin/env bash
# Leopold PreToolUse guard: keeps irreversible / outbound actions locked while a
# Leopold autonomous run is active. This is defense-in-depth on top of Claude
# Code's own permission system. It never loosens anything; it only adds denials.
#
# Hook contract (Claude Code PreToolUse): read JSON on stdin. To block, print a
# hookSpecificOutput object with permissionDecision "deny" and exit 0. To allow,
# exit 0 with no output. Pattern matching is best-effort and complements, never
# replaces, Claude Code's permission prompts.

input="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0   # cannot parse safely -> defer to CC perms

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -z "${cwd:-}" ] && cwd="$PWD"
LEO="$cwd/.leopold"
STATE="$LEO/state.json"

# Only guard during an active autonomous run. Interactive sessions keep Claude
# Code's normal prompts.
[ -f "$STATE" ] || exit 0
active="$(jq -r '.active // false' "$STATE" 2>/dev/null || echo false)"
[ "$active" = "true" ] || exit 0

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"

deny() {
  local r="$1" ts
  jq -cn --arg r "$r" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","event":"guard_block","tool":"%s"}\n' "$ts" "$tool" >> "$LEO/events.jsonl" 2>/dev/null || true
  exit 0
}

has_token() { [ -f "$LEO/$1" ]; }

case "$tool" in
  Bash)
    cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
    norm="$(printf '%s' "$cmd" | tr '\n' ' ')"

    # Always-forbidden destructive ops.
    if printf '%s' "$norm" | grep -qiE 'rm[[:space:]]+-[a-z]*(rf|fr)'; then
      deny "Leopold guard: 'rm -rf' style deletion is forbidden in autonomous mode. Stop and let the human run it."
    fi
    if printf '%s' "$norm" | grep -qE 'git[[:space:]]+(reset[[:space:]]+--hard|clean[[:space:]]+-[a-zA-Z]*f|branch[[:space:]]+-D)'; then
      deny "Leopold guard: destructive git op (reset --hard / clean -f / branch -D) is forbidden in autonomous mode."
    fi
    if printf '%s' "$norm" | grep -qE 'git[[:space:]]+push[[:space:]]+.*(--force|--force-with-lease|-f([[:space:]]|$))'; then
      deny "Leopold guard: force-push is forbidden in autonomous mode."
    fi

    # Gated: commit (needs .leopold/ALLOW_GIT).
    if printf '%s' "$norm" | grep -qE 'git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*commit'; then
      has_token ALLOW_GIT || deny "Leopold guard: git commit is locked. The user must approve commits. Stage the work (git add) and report instead. To allow commits this session: touch .leopold/ALLOW_GIT"
    fi
    # Gated: push (needs .leopold/ALLOW_PUSH, off by default).
    if printf '%s' "$norm" | grep -qE 'git[[:space:]]+push'; then
      has_token ALLOW_PUSH || deny "Leopold guard: git push is locked. Pushing is the user's call; report readiness instead."
    fi
    # Gated: PRs and releases.
    if printf '%s' "$norm" | grep -qE 'gh[[:space:]]+(pr[[:space:]]+(create|merge)|release[[:space:]]+create)'; then
      has_token ALLOW_PUSH || deny "Leopold guard: opening or merging PRs and creating releases is locked. Report readiness instead."
    fi
    # Gated: publishing packages.
    if printf '%s' "$norm" | grep -qE '(npm|pnpm|yarn)[[:space:]]+publish|cargo[[:space:]]+publish|twine[[:space:]]+upload|pip[[:space:]].*upload'; then
      has_token ALLOW_PUBLISH || deny "Leopold guard: publishing packages is locked in autonomous mode."
    fi
    ;;
  Edit|Write|MultiEdit|NotebookEdit)
    path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)"
    case "$path" in
      */GUARDRAILS.md)
        deny "Leopold guard: GUARDRAILS.md is immutable during an autonomous run." ;;
      */settings.json|*/settings.local.json)
        deny "Leopold guard: editing Claude Code settings is forbidden in autonomous mode." ;;
      */leopold/hooks/*)
        deny "Leopold guard: the guardrail hooks are immutable during an autonomous run." ;;
    esac
    ;;
esac

exit 0
