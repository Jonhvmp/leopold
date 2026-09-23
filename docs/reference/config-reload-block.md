# ConfigChange exit 2 — Live Verification

**The question:** `hooks/config-guard.sh` refuses a settings reload during a Leopold run
by exiting 2 on `ConfigChange`, and it tells the operator that the session therefore
"keeps the hook wiring it started with" — the git lock first among them. That is a
security claim, and the hook-event probe could not back it.
[Hook Events](hook-events.md) records the `ConfigChange` `exit2` reply as
**unobservable**: the only `exit2` in the whole probe that is not marked *honored*. Its
one positive datum — the file on disk still carried the edit — is equally true whether
the reload was blocked or adopted, so it proves nothing on its own.

**The answer: exit 2 blocks the reload, and the file keeps the edit.** Both halves are
measured below, against a control, three times each.

## Versions

| Component | Version |
| --- | --- |
| Claude Code CLI (`claude`) | 2.1.260 (Claude Code) |
| `jq` | jq-1.7.1-apple |
| OS | Darwin 27.0.0 arm64 |
| Date | 2026-09-04 |

The probe that wrote [Hook Events](hook-events.md) ran against 2.1.259; this page is one
patch release later, and it says so rather than borrowing that page's header.

## Why the probe could not see it

A `ConfigChange` hook **never appears in the session's stream**. With
`--include-hook-events` on, `hook_started` / `hook_response` were emitted for
`SessionStart`, `UserPromptSubmit`, `PreToolUse` and `Stop` — and for nothing else. The
string `ConfigChange` does not occur anywhere in the stream of either run below:

```
$ jq -r 'select(.type=="system" and .subtype=="hook_started") | .hook_event' block3.stream.jsonl | sort | uniq -c
   4 PreToolUse
   2 SessionStart
   2 Stop
   2 UserPromptSubmit
$ grep -c ConfigChange block3.stream.jsonl
0
```

No `hook_response` means no `exit_code` field, so the verdict every other reply is read
from does not exist for this one. It has to be read from a **side effect** instead.

## Method (hermetic, paired)

A throwaway project per run under the session's own scratch directory, `git init`-ed,
with a `CLAUDE.md` and a `.claude/settings.json` that wires exactly one hook:

```json
{ "hooks": { "ConfigChange": [ { "hooks": [ { "type": "command",
  "command": "bash $P/.claude/hooks/cg.sh", "timeout": 10 } ] } ] } }
```

`cg.sh` appends the payload it was given to a log, then exits **2** (`block` runs) or
**0** (`allow` runs) — the only difference between the two arms.

Beside it sits `settings-v2.json`: the same file **plus** one extra `PreToolUse` hook on
`Bash` whose script appends `NEW_HOOK_FIRED` to a marker file. That hook is the
observable side effect — nothing can fire it unless the session adopts the rewritten
settings.

One headless turn per run, identical in both arms:

```
claude -p "Run this exact Bash command: bash rewire.sh. Then run this exact Bash command:
           echo SECOND_CALL. Then reply DONE."
        --model haiku --permission-mode bypassPermissions
        --output-format stream-json [--include-hook-events] --verbose
```

`rewire.sh` copies `settings-v2.json` over `.claude/settings.json` and sleeps 4 s. So the
sequence is: **tool call 1** rewrites the settings → `ConfigChange` fires and answers →
**tool call 2** happens under whatever wiring the session now has.

The payload `ConfigChange` delivered, verbatim (run `block`, paths as reported):

```json
{"session_id":"41421919-ea1a-4f29-b2cf-f43ed7abdbf0","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-…-cgprobe-block/41421919-ea1a-4f29-b2cf-f43ed7abdbf0.jsonl","cwd":"/private/tmp/…/cgprobe/block","scratchpad_dir":"/private/tmp/…/scratchpad","prompt_id":"bb22d94f-47fb-4110-bb65-b9282fd2e991","hook_event_name":"ConfigChange","source":"project_settings","file_path":"/private/tmp/…/cgprobe/block/.claude/settings.json"}
```

`source` and `file_path` are the two fields `hooks/config-guard.sh` reads, exactly as
[Hook Events](hook-events.md) records them.

## Evidence

| Run | `ConfigChange` exit | fired | 2nd tool call made | new hook fired | edit kept on disk |
| --- | --- | --- | --- | --- | --- |
| `allow`  | 0 | 1 | yes | **yes** | yes |
| `allow2` | 0 | 1 | yes | **yes** | yes |
| `allow3` | 0 | 1 | yes | **yes** | yes |
| `block`  | 2 | 1 | yes | **no** | yes |
| `block2` | 2 | 1 | yes | **no** | yes |
| `block3` | 2 | 1 | yes | **no** | yes |

Both arms made the same two tool calls — the absence of the marker in the `block` arm is
not an absence of the second call:

```
=== allow
TOOL Bash :: bash rewire.sh
TOOL Bash :: echo SECOND_CALL
=== block
TOOL Bash :: bash rewire.sh
TOOL Bash :: echo SECOND_CALL
```

And the stream counts the same thing independently. Two user-level `PreToolUse` hooks
exist on this machine, so two calls produce four firings; the rewritten settings add a
third hook, which can only fire on the second call:

```
allow3 (exit 0):   5 PreToolUse hook_started   ← 4 + the newly declared hook
block3 (exit 2):   4 PreToolUse hook_started   ← the newly declared hook never ran
```

The file on disk kept the edit in every run, `block` included:

```
$ jq -r '.hooks | has("PreToolUse")' block/.claude/settings.json
true
```

## What this decides for Leopold

- **`hooks/config-guard.sh` exit 2 does what it says.** The running session does not
  adopt the new configuration; the run keeps the hook wiring it started with, the git
  lock included. The operator-facing message on stderr is backed.
- **It does not undo the write, and nothing in this event can.** That is why the hook
  logs `config_change_blocked` as loudly as it refuses: the event is the durable record
  that the file on disk and the live session have diverged, and
  `scripts/leopold-watch.py` renders it as critical.
- **The verdict is a side effect, never a stream field.** `scripts/probe-hook-events.sh`
  now measures it the same way: the `config-change` / `config-change-exit2` pair rewrites
  the session's settings to a twin carrying one extra tagged `PreToolUse` hook and counts
  whether it fires — `config-change` is the control, and running `config-change-exit2`
  without it records "NO CONTROL" instead of a verdict. Rerun with
  `make probe-hook-events`.
- **Codex is unaffected.** Codex CLI 0.152.1 has no `ConfigChange` at all
  (`hooks/hook-matrix.tsv`), so a mid-run edit of `config.toml` is not detected there and
  `leopold doctor` says so per harness.
