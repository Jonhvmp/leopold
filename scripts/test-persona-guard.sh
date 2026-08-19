#!/usr/bin/env bash
# Red-team suite for the Leopold persona guard (hooks/persona-guard.sh).
# Every bypass attempt is a test: feed a crafted PreToolUse payload from a
# stubbed persona run, assert deny / allow — hermetically, no harness, no
# network, no browser. This is the hook-level half of the persona bounds; the
# conductor's journal-side enforcement has its own tests in packages/driver.
# Run: make persona-test   (or: bash scripts/test-persona-guard.sh)
set -u

GUARD="$(cd "$(dirname "$0")/.." && pwd)/hooks/persona-guard.sh"
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PLEO="$TMP/.leopold/persona"
mkdir -p "$PLEO/flows"

# The stubbed persona run: an active flow whose allowlist is the hard boundary.
cat > "$PLEO/flows/checkout.md" <<'EOF'
# Flow — checkout

## Entry point

https://staging.example.com/welcome

## Goal

Subscribe to the Pro plan.

## Success criteria

The dashboard shows the active subscription.

## Domain allowlist (hard boundary)

- staging.example.com
- accounts.example.com

## Out of bounds

- payments

## App version pin

v1.2.3
EOF
active() { printf '%s\n' "$1" > "$PLEO/ACTIVE.json"; }
active '{"active":true,"flow":"flows/checkout.md"}'

pass=0; fail=0
run_url()  { jq -cn --arg t "$1" --arg u "$2" --arg cwd "$TMP" '{tool_name:$t,cwd:$cwd,tool_input:{url:$u}}' | bash "$GUARD" 2>/dev/null; }
run_raw()  { printf '%s' "$1" | bash "$GUARD" 2>/dev/null; }
is_deny()  { printf '%s' "$1" | grep -q '"permissionDecision":"deny"'; }

ck_deny()  { if is_deny "$2"; then pass=$((pass+1)); else fail=$((fail+1)); printf '  \033[31mFAIL\033[0m want DENY : %s\n' "$1"; fi; }
ck_allow() { if [ -z "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf '  \033[31mFAIL\033[0m want ALLOW: %s\n' "$1"; fi; }

echo "== must DENY (navigation outside the flow's allowlist — incl. bypass attempts) =="
ck_deny 'off-allowlist host'                    "$(run_url mcp__browser__navigate 'https://prod.example.org/pricing')"
ck_deny 'lookalike host (substring is not suffix)' "$(run_url mcp__browser__navigate 'https://notstaging.example.com/')"
ck_deny 'allowlisted host as a subdomain of an attacker' "$(run_url mcp__browser__navigate 'https://staging.example.com.evil.io/')"
ck_deny 'userinfo trick (real host after @)'    "$(run_url mcp__browser__navigate 'https://staging.example.com@evil.io/')"
ck_deny 'backslash userinfo trick (WHATWG: \ ends the authority, real host is evil.io)' \
                                                "$(run_url mcp__browser__navigate 'https://evil.io\@staging.example.com/')"
ck_deny 'backslash inside userinfo (WHATWG host is "a")' \
                                                "$(run_url mcp__browser__navigate 'https://a\b@staging.example.com/')"
ck_deny 'non-http scheme'                       "$(run_url mcp__browser__navigate 'ftp://staging.example.com/')"
ck_deny 'unparseable url fails closed'          "$(run_url mcp__browser__navigate 'not a url')"
ck_deny 'empty url fails closed'                "$(run_url mcp__browser__navigate '')"
ck_deny 'ipv6 literal is never a flow hostname' "$(run_url mcp__browser__navigate 'https://[::1]:8080/')"
ck_deny 'nested url key (batch payloads)'       "$(run_raw "$(jq -cn --arg cwd "$TMP" '{tool_name:"mcp__browser__batch",cwd:$cwd,tool_input:{ops:[{kind:"nav",url:"https://prod.example.org/x"}]}}')")"
ck_deny 'one good + one bad url still denies'   "$(run_raw "$(jq -cn --arg cwd "$TMP" '{tool_name:"mcp__browser__batch",cwd:$cwd,tool_input:{a:{url:"https://staging.example.com/ok"},b:{url:"https://prod.example.org/x"}}}')")"
ck_deny 'WebFetch outside the allowlist'        "$(run_url WebFetch 'https://prod.example.org/doc')"
ck_deny 'any mcp server name is in scope'       "$(run_url mcp__claude-in-chrome__navigate 'https://prod.example.org/')"

echo "== must ALLOW (inside the allowlist, or not a navigation) =="
ck_allow 'allowlisted host'                     "$(run_url mcp__browser__navigate 'https://staging.example.com/welcome')"
ck_allow 'second allowlisted host'              "$(run_url mcp__browser__navigate 'https://accounts.example.com/login')"
ck_allow 'dot-boundary subdomain'               "$(run_url mcp__browser__navigate 'https://a.staging.example.com/')"
ck_allow 'explicit port'                        "$(run_url mcp__browser__navigate 'https://staging.example.com:8443/x')"
ck_allow 'trailing-dot host'                    "$(run_url mcp__browser__navigate 'https://staging.example.com./x')"
ck_allow 'case-insensitive host + scheme'       "$(run_url mcp__browser__navigate 'HTTPS://STAGING.EXAMPLE.COM/X')"
ck_allow 'backslash ends the authority (WHATWG: host IS staging.example.com, @evil.io is path)' \
                                                "$(run_url mcp__browser__navigate 'https://staging.example.com\@evil.io/')"
ck_allow 'mcp tool without a url key'           "$(run_raw "$(jq -cn --arg cwd "$TMP" '{tool_name:"mcp__browser__click",cwd:$cwd,tool_input:{label:"Buy"}}')")"
ck_allow 'Bash is not this guard'\''s business' "$(run_raw "$(jq -cn --arg cwd "$TMP" '{tool_name:"Bash",cwd:$cwd,tool_input:{command:"curl https://prod.example.org"}}')")"
ck_allow 'Edit is not this guard'\''s business' "$(run_raw "$(jq -cn --arg cwd "$TMP" '{tool_name:"Edit",cwd:$cwd,tool_input:{file_path:"x",old_string:"https://prod.example.org",new_string:"y"}}')")"

echo "== the deny reason names the flow =="
out="$(run_url mcp__browser__navigate 'https://prod.example.org/pricing')"
if printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' 2>/dev/null | grep -q 'flow "checkout"'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m deny reason must name flow "checkout": %s\n' "$out"
fi

echo "== the backslash trick's deny reason carries the WHATWG host (new URL parity) =="
out="$(run_url mcp__browser__navigate 'https://evil.io\@staging.example.com/')"
if printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' 2>/dev/null | grep -q 'host "evil.io"'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m deny reason must name evil.io (the host the browser would navigate to): %s\n' "$out"
fi

echo "== blocked events are journaled (host, never the full url) =="
if jq -e 'select(.event=="persona_guard_block" and .host=="prod.example.org" and .flow=="checkout")' \
     "$PLEO/events.jsonl" >/dev/null 2>&1; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m persona_guard_block event missing from events.jsonl\n'
fi
if grep -q '/pricing' "$PLEO/events.jsonl" 2>/dev/null; then
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m events.jsonl must carry the host only, never the full url\n'
else
  pass=$((pass+1))
fi

echo "== run state: inert without an active run, fail closed on broken state =="
rm -f "$PLEO/ACTIVE.json"
ck_allow 'no ACTIVE.json: guard is inert'       "$(run_url mcp__browser__navigate 'https://prod.example.org/x')"
active 'not valid json {'
ck_deny  'malformed ACTIVE.json fails CLOSED'   "$(run_url mcp__browser__navigate 'https://staging.example.com/')"
active '{"active":false,"flow":"flows/checkout.md"}'
ck_allow 'explicit active:false: guard is inert' "$(run_url mcp__browser__navigate 'https://prod.example.org/x')"
active '{"active":true}'
ck_deny  'ACTIVE.json without a flow fails CLOSED' "$(run_url mcp__browser__navigate 'https://staging.example.com/')"
active '{"active":true,"flow":"flows/missing.md"}'
ck_deny  'missing flow file fails CLOSED'       "$(run_url mcp__browser__navigate 'https://staging.example.com/')"
printf '# Flow — empty\n\n## Domain allowlist\n\nprose but no items\n' > "$PLEO/flows/empty.md"
active '{"active":true,"flow":"flows/empty.md"}'
ck_deny  'flow without allowlist items fails CLOSED' "$(run_url mcp__browser__navigate 'https://staging.example.com/')"

echo "== doctor states the bound actually in force, per harness (hermetic homes) =="
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$TMP/doctor"; mkdir -p "$DOC/claude/skills" "$DOC/codex/skills" "$DOC/proj"
for s in leopold-persona persona-contract-builder persona-contract-runtime; do
  mkdir -p "$DOC/claude/skills/$s" "$DOC/codex/skills/$s"
  : > "$DOC/claude/skills/$s/SKILL.md"; : > "$DOC/codex/skills/$s/SKILL.md"
done
doctor() { ( cd "$DOC/proj" && CLAUDE_HOME="$DOC/claude" CODEX_HOME="$DOC/codex" \
             LEOPOLD_HOME="$DOC/leo" LEOPOLD_SRC="$DOC/no-src" bash "$ROOT/scripts/leopold-doctor.sh" 2>/dev/null ); }
out="$(doctor)"
if printf '%s' "$out" | grep -q 'persona: Claude Code skills present (3/3) — navigation bound: conductor-level enforcement'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor (unwired, claude) must name conductor-level enforcement as the bound\n'
fi
if printf '%s' "$out" | grep -q 'persona: Codex skills present (3/3) — navigation bound: conductor-level enforcement'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor (unwired, codex) must name conductor-level enforcement as the bound\n'
fi
# Wire the guard the way the conductor does, and the same line must flip.
printf '{"hooks":{"PreToolUse":[{"matcher":"mcp__.*","hooks":[{"type":"command","command":"bash /x/persona-guard.sh","timeout":5}]}]}}\n' > "$DOC/claude/settings.json"
out="$(doctor)"
if printf '%s' "$out" | grep -q 'persona: Claude Code skills present (3/3) — navigation bound: persona-guard hook wired'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor (wired, claude) must name the persona-guard hook as the bound\n'
fi
if printf '%s' "$out" | grep -q 'persona: Codex skills present (3/3) — navigation bound: conductor-level enforcement'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor must keep the per-harness answer independent (codex stays conductor-level)\n'
fi
# The wire alone proves NO active run: a crashed conductor leaves the wire behind
# after ACTIVE.json is gone, and the hook is inert without the arming file. A
# doctor line claiming "run active" from wire presence would be that silent lie.
if printf '%s' "$out" | grep -q 'run active'; then
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor (wired, no ACTIVE.json) must not claim an active run\n'
else
  pass=$((pass+1))
fi
if printf '%s' "$out" | grep -q 'persona-guard hook wired but NO \.leopold/persona/ACTIVE\.json'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor (wired, no ACTIVE.json) must say the hook is inert in this project\n'
fi
# Arm the project too, and the same line must now state the active run.
mkdir -p "$DOC/proj/.leopold/persona"
printf '{"active":true,"flow":"flows/checkout.md"}\n' > "$DOC/proj/.leopold/persona/ACTIVE.json"
out="$(doctor)"
if printf '%s' "$out" | grep -q 'persona-guard hook wired + run active here (\.leopold/persona/ACTIVE\.json)'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor (wired + ACTIVE.json) must state the active run\n'
fi
rm -f "$DOC/proj/.leopold/persona/ACTIVE.json"

echo "== doctor persona inventory + browser capability (hermetic homes) =="
# An unused module is a normal answer, never an error: .leopold exists, no
# contracts, no flows -> the "no contracts yet" line, exit code untouched by it.
out="$(doctor)"
if printf '%s' "$out" | grep -q '\[ok\] *persona: no contracts yet in this project'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor (module unused) must say "no contracts yet" as [ok], never an error\n'
fi
# Browser capability is stated per harness from the live evidence — Claude
# headless-capable, Codex named honestly with its approval-layer asymmetry.
if printf '%s' "$out" | grep -q 'persona: Claude Code browser capability: MCP browser tools + WebFetch enact headless'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor must state Claude Code browser capability from the live evidence\n'
fi
if printf '%s' "$out" | grep -q 'persona: Codex browser capability: PreToolUse deny verified live, but headless MCP browsing is auto-cancelled'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor must state the Codex approval-layer asymmetry, not fake parity\n'
fi
# Contracts counted by status with the driver's lexical gate, flows counted.
mkdir -p "$DOC/proj/.leopold/persona/personas/casual" \
         "$DOC/proj/.leopold/persona/personas/skeptic" \
         "$DOC/proj/.leopold/persona/personas/rushed" \
         "$DOC/proj/.leopold/persona/flows"
printf 'schema_version: "persona-contract/1.0"\npersona_id: "casual"\ncontract_status: "ready"\n'  > "$DOC/proj/.leopold/persona/personas/casual/contract.yaml"
printf 'schema_version: "persona-contract/1.0"\npersona_id: "skeptic"\ncontract_status: draft\n'   > "$DOC/proj/.leopold/persona/personas/skeptic/contract.yaml"
printf 'schema_version: "persona-contract/1.0"\npersona_id: "rushed"\ncontract_status: "bogus"\n'  > "$DOC/proj/.leopold/persona/personas/rushed/contract.yaml"
printf '# Flow — checkout\n' > "$DOC/proj/.leopold/persona/flows/checkout.md"
out="$(doctor)"
if printf '%s' "$out" | grep -q 'persona: contracts 3 (1 ready · 1 draft · 0 blocked · 1 INVALID) · flows 1'; then
  pass=$((pass+1))
else
  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m doctor must count contracts by status and flows (got: %s)\n' \
    "$(printf '%s' "$out" | grep 'persona: contracts' || echo 'no line')"
fi
rm -rf "$DOC/proj/.leopold/persona/personas" "$DOC/proj/.leopold/persona/flows"

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mpersona-guard red-team: %d passed, 0 failed\033[0m\n' "$pass"
else
  printf '\033[31mpersona-guard red-team: %d passed, %d FAILED\033[0m\n' "$pass" "$fail"
fi
[ "$fail" -eq 0 ]
