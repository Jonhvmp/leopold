# Prompt Enhancer

Everyday prompts are naturally thin — speed becomes habit ("fix login", "arruma o
build"). The enhancer is one global `UserPromptSubmit` hook: it scores every prompt,
and when one is genuinely weak it has **Haiku — on your own connected account** —
produce a structured interpretation, injected as context *next to* the raw prompt:

```
[leopold-enhance — structured interpretation of the prompt above]
Objective: ...
Context: ...
Constraints: ...
Done when: ...
Assumptions: ...
Rule: this is a machine interpretation to help you plan. If it conflicts with the
user's raw prompt, THE RAW PROMPT WINS.
```

The raw prompt is never modified or blocked (the platform doesn't allow it, and the
injected rule makes the precedence explicit). The interpretation mirrors the
language of the prompt — a Portuguese prompt gets a Portuguese interpretation.

What makes it different from a generic prompt enhancer:

- **Charter-aware.** If the project has a Leopold brief, the rewriter reads
  `.leopold/CHARTER.md` (else `MISSION.md`) — it interprets the prompt the way *you*
  would, not the way an average user would.
- **Conversation-aware.** The rewriter gets the last exchanges from the session
  transcript, so "now do the same for logout" resolves instead of hallucinating.
- **Self-learning.** Every enhancement lands in a ledger that
  [`/leopold-enhance learn`](skills.md#leopold-enhance) mines for corrections,
  proposing rules for your global `PROMPT-PROFILE.md` — never applying them itself.

## Lifecycle

Installed **wired but OFF** by `install.sh` (the hook is a silent no-op while
`enabled` is false, and the settings merge is idempotent, so re-installs never
duplicate it). Turn it on and off interactively:

```
leopold menu → enhance → t) Toggle       # or: /leopold-enhance on|off
```

Full destroy — unwire the hook and delete `~/.claude/enhance` including the ledger
and learned profile: `leopold menu` → `u) Uninstall` → `enhance`. Removing Leopold
core also removes the enhancer (the core installer wired it).

## The gate

False positives are the UX killer: enhancing a good prompt wastes seconds and adds
noise. So hard skips run first, then a score that demands several independent
weakness signals — and a single anchor vetoes.

**Hard skips** (silent pass-through): enhancer off · `/`, `!`, `#` commands · short
acks ("ok", "sim", "2") · pasted code/logs (fences or > 8 lines) · prompts over
`max_words` · an active Leopold autonomous run in the project · a per-session
cooldown · the recursion/kill-switch env vars.

**Weakness score** (enhance at `min_score`, default 4):

| signal | points |
|---|---|
| ≤ 25 words | +2 |
| 26–`max_words` words | +1 |
| no structure (no newline / bullet / numbered list) | +1 |
| vague opener ("fix", "arruma", "melhora", …) and < 15 words | +1 |
| **anchor**: a path, code extension, `` `symbol` ``, or CamelCase/snake_case identifier | **−2** |
| formed question (ends in `?`, ≥ 8 words) | −2 |

So `"fix login"` scores 5 → enhanced; `"fix the retry loop in src/api/client.ts"`
scores 2 → passes through untouched. Check any prompt with
`/leopold-enhance preview "your prompt"` — it prints the per-signal breakdown and
the exact block that would be injected, without touching the ledger.

## The rewriter call

```
claude -p --safe-mode --model haiku --output-format text --tools "" --no-session-persistence
```

- **Safe mode** keeps your OAuth login but skips hooks, plugins, MCP and CLAUDE.md
  inside the subprocess — about **half the latency** of a plain headless call, and
  recursion becomes structurally impossible (the subprocess runs no hooks at all).
  A one-time probe (at install and on toggle-on) confirms the flag exists; an old
  CLI without it self-heals to normal mode after two consecutive *errors* (timeouts
  never downgrade — they are API slowness, and normal mode is slower). In normal
  mode the `LEOPOLD_ENHANCE_ACTIVE=1` env guard still blocks recursion (plus
  `OVMEM_DISABLE=1` so ovmem's hooks don't pay latency there).
- Runs with `cwd=~/.claude/enhance` so the *project's* CLAUDE.md is never loaded.
- Haiku is [always available on every plan](https://code.claude.com/docs) and the
  call is a fraction of a cent; only gated prompts pay the round trip — typically
  4–10 s, occasionally slower when the API queues (headless CLI latency is noisy) —
  bounded by a 25 s subprocess budget and the 30 s hook timeout, and a miss simply
  fails open.
- **Fail-open, always**: no `claude` binary, timeout, non-zero exit, empty or
  malformed output → nothing is emitted, the failure is ledgered, the session never
  notices.

## State and ledger

Everything lives in `~/.claude/enhance/` and never leaves the machine (the docs on
disk: [`RUNTIME.md`](https://github.com/Jonhvmp/leopold/blob/main/extensions/enhance/payload/RUNTIME.md)
is installed as its README).

`state.json`:

```json
{
  "enabled": false, "model": "haiku", "safe_mode": true, "probed_at": null,
  "thresholds": { "min_score": 4, "max_words": 60, "cooldown_s": 120, "max_inject_chars": 1200 },
  "subprocess_timeout_s": 25, "consecutive_failures": 0
}
```

`enhancements.jsonl` — one line per injection *or failed attempt* (gate skips are
not ledgered); rotates at 2 MB keeping one generation:

```json
{"ts":"2026-07-05T14:03:22Z","session_id":"…","prompt_id":"…","cwd":"/home/me/app",
 "prompt_excerpt":"fix login","words":2,"score":5,
 "signals":{"short":2,"structure":1,"anchor":1,"vague":1,"question":0},
 "mode":"safe","model":"haiku","latency_ms":3840,
 "charter_used":true,"profile_used":false,"tail_used":true,
 "injected":true,"injected_chars":642,"error":null}
```

Env controls:

```
LEOPOLD_ENHANCE_DISABLE=1     kill switch (stays wired, does nothing)
LEOPOLD_ENHANCE_DEBUG=1       log gate decisions to ~/.claude/enhance/enhance.log
LEOPOLD_ENHANCE_MIN_SCORE     LEOPOLD_ENHANCE_MAX_WORDS
LEOPOLD_ENHANCE_COOLDOWN_S    LEOPOLD_ENHANCE_TIMEOUT_S
```

## The learn loop

Generic enhancers are stateless; this one closes the loop. `/leopold-enhance learn`
compiles the same trust structure as [`/leopold-learn`](skills.md#leopold-learn)
into a dynamic workflow: a **correction correlator** joins the ledger to your
session transcripts and finds enhanced prompts you corrected right after; a
**ledger-stats miner** finds gate misfires without ever leaving the ledger; a
cluster pass merges them (a pattern in both miners is the strongest signal); one
**kill-biased skeptic per candidate** defaults to reject; the survivors become
`~/.claude/enhance/PROFILE-amendments.md` — a proposal. You accept rules
explicitly; the skill never edits `PROMPT-PROFILE.md` on its own. Accepted rules
feed every future interpretation, so the enhancer reads your shorthand a little
more like you with each pass.

## Privacy & limitations

- **Prompts stay local.** Excerpts (≤ 500 chars) live in the ledger under
  `~/.claude/enhance` — the same trust domain as `~/.claude/projects` transcripts.
  The only network call is the rewriter, through your own `claude` login. The
  uninstall entry deletes everything.
- **Latency** only on genuinely weak prompts (the gate itself is < 10 ms of
  Python); a 120 s per-session cooldown stops it from firing on rapid exchanges.
- **Plugin installs**: extensions ship with the repo/npm installs, not the Claude
  Code plugin — plugin users can get the enhancer with
  `npm i -g leopold-driver && leopold enhance install`.
- **jq-less systems**: wiring (install/remove) needs `jq`, like every Leopold
  extension; the runtime and toggle are python3-only.
