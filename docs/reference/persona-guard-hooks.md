# Persona Guard Hooks — Live Verification

**The question:** a persona run's domain allowlist must be enforced, not requested.
The conductor checks every journaled action in code, but can the bound also live
*upstream of the tool call* — can a `PreToolUse` hook observe and deny browser/MCP
tool calls, with a matcher on MCP tool names, on Claude Code? And what does the
Codex CLI equivalent see? This page is the captured evidence from live runs on
both harnesses, and the policy those captures decided.

**The answer: both.** On Claude Code *and* Codex CLI, a `PreToolUse` hook with an
`mcp__.*` matcher fires for MCP tool calls, sees the full `tool_input` (the URL
included), and a `permissionDecision: "deny"` blocks the call **before the MCP
server ever receives it**. The persona guard is therefore wired on both harnesses
— `hook_bound=both`.

## Versions

| Component | Version |
| --- | --- |
| Claude Code CLI (`claude`) | 2.1.235 |
| Codex CLI (`codex`) | codex-cli 0.147.0 |
| Node.js | v22.22.0 |
| jq | 1.7.1 |
| Leopold | 0.20.x working tree (`hooks/persona-guard.sh`, `extensions/lib/harness.sh`) |
| Date | 2026-08-18 |

## Method (hermetic)

- A throwaway probe root under `mktemp -d` (`/tmp/leopold-persona-hookprobe.*`).
- A **stub MCP server** (`mcp-stub.js`, Node stdlib, newline-delimited JSON-RPC)
  exposing two browser-shaped tools, `navigate(url)` and `click(label)`. The stub
  appends every `tools/call` it actually *receives* to its own log — so a
  hook-level denial is provable by the call's **absence** from that log, not by
  reasoning.
- A probe hook that appends its full stdin payload verbatim to a marker log, and
  in deny mode answers with the standard
  `hookSpecificOutput.permissionDecision: "deny"` object.
- **Claude Code:** a temp `git init`-ed project; the hook wired in the project's
  own `.claude/settings.json` with matcher `mcp__personastub__.*`; the stub
  registered per run via `--mcp-config` + `--strict-mcp-config`; runs through
  `claude -p` (authenticated user config is only *read*, exactly like run 2 of
  [SDK Worker Hooks](sdk-worker-hooks.md)).
- **Codex CLI:** a temp `CODEX_HOME` holding `config.toml` (stub server + hook
  block) and a copy of the auth file, deleted after the runs; runs through
  `codex exec --json --skip-git-repo-check … --dangerously-bypass-hook-trust`
  with stdin closed.
- Finally, the **production stack**: the shipped `hooks/persona-guard.sh`, wired
  by the shipped writer (`leo_wire_persona_guard` in `extensions/lib/harness.sh`),
  a real flow file and `ACTIVE.json`, one live run per harness.

## Evidence — Claude Code

**Observe.** Matcher `mcp__personastub__.*`, hook logs and allows. The payload the
hook received on stdin, verbatim:

```
{"session_id":"7513b65a-e4e8-4381-85cf-6fd4b2879bdc","transcript_path":"…/7513b65a-….jsonl","cwd":"/tmp/leopold-persona-hookprobe.rC1NUS/project","prompt_id":"134124b4-…","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"mcp__personastub__navigate","tool_input":{"url":"https://staging.example.com/welcome"},"tool_use_id":"toolu_01K8JEdUY6diBv1TdY4Ces1Z"}
```

The stub's own log shows the allowed call arriving:
`{"ts":"2026-08-19T00:06:12.573Z","name":"navigate","args":{"url":"https://staging.example.com/welcome"}}`.

**Deny.** Same wiring in deny mode; the model was asked to navigate off-allowlist.
The hook fired with the full URL in `tool_input`, answered deny — and the stub log
gained **no new line**: the MCP server never received the call. The model's final
reply, verbatim:

```
BLOCKED persona guard (probe): navigation outside the domain allowlist of flow "checkout" — denied
```

## Evidence — Codex CLI

**Observe.** A matcherless `[[hooks.PreToolUse]]` block first, to see everything.
Codex fires the same event with the same keys and the **same `mcp__<server>__<tool>`
spelling**, plus its own extras (`turn_id`, `model`, `permission_mode`). Verbatim:

```
{"session_id":"01a0175d-536f-7780-a81c-ec4dc582b609","turn_id":"01a0175d-551f-…","transcript_path":"…/codex-home/sessions/2026/08/18/rollout-….jsonl","cwd":"…/codex-project","hook_event_name":"PreToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"mcp__personastub__navigate","tool_input":{"url":"https://staging.example.com/welcome"},"tool_use_id":"exec-a1428c1d-…"}
```

**Deny.** With the hook answering deny (and matcher `mcp__.*|WebFetch` in a second
run — Codex honors the same regex matcher syntax), the call was blocked before the
server; the stub log stayed empty and the model's final reply carried the reason:

```
BLOCKED Tool call blocked by PreToolUse hook: persona guard (probe): navigation outside the domain allowlist of flow "checkout" — denied. Tool: mcp__personastub__navigate
```

**Allow control.** Same wiring, hook silent: the call executed and the stub log
received it (`status":"completed"` in the `--json` stream). So the deny above was
the hook, not something else in the pipeline.

**The approval layer, found on the way (honest asymmetry):** in non-interactive
`codex exec`, MCP tool calls were **auto-cancelled by Codex's own approval
mechanic** — `"error":{"message":"user cancelled MCP tool call"}` — under
`--sandbox read-only`, `--sandbox workspace-write`, and even
`-c approval_policy=never`, with or without hooks. The only tested mode in which
an *allowed* MCP call actually executes headless is
`--dangerously-bypass-approvals-and-sandbox`. The hook fires and denies in every
one of those modes (it sits upstream), but a headless Codex persona worker that
needs to *browse* needs that flag — and, as already verified for the git lock,
config-declared hooks stay inert in headless runs without
`--dangerously-bypass-hook-trust`. Both facts belong to the Codex conduction
seam, and `leopold doctor` states which bound is in force rather than implying
a hook that is not wired.

## Evidence — the production stack, end to end

The shipped hook (`hooks/persona-guard.sh`) wired by the shipped writer
(`leo_wire_persona_guard`), a real `flows/checkout.md` whose allowlist is
`staging.example.com` + `accounts.example.com`, and a real
`.leopold/persona/ACTIVE.json`. One live run per harness, each asked to navigate
once inside and once outside the allowlist.

Claude Code final reply, verbatim:

```
OK
BLOCKED — Leopold persona guard: navigation to host "prod-dashboard.example.org" is outside the domain allowlist of flow "checkout"
```

Codex CLI final reply, verbatim:

```
OK
BLOCKED Tool call blocked by PreToolUse hook: Leopold persona guard: navigation to host "prod-dashboard.example.org" is outside the domain allowlist of flow "checkout" — the persona stays inside the flow's bounds; journal the wall as a finding instead of retrying.. Tool: mcp__personastub__navigate
```

On both harnesses the stub log carries **only** the allowed navigation, and the
project's `.leopold/persona/events.jsonl` carries one `persona_guard_block` event
per denial — host and flow, never the full URL:

```
{"ts":"2026-08-19T00:28:06Z","event":"persona_guard_block","tool":"mcp__personastub__navigate","host":"prod-dashboard.example.org","flow":"checkout"}
```

## Findings

1. **PreToolUse sees MCP tool calls on both harnesses**, as
   `tool_name: "mcp__<server>__<tool>"` with the full `tool_input`. A matcher on
   MCP tool names (`mcp__.*`) works on both — Codex reimplemented the same
   matcher semantics it already honors for `Bash`.
2. **Deny is enforced upstream of the server on both.** A denied call never
   reaches the MCP server (proven by the stub's receive log), and the model gets
   the `permissionDecisionReason` verbatim — on Codex prefixed with
   `Tool call blocked by PreToolUse hook:`.
3. **Codex's approval layer is a separate, additional gate** for MCP calls in
   headless `exec` runs (auto-cancel unless approvals are bypassed). It gates the
   *allow* path, never weakens the *deny* path.
4. **Hook processes see the session `cwd` in the payload** on both harnesses,
   which is what lets one project-relative guard (`.leopold/persona/ACTIVE.json`)
   scope itself without any per-run rewiring of the script.

## The policy this evidence decided

`hooks/persona-guard.sh` is the hook-level half of the persona bounds, wired on
**both** harnesses through the one shared writer:

- **Wired only while a persona run is active.** The conductor calls
  `leo_wire_persona_guard <path>` at run start and `leo_unwire_persona_guard` at
  run end (`extensions/lib/harness.sh` — its own managed tag,
  `leopold-persona-guard`, so wiring and unwiring never touch the git lock). On
  top of that, the hook no-ops unless `.leopold/persona/ACTIVE.json` exists and
  is active, so a stale wire left by a crashed conductor can never bound a
  normal session.
- **The allowlist is read from the active flow file** named by `ACTIVE.json`,
  with the exact semantics of the driver's flow parser (`hostAllowed` in
  `packages/driver/src/persona-testing/flow.ts`): http(s) only, hostname
  lowercased, trailing dots stripped, exact host or dot-boundary subdomain,
  never a substring. The authority ends at `/`, `\`, `?` or `#`, exactly as
  WHATWG URL parsers (Chromium, Node's `new URL` — the stack that actually
  navigates) treat it — so `https://evil.io\@staging.example.com/` is judged as
  host `evil.io` and denied, never as `staging.example.com` behind a fake
  userinfo.
- **Unknown is outside.** A malformed `ACTIVE.json`, a missing flow, an empty
  allowlist, an unparseable URL: all deny, each with a named reason. Denials name
  the flow and are journaled to `.leopold/persona/events.jsonl` as
  `persona_guard_block` — host only, never the full URL, so a credential-bearing
  URL can never land in recorded text.
- **Scope: the wired matcher is `mcp__.*|WebFetch`** — the same alternation the
  deny probe above ran with. It routes both navigation surfaces the script
  judges: the persona's MCP browser tools and the built-in `WebFetch` (same
  `url` shape). Everything semantic (payments, deletions — the irreversibility
  rule) remains the **conductor's** enforcement: a hook cannot judge intent.
  The hook is depth, the conductor is the bound.
- Every denial has a red-team case in `scripts/test-persona-guard.sh` (bypass
  attempts included: lookalike hosts, suffix tricks, userinfo tricks in both
  directions — backslash-authority forms included, judged by their WHATWG host —
  nested `url` keys, batch payloads), the wire/unwire pair is asserted
  idempotent in `scripts/test-harness-lib.sh`, and `leopold doctor` names the
  bound actually in force per harness.

## Hermeticity

Every write landed under the `mktemp -d` probe root (plus the harnesses' own
transcript dirs for the temp project). This repository's `.leopold/` was never
touched, no real browser and no real target site was involved — the only network
was each harness talking to its own model API. The temp `CODEX_HOME`'s copied
auth file was deleted after the runs.

<!-- @emit hook_bound=both -->
