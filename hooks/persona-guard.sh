#!/usr/bin/env bash
# Leopold PreToolUse persona guard: while a persona run is active, navigation is
# bounded to the active flow's domain allowlist — in code, not in prose. The
# conductor wires this hook (extensions/lib/harness.sh, leo_wire_persona_guard)
# only for the duration of a persona run and unwires it after; on top of that,
# the hook itself is inert unless `.leopold/persona/ACTIVE.json` names an active
# flow, so a stale wire left by a crashed conductor can never bound a normal
# session. It never loosens the harness's own permissions; it only adds denials.
#
# Scope: MCP tool calls (tool names `mcp__<server>__<tool>` on both harnesses —
# verified live, docs/reference/persona-guard-hooks.md) plus WebFetch. Every
# string under a `url` key in tool_input must parse as http(s) and land on an
# allowlisted host (exact or dot-boundary subdomain, same semantics as
# `hostAllowed` in packages/driver/src/persona-testing/flow.ts). Anything else
# is denied with a reason that names the flow. Unknown is outside: a malformed
# ACTIVE.json, an unreadable flow, an empty allowlist, an unparseable URL all
# fail CLOSED. The out-of-bounds rule (payments, deletions) is semantic and
# stays with the conductor — a hook cannot judge intent.
#
# Hook contract (PreToolUse, identical on Claude Code and Codex CLI): read JSON
# on stdin. To block, print a hookSpecificOutput object with permissionDecision
# "deny" and exit 0. To allow, exit 0 with no output.
#
# Each denial below has a matching case in scripts/test-persona-guard.sh.

input="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0   # cannot parse safely -> defer to harness perms

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -z "${cwd:-}" ] && cwd="$PWD"
PLEO="$cwd/.leopold/persona"
ACTIVE="$PLEO/ACTIVE.json"

# Only guard during an active persona run.
[ -f "$ACTIVE" ] || exit 0

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"

# Navigation lives in MCP browser tools and WebFetch; everything else is not
# this guard's business (the git lock is guard-irreversible.sh, untouched).
case "$tool" in
  mcp__*|WebFetch) : ;;
  *) exit 0 ;;
esac

deny() {
  local r="$1" host="${2:-}" flow="${3:-}" ts
  jq -cn --arg r "$r" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
  jq -cn --arg ts "$ts" --arg tool "$tool" --arg host "$host" --arg flow "$flow" \
    '{ts:$ts,event:"persona_guard_block",tool:$tool,host:$host,flow:$flow}' >> "$PLEO/events.jsonl" 2>/dev/null || true
  exit 0
}

# Fail CLOSED on a malformed ACTIVE.json: we cannot prove the run's bounds, so
# navigation stays denied until the file is fixed or removed.
if ! jq -e 'type=="object"' "$ACTIVE" >/dev/null 2>&1; then
  deny "Leopold persona guard: .leopold/persona/ACTIVE.json does not parse, so the active flow's bounds cannot be proven — navigation denied (fail closed). Fix or remove ACTIVE.json."
fi
# Presence of ACTIVE.json means active; an explicit `"active": false` disables.
# Spelled as a comparison because jq's `//` treats false itself as falsy.
[ "$(jq -r 'if .active == false then "off" else "on" end' "$ACTIVE" 2>/dev/null)" = "off" ] && exit 0

flow_rel="$(jq -r '.flow // empty' "$ACTIVE" 2>/dev/null || true)"
case "$flow_rel" in
  "") deny "Leopold persona guard: ACTIVE.json names no flow file, so the domain allowlist cannot be read — navigation denied (fail closed)." ;;
  /*) FLOWF="$flow_rel" ;;
  *)  FLOWF="$PLEO/$flow_rel" ;;
esac

# The flow's display name: the `# Flow — <name>` title, else the file's basename
# (same resolution as parseFlow in packages/driver/src/persona-testing/flow.ts).
flow_name=""
if [ -f "$FLOWF" ]; then
  flow_name="$(sed -n 's/^#[[:space:]]\{1,\}\(.*\)$/\1/p' "$FLOWF" 2>/dev/null | head -1)"
  flow_name="$(printf '%s' "$flow_name" | sed -E 's/^[Ff][Ll][Oo][Ww][[:space:]]*(—|–|-)[[:space:]]*//' | sed -E 's/[[:space:]]+$//')"
fi
[ -z "$flow_name" ] && flow_name="$(basename "$FLOWF" .md)"

# The allowlist: `- host` items of the FIRST `## Domain allowlist` section
# (prefix-matched heading, so "Domain allowlist (hard boundary)" counts — the
# same lexical rules as the flow parser). One host per line on stdout.
read_allowlist() {
  [ -f "$FLOWF" ] || return 0
  awk '
    /^##[ \t]+/ {
      if (insec) exit
      hl = tolower($0); sub(/^##[ \t]+/, "", hl)
      if (index(hl, "domain allowlist") == 1) insec = 1
      next
    }
    insec && /^[ \t]*[-*][ \t]+/ {
      line = $0
      sub(/^[ \t]*[-*][ \t]+/, "", line); sub(/[ \t]+$/, "", line)
      if (line != "") print line
    }
  ' "$FLOWF" 2>/dev/null
}

allow_json="$(read_allowlist | jq -R . 2>/dev/null | jq -sc . 2>/dev/null)"
[ -z "$allow_json" ] && allow_json="[]"
if [ "$allow_json" = "[]" ]; then
  deny "Leopold persona guard: the active flow \"$flow_name\" ($FLOWF) has no readable Domain allowlist — navigation denied (fail closed)." "" "$flow_name"
fi

# Judge every `url`-keyed string in tool_input against the allowlist, with the
# exact semantics of flow.ts hostAllowed(): http(s) only, hostname lowercased,
# trailing dots stripped, exact host or dot-boundary subdomain — NEVER a
# substring — and an unparseable URL is outside. The authority ends at '/',
# '\', '?' or '#', exactly as WHATWG URL parsers (Chromium, Node — the real
# browser stack) treat it: in `https://evil.io\@staging.example.com/` the `\`
# terminates the host at `evil.io` and the rest is path, so the userinfo trick
# in reverse cannot smuggle an allowlisted name past the guard. IPv6 literals
# and plain userinfo tricks fall out of the same rules (`[::1]` and `evil.io`
# simply never match a flow hostname). One pass, one verdict line: "ok",
# "outside <host>", or "unparseable" (an offender jq could not extract a host
# from). jq failing on a crafted payload is itself a verdict: unknown is
# outside.
verdict="$(printf '%s' "$input" | jq -r --argjson allow "$allow_json" '
  def hostof:
    (ascii_downcase) as $u
    | if (($u | startswith("http://")) or ($u | startswith("https://"))) | not then null
      else ($u | split("://")[1:] | join("://")
            | split("/")[0] | split("\\")[0] | split("?")[0] | split("#")[0]
            | split("@") | last
            | split(":")[0]
            | until(endswith(".") | not; .[:length-1]))
      end;
  def allowed($h):
    ($allow | map(ascii_downcase | until(endswith(".") | not; .[:length-1])) | map(select(. != ""))) as $a
    | any($a[]; . as $e | ($h == $e) or ($h | endswith("." + $e)));
  [ .tool_input // {} | .. | objects | .url? // empty | strings ]
  | [ .[] | (hostof) as $h | select(($h == null) or ($h == "") or (allowed($h) | not)) | ($h // "") ]
  | if length == 0 then "ok"
    elif .[0] == "" then "unparseable"
    else "outside " + .[0]
    end
' 2>/dev/null || echo unparseable)"

case "$verdict" in
  ok) : ;;
  outside\ *)
    bad_host="${verdict#outside }"
    deny "Leopold persona guard: navigation to host \"$bad_host\" is outside the domain allowlist of flow \"$flow_name\" — the persona stays inside the flow's bounds; journal the wall as a finding instead of retrying." "$bad_host" "$flow_name" ;;
  *)
    deny "Leopold persona guard: a tool_input url does not parse as an http(s) URL, which is outside the domain allowlist of flow \"$flow_name\" (fail closed)." "" "$flow_name" ;;
esac

exit 0
