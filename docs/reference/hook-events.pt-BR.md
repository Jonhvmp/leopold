# Eventos de hook — Probe ao vivo nos dois harnesses

**A pergunta:** quais eventos de hook do ciclo de vida realmente disparam a partir de uma sessão *headless* nos binários instalados, com qual payload, e qual resposta cada harness honra? As regras do Leopold só viram hooks em eventos capturados — nunca a partir de uma página de docs ou de um dump de `strings`. Esta página é gerada por `scripts/probe-hook-events.sh` a partir dos payloads verbatim que ele gravou; rode de novo nos dois binários e a página se reescreve.

**A resposta em uma linha:** 26 dos 33 eventos que o Claude Code documenta dispararam em `2.1.259 (Claude Code)`; 12 dos 12 eventos que o Codex CLI documenta dispararam em `codex-cli 0.152.1`. Todo evento que não disparou está registrado abaixo com o gatilho tentado.

## Versões

| Componente | Versão |
| --- | --- |
| Claude Code CLI (`claude --version`) | `2.1.259 (Claude Code)` |
| Codex CLI (`codex --version`) | `codex-cli 0.152.1` |
| Alias de modelo do Claude Code usado no probe | `haiku` |
| Modelo do Codex (dos payloads capturados) | `gpt-5.6-sol` |
| jq | `jq-1.7.1-apple` |
| Python (stubs, renderizador) | `Python 3.14.6` |
| bash (hooks, driver) | `3.2.57(1)-release` |
| SO | `Darwin 27.0.0 arm64` |
| Leopold | 0.22.0 (`scripts/probe-hook-events.sh`, `scripts/probe/dump-hook.sh`) |
| Probe executado em (UTC) | 2026-09-03T01:36:54Z |

## Método (hermético)

- Um projeto descartável sob `mktemp -d` por harness (`/tmp/leopold-hookprobe.gjQnXe`): com `git init`, um `CLAUDE.md` / `AGENTS.md`, um `.leopold/PLAN.md` e um `PLAN.md` na raiz (o controle do `FileChanged`), um arquivo de 120 KB para forçar compactação, um comando de projeto (`.claude/commands/probecmd.md`) e um arquivo de role do Codex (`.codex/agents/probe-reviewer.toml`).
- `scripts/probe/dump-hook.sh <event>` plugado em **todo** evento da matriz documentada de cada harness pelo writer compartilhado em `extensions/lib/harness.sh` — `leo_wire_hooks_json` no `.claude/settings.json` do projeto, `leo_wire_hooks_toml` num `CODEX_HOME/config.toml` temporário; nada cola JSON ou TOML à mão. O hook anexa seu stdin verbatim em `<out>/<harness>/<event>.jsonl` — o nome do evento é o argumento dele, então um payload sem `hook_event_name` ainda é arquivado sob o nome certo — e responde conforme o modo (observe / allow / deny / exit 2 / `systemMessage` / `additionalContext` / aceite de elicitation / worktree).
- **Claude Code:** `claude -p --setting-sources project --output-format stream-json --include-hook-events` em ambiente limpo. O diretório de config real é apenas *lido* (o macOS guarda o login no Keychain — exatamente como a run 2 de [Hooks do worker SDK](sdk-worker-hooks.md) autenticou); um `CLAUDE_CONFIG_DIR` temporário é usado numa única passagem, a run não autenticada *os-hooks-disparam-mesmo-assim*.
- **Codex CLI:** `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust` com stdin fechado, um `CODEX_HOME` temporário com uma cópia do `auth.json`, apagada quando o probe termina.
- Um gatilho por evento: um comando Bash que passa e um que falha; a edição do próprio `.leopold/PLAN.md` pela sessão e um append vindo de *outro processo*; um spawn via `Agent` / `spawn_agent`; um TaskCreate + TaskUpdate concluído com bloqueio por exit 2; compactação forçada (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `/compact` numa sessão retomada; Codex `-c model_auto_compact_token_limit`); uma falha de API via `ANTHROPIC_BASE_URL` e via `model_providers.<id>.base_url` do Codex apontados para um stub em Python stdlib que responde 429, 529, 500 e 401; um pedido de permissão para uma ferramenta fora do allowlist com respostas allow e deny; uma edição do `settings.json` no meio da sessão; uma elicitation MCP de um stub stdio; `--worktree`; `--init` / `--maintenance`; `/model`; um control request `register_repo_root`; SIGINT no `codex exec`; um arquivo de role do Codex exercitado por `spawn_agent` e por `codex exec` com `--strict-config`.
- **A hermeticidade é afirmada, não presumida:** os nomes das entradas de `~/.claude` e `~/.codex` reais são fingerprintados antes e depois (a mesma checagem que `scripts/test-harness-lib.sh` roda) e o probe falha se qualquer um mudou. Nesta execução: `~/.claude` inalterado, `~/.codex` MUDOU.
- Os payloads abaixo são citados **verbatim**; apenas valores string com mais de 480 caracteres são cortados com um marcador explícito `…[+N chars]`. Os arquivos brutos sob `<out>/` guardam cada byte. Dados capturados — payloads, notas de gatilho e linhas de evidência — são citados como gravados, em inglês.

## Matriz — Claude Code (2.1.259 (Claude Code))

| Evento | Disparou | Runs | `hook_event_name` | `session_id` | Respostas exercitadas |
| --- | --- | --- | --- | --- | --- |
| `SessionStart` | sim ×40 | add-dir, additional-context, command, command-exit2, compact-auto, compact-manual, compact-manual-seed, config-change, config-change-exit2, fail-401, fail-429, fail-500, fail-529, filechanged-cwd, filechanged-nested, model-switch, model-switch-exit2, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, prompt-exit2, setup-init, setup-maintenance, stop-block, stop-exit2, subagent, subagent-exit2, system-message, tasks, tasks-exit2, teams, tools, unauth, worktree-agent | present | present | `additionalContext`, `systemMessage` |
| `Setup` | sim ×2 | setup-init, setup-maintenance | present | present | — |
| `UserPromptSubmit` | sim ×33 | add-dir, additional-context, command, compact-auto, compact-manual-seed, config-change, config-change-exit2, fail-401, fail-429, fail-500, fail-529, filechanged-cwd, filechanged-nested, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, prompt-exit2, setup-init, setup-maintenance, stop-block, stop-exit2, subagent, subagent-exit2, system-message, tasks, tasks-exit2, teams, tools, unauth, worktree-agent | present | present | `additionalContext`, `exit2`, `systemMessage` |
| `UserPromptExpansion` | sim ×2 | command, command-exit2 | present | present | `exit2` |
| `PreToolUse` | sim ×48 | additional-context, compact-auto, compact-manual-seed, config-change, config-change-exit2, filechanged-cwd, filechanged-nested, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, subagent, subagent-exit2, system-message, tasks, tasks-exit2, tools, worktree-agent | present | present | `additionalContext`, `permissionDecision:deny`, `systemMessage` |
| `PermissionRequest` | sim ×2 | perm-allow, perm-deny | present | present | `decision:allow`, `decision:allow (host prompts)`, `decision:deny` |
| `PermissionDenied` | **não disparou** | — | — | — | — |
| `PostToolUse` | sim ×43 | additional-context, compact-auto, compact-manual-seed, config-change, config-change-exit2, filechanged-cwd, filechanged-nested, perm-allow, posttool-block, subagent, subagent-exit2, system-message, tasks, tasks-exit2, tools, worktree-agent | present | present | `additionalContext`, `decision:block`, `systemMessage` |
| `PostToolUseFailure` | sim ×1 | tools | present | present | — |
| `PostToolBatch` | sim ×48 | additional-context, compact-auto, compact-manual-seed, config-change, config-change-exit2, filechanged-cwd, filechanged-nested, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, subagent, subagent-exit2, system-message, tasks, tasks-exit2, tools, worktree-agent | present | present | `additionalContext`, `systemMessage` |
| `Notification` | **não disparou** | — | — | — | — |
| `MessageDisplay` | sim ×48 | add-dir, additional-context, command, compact-auto, compact-manual-seed, config-change, config-change-exit2, fail-401, fail-429, fail-500, fail-529, filechanged-cwd, filechanged-nested, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, setup-init, setup-maintenance, stop-block, stop-exit2, subagent, subagent-exit2, system-message, tasks, tasks-exit2, teams, tools, unauth, worktree-agent | present | present | `systemMessage` |
| `SubagentStart` | sim ×3 | subagent, subagent-exit2, worktree-agent | present | present | — |
| `SubagentStop` | sim ×6 | compact-auto, compact-manual, subagent, subagent-exit2, worktree-agent | present | present | `exit2` |
| `TaskCreated` | sim ×2 | tasks, tasks-exit2 | present | present | — |
| `TaskCompleted` | sim ×2 | tasks, tasks-exit2 | present | present | `exit2` |
| `Stop` | sim ×29 | add-dir, additional-context, command, compact-auto, compact-manual-seed, config-change, config-change-exit2, filechanged-cwd, filechanged-nested, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, setup-init, setup-maintenance, stop-block, stop-exit2, subagent, subagent-exit2, system-message, tasks, tasks-exit2, teams, tools, worktree-agent | present | present | `decision:block`, `exit2`, `systemMessage` |
| `StopFailure` | sim ×5 | fail-500 | present | present | — |
| `TeammateIdle` | **não disparou** | — | — | — | — |
| `InstructionsLoaded` | sim ×38 | add-dir, additional-context, command, command-exit2, compact-auto, compact-manual, compact-manual-seed, config-change, config-change-exit2, fail-401, fail-429, fail-500, fail-529, filechanged-cwd, filechanged-nested, model-switch, model-switch-exit2, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, prompt-exit2, setup-init, setup-maintenance, stop-block, stop-exit2, subagent, subagent-exit2, system-message, tasks, tasks-exit2, teams, tools, unauth, worktree-agent | present | present | `additionalContext`, `systemMessage` |
| `ConfigChange` | sim ×2 | config-change, config-change-exit2 | present | present | `exit2` |
| `CwdChanged` | sim ×2 | filechanged-cwd, tools | present | present | `systemMessage` |
| `DirectoryAdded` | **não disparou** | — | — | — | — |
| `FileChanged` | sim ×6 | filechanged-nested, tools | present | present | — |
| `WorktreeCreate` | sim ×2 | worktree, worktree-agent | present | present | `worktree` |
| `WorktreeRemove` | **não disparou** | — | — | — | — |
| `PreCompact` | sim ×2 | compact-auto, compact-manual | present | present | — |
| `PostCompact` | sim ×2 | compact-auto, compact-manual | present | present | — |
| `PreModelSwitch` | sim ×2 | model-switch, model-switch-exit2 | present | present | `exit2` |
| `PostModelSwitch` | sim ×1 | model-switch | present | present | — |
| `Elicitation` | **não disparou** | — | — | — | `action:accept+content` |
| `ElicitationResult` | **não disparou** | — | — | — | — |
| `SessionEnd` | sim ×34 | add-dir, additional-context, command, command-exit2, compact-auto, compact-manual, compact-manual-seed, config-change, config-change-exit2, fail-429, filechanged-cwd, filechanged-nested, model-switch, model-switch-exit2, perm-allow, perm-auto, perm-deny, perm-host, posttool-block, pretool-deny, prompt-exit2, setup-init, setup-maintenance, stop-block, stop-exit2, subagent, subagent-exit2, system-message, tasks, tasks-exit2, teams, tools, worktree-agent | present | present | `systemMessage` |

## Matriz — Codex CLI (codex-cli 0.152.1)

| Evento | Disparou | Runs | `hook_event_name` | `session_id` | Respostas exercitadas |
| --- | --- | --- | --- | --- | --- |
| `SessionStart` | sim ×25 | additional-context, compact, exec-as-role-4, fail-401, fail-429, fail-500, fail-529, interrupt, perm-allow, perm-deny, perm-onrequest, posttool-block, pretool-deny, prompt-exit2, role-bogus, role-bogus-strict, stop-block, stop-exit2, strict-config, subagent, subagent-exit2, subagent-role, system-message, tools | present | present | `--strict-config with the probe's hook block`, `additionalContext`, `systemMessage` |
| `SessionEnd` | sim ×24 | additional-context, compact, exec-as-role-4, fail-401, fail-429, fail-500, fail-529, interrupt, perm-allow, perm-deny, perm-onrequest, posttool-block, pretool-deny, prompt-exit2, role-bogus, role-bogus-strict, stop-block, stop-exit2, strict-config, subagent, subagent-exit2, subagent-role, system-message, tools | present | present | `systemMessage` |
| `SubagentStart` | sim ×3 | subagent, subagent-exit2, subagent-role | present | present | `codex exec -c agent_role="probe-reviewer"`, `codex exec -c agent_type="probe-reviewer"`, `codex exec -c agents.probe-reviewer.config_file=".codex/agents/probe-reviewer.toml"`, `codex exec -c role="probe-reviewer"`, `codex exec -p <role file as profile>`, `role file`, `role file with an unknown key`, `role file with an unknown key (--strict-config)` |
| `SubagentStop` | sim ×4 | subagent, subagent-exit2, subagent-role | present | present | `exit2` |
| `PreToolUse` | sim ×29 | additional-context, compact, interrupt, perm-allow, perm-deny, perm-onrequest, posttool-block, pretool-deny, role-bogus, role-bogus-strict, subagent, subagent-exit2, subagent-role, system-message, tools | present | present | `additionalContext`, `permissionDecision:deny`, `systemMessage` |
| `PermissionRequest` | sim ×1 | perm-deny | present | present | `decision:allow`, `decision:allow (approval_policy=on-request)`, `decision:deny` |
| `PostToolUse` | sim ×24 | additional-context, compact, perm-allow, perm-deny, perm-onrequest, posttool-block, subagent, subagent-exit2, subagent-role, system-message, tools | present | present | `additionalContext`, `decision:block`, `systemMessage` |
| `PreCompact` | sim ×1 | compact | present | present | — |
| `PostCompact` | sim ×1 | compact | present | present | — |
| `UserPromptSubmit` | sim ×24 | additional-context, compact, exec-as-role-4, fail-401, fail-429, fail-500, fail-529, interrupt, perm-allow, perm-deny, perm-onrequest, posttool-block, pretool-deny, prompt-exit2, role-bogus, role-bogus-strict, stop-block, stop-exit2, strict-config, subagent, subagent-exit2, subagent-role, system-message, tools | present | present | `additionalContext`, `exit2`, `systemMessage` |
| `Stop` | sim ×20 | additional-context, compact, exec-as-role-4, perm-allow, perm-deny, perm-onrequest, posttool-block, pretool-deny, role-bogus, role-bogus-strict, stop-block, stop-exit2, strict-config, subagent, subagent-exit2, subagent-role, system-message, tools | present | present | `decision:block`, `exit2`, `systemMessage` |
| `Interrupt` | sim ×1 | interrupt | present | present | — |

## Eventos — Claude Code

### `SessionStart` — Claude Code

Disparou 40 vez(es) na(s) run(s) `add-dir`, `additional-context`, `command`, `command-exit2`, `compact-auto`, `compact-manual`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `fail-401`, `fail-429`, `fail-500`, `fail-529`, `filechanged-cwd`, `filechanged-nested`, `model-switch`, `model-switch-exit2`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `prompt-exit2`, `setup-init`, `setup-maintenance`, `stop-block`, `stop-exit2`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `teams`, `tools`, `unauth`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `context_tokens`, `cwd`, `estimated_cache_write_usd`, `hook_event_name`, `model`, `prompt_cache_likely_expired`, `prompt_id`, `seconds_since_last_response`, `session_id`, `source`, `transcript_path`.

Payload, verbatim (source: "startup"):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","hook_event_name":"SessionStart","source":"startup"}
```

Payload, verbatim (source: "compact"):

```json
{"session_id":"8696992c-e252-4b26-aa6e-0f09b973a8fc","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/8696992c-e252-4b26-aa6e-0f09b973a8fc.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"b1988ab3-5c85-48da-81fd-b0bd3a241365","hook_event_name":"SessionStart","source":"compact","model":"claude-haiku-4-5-20251001"}
```

Payload, verbatim (source: "resume"):

```json
{"session_id":"ea4f4119-202c-4931-9721-72c83db1f7af","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/ea4f4119-202c-4931-9721-72c83db1f7af.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","hook_event_name":"SessionStart","source":"resume","seconds_since_last_response":1,"context_tokens":42637,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.0853}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `systemMessage` → **honrada** — marker PROBE_SYSMSG SessionStart appears 1 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*
- `additionalContext` → **honrada** — the model repeated 'PROBE_CTX SessionStart': yes; the marker is in the transcript 3 time(s) (event fired in the run: 1 times) *(run additional-context)*

### `Setup` — Claude Code

Disparou 2 vez(es) na(s) run(s) `setup-init`, `setup-maintenance`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `session_id`, `transcript_path`, `trigger`.

Payload, verbatim (trigger: "init"):

```json
{"session_id":"a16a5ec3-e3a5-44d2-8c82-b0e265ff8ea0","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/a16a5ec3-e3a5-44d2-8c82-b0e265ff8ea0.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","hook_event_name":"Setup","trigger":"init"}
```

Payload, verbatim (trigger: "maintenance"):

```json
{"session_id":"6387e875-a636-4eb4-89b5-f67903067f13","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/6387e875-a636-4eb4-89b5-f67903067f13.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","hook_event_name":"Setup","trigger":"maintenance"}
```

Gatilhos tentados:

- run setup-init: `claude -p --init`; run setup-maintenance: `claude -p --maintenance`

### `UserPromptSubmit` — Claude Code

Disparou 33 vez(es) na(s) run(s) `add-dir`, `additional-context`, `command`, `compact-auto`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `fail-401`, `fail-429`, `fail-500`, `fail-529`, `filechanged-cwd`, `filechanged-nested`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `prompt-exit2`, `setup-init`, `setup-maintenance`, `stop-block`, `stop-exit2`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `teams`, `tools`, `unauth`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `permission_mode`, `prompt`, `prompt_id`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"UserPromptSubmit","prompt":"Do these steps in order with tools, one tool call per step, never two in parallel: 1) Bash: true  2) Bash: false  3) Bash: grep -c zzz /dev/null  4) Edit tool: in .leopold/PLAN.md replace 'item one' with 'item one (edited)'  5) Edit tool: in PLAN.md (project root) replace 'root item' with 'root item (edited)'  6) Bash: sleep 6  7) Bash: cat .leopold/PLAN.md  8) Bash: cd sub && pwd. Then reply with the single word DONE."}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `exit2` → **honrada** — hook_response: outcome=error exit_code=2; assistant messages carrying the prompt's marker: 0; Stop fired: 0; final: UserPromptSubmit operation blocked by hook:  *(run prompt-exit2)*
- `systemMessage` → **honrada** — marker PROBE_SYSMSG UserPromptSubmit appears 2 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*
- `additionalContext` → **honrada** — the model repeated 'PROBE_CTX UserPromptSubmit': no; the marker is in the transcript 2 time(s) (event fired in the run: 1 times) *(run additional-context)*

### `UserPromptExpansion` — Claude Code

Disparou 2 vez(es) na(s) run(s) `command`, `command-exit2`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `command_args`, `command_name`, `command_source`, `cwd`, `expansion_type`, `hook_event_name`, `permission_mode`, `prompt`, `prompt_id`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"b2c0e499-5929-43e8-ad86-0161c31208f7","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/b2c0e499-5929-43e8-ad86-0161c31208f7.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"c76c421a-e281-4814-aa56-23155a1840da","permission_mode":"bypassPermissions","hook_event_name":"UserPromptExpansion","expansion_type":"slash_command","command_name":"probecmd","command_args":"","command_source":"projectSettings","prompt":"/probecmd"}
```

Gatilhos tentados:

- run command: the user prompt is the project command /probecmd (.claude/commands/probecmd.md)

Respostas que o harness honrou:

- `exit2` → **honrada** — hook_response: outcome=error exit_code=2; the command's expansion text reached the model: no; final reply: UserPromptExpansion operation blocked by hook:  *(run command-exit2)*

### `PreToolUse` — Claude Code

Disparou 48 vez(es) na(s) run(s) `additional-context`, `compact-auto`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `filechanged-cwd`, `filechanged-nested`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `tools`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `agent_id`, `agent_type`, `cwd`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`.

Payload, verbatim (Bash: {"command":"true","description":"Step 1: Run true command"}):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"true","description":"Step 1: Run true command"},"tool_use_id":"toolu_012pvg9iy5XR1HxLRHTMbFL8"}
```

Payload, verbatim (Bash: {"command":"false","description":"Step 2: Run false command"}):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"false","description":"Step 2: Run false command"},"tool_use_id":"toolu_01QTAduNmuev93E45QX6sgsE"}
```

Payload, verbatim (Bash: {"command":"grep -c zzz /dev/null","description":"Step 3: Count matches of zzz i):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"grep -c zzz /dev/null","description":"Step 3: Count matches of zzz in /dev/null"},"tool_use_id":"toolu_01BkUCMD3BxMCBKacum25xQg"}
```

Payload, verbatim (Read: {"file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN.md"},"tool_use_id":"toolu_01WpaqWWUfNkkeDCWHzoNWHm"}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `observe` → **n/a** — inside the subagent, PreToolUse carries agent_id: acb594f61d1631b05 *(run subagent)*
- `permissionDecision:deny` → **honrada** — PostToolUse fired 0 times after the deny (0 = the tool never ran); reason reached the model: yes *(run pretool-deny)*
- `systemMessage` → **honrada** — marker PROBE_SYSMSG PreToolUse appears 2 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*
- `additionalContext` → **honrada** — the model repeated 'PROBE_CTX PreToolUse': no; the marker is in the transcript 3 time(s) (event fired in the run: 1 times) *(run additional-context)*

### `PermissionRequest` — Claude Code

Disparou 2 vez(es) na(s) run(s) `perm-allow`, `perm-deny`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `permission_mode`, `permission_suggestions`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"12f459b8-ddba-474a-8dbb-05427ec73267","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/12f459b8-ddba-474a-8dbb-05427ec73267.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"7fabe826-67ae-42c3-9c36-d334df729b6c","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch probe-allow.txt && echo PROBE_ALLOWED","description":"Create probe-allow.txt file and echo PROBE_ALLOWED"},"permission_suggestions":[{"type":"addDirectories","directories":["/private/tmp/leopold-hookprobe.gjQnXe/claude-project"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}
```

Gatilhos tentados:

- run perm-allow: default permission mode with --permission-prompts none; Bash touch (not auto-approved) needs a decision
- run perm-host: the same Bash touch with the default --permission-prompts host (a plain CLI -p has no host)

Respostas que o harness honrou:

- `decision:allow` → **honrada** — the file the command creates exists: yes; PostToolUse fired: 1 *(run perm-allow)*
- `decision:deny` → **honrada** — the file exists: no; message PROBE_DENY reached the model: yes; PermissionDenied fired: 0 *(run perm-deny)*
- `decision:allow (host prompts)` → **não honrada** — with --permission-prompts host (the default) the hook fired 0 times and the file exists: no — permission_denials in the result: 1 *(run perm-host)*

### `PermissionDenied` — Claude Code

**Não disparou no Claude Code 2.1.259 (Claude Code).** Gatilho tentado: run perm-auto: --permission-mode auto with a Bash touch (denied, permission_denials=1); also run perm-deny: a PermissionRequest hook answering deny

### `PostToolUse` — Claude Code

Disparou 43 vez(es) na(s) run(s) `additional-context`, `compact-auto`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `filechanged-cwd`, `filechanged-nested`, `perm-allow`, `posttool-block`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `tools`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `agent_id`, `agent_type`, `cwd`, `duration_ms`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path`.

Payload, verbatim (Bash: {"command":"true","description":"Step 1: Run true command"}):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"true","description":"Step 1: Run true command"},"tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},"tool_use_id":"toolu_012pvg9iy5XR1HxLRHTMbFL8","duration_ms":90}
```

Payload, verbatim (Bash: {"command":"grep -c zzz /dev/null","description":"Step 3: Count matches of zzz i):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"grep -c zzz /dev/null","description":"Step 3: Count matches of zzz in /dev/null"},"tool_response":{"stdout":"0","stderr":"","interrupted":false,"isImage":false,"returnCodeInterpretation":"No matches found","noOutputExpected":false},"tool_use_id":"toolu_01BkUCMD3BxMCBKacum25xQg","duration_ms":17}
```

Payload, verbatim (Read: {"file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN.md"},"tool_response":{"type":"text","file":{"filePath":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN.md","content":"# Plan\n- [ ] item one\n","numLines":3,"startLine":1,"totalLines":3}},"tool_use_id":"toolu_01WpaqWWUfNkkeDCWHzoNWHm","duration_ms":2}
```

Payload, verbatim (Edit: {"file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN.md","old_string":"- [ ] item one","new_string":"- [ ] item one (edited)","replace_all":false},"tool_response":{"filePath":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN.md","oldString":"- [ ] item one","newString":"- [ ] item one (edited)","originalFile":"# Plan\n- [ ] item one\n","structuredPatch":[{"oldStart":1,"oldLines":2,"newStart":1,"newLines":2,"lines":[" # Plan","-- [ ] item one","+- [ ] item one (edited)"]}],"userModified":false,"replaceAll":false},"tool_use_id":"toolu_01F3Ro7STSqrLt9kMqMwtkZK","duration_ms":3}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `observe` → **n/a** — Bash `true` (exit 0) fired PostToolUse: yes; the failing `false` fired PostToolUseFailure with error="Exit code 1" — a non-zero Bash exit is routed to PostToolUseFailure UNLESS the harness re-interprets it — `grep -c zzz /dev/null` (exit 1) reached PostToolUse instead, with returnCodeInterpretation="No matches found" (Findings) *(run tools)*
- `decision:block` → **honrada** — hook_response: outcome=success exit_code=0; the reason PROBE_BLOCK reached the model/stream: yes *(run posttool-block)*
- `systemMessage` → **honrada** — marker PROBE_SYSMSG PostToolUse appears 2 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*
- `additionalContext` → **honrada** — the model repeated 'PROBE_CTX PostToolUse': no; the marker is in the transcript 3 time(s) (event fired in the run: 1 times) *(run additional-context)*

### `PostToolUseFailure` — Claude Code

Disparou 1 vez(es) na(s) run(s) `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `duration_ms`, `error`, `hook_event_name`, `is_interrupt`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"false","description":"Step 2: Run false command"},"tool_use_id":"toolu_01QTAduNmuev93E45QX6sgsE","error":"Exit code 1","is_interrupt":false,"duration_ms":11}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

### `PostToolBatch` — Claude Code

Disparou 48 vez(es) na(s) run(s) `additional-context`, `compact-auto`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `filechanged-cwd`, `filechanged-nested`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `tools`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `agent_id`, `agent_type`, `cwd`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_calls`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"PostToolBatch","tool_calls":[{"tool_name":"Bash","tool_input":{"command":"true","description":"Step 1: Run true command"},"tool_use_id":"toolu_012pvg9iy5XR1HxLRHTMbFL8","tool_response":"(Bash completed with no output)"}]}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `systemMessage` → **honrada** — marker PROBE_SYSMSG PostToolBatch appears 2 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*
- `additionalContext` → **honrada** — the model repeated 'PROBE_CTX PostToolBatch': no; the marker is in the transcript 3 time(s) (event fired in the run: 1 times) *(run additional-context)*

### `Notification` — Claude Code

**Não disparou no Claude Code 2.1.259 (Claude Code).** Gatilho tentado: run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd` · runs perm-allow / perm-deny / perm-host: a permission decision in a headless session (matcher permission_prompt)

### `MessageDisplay` — Claude Code

Disparou 48 vez(es) na(s) run(s) `add-dir`, `additional-context`, `command`, `compact-auto`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `fail-401`, `fail-429`, `fail-500`, `fail-529`, `filechanged-cwd`, `filechanged-nested`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `setup-init`, `setup-maintenance`, `stop-block`, `stop-exit2`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `teams`, `tools`, `unauth`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `delta`, `final`, `hook_event_name`, `index`, `message_id`, `prompt_id`, `session_id`, `transcript_path`, `turn_id`.

Payload, verbatim:

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","hook_event_name":"MessageDisplay","turn_id":"73b5ff9c-0cac-4cde-9090-c8f3d5aa1339","message_id":"98f9e48b-9ef9-497e-9489-154e822c1cec","index":0,"final":true,"delta":"I'll execute these steps sequentially, one tool call per step."}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `systemMessage` → **honrada** — marker PROBE_SYSMSG MessageDisplay appears 1 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*

### `SubagentStart` — Claude Code

Disparou 3 vez(es) na(s) run(s) `subagent`, `subagent-exit2`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `agent_id`, `agent_type`, `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"049615d1-d898-4fdb-ac17-53e8749b4b97","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/049615d1-d898-4fdb-ac17-53e8749b4b97.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"3ab1ba79-1a1c-47f8-8fd5-752a1894b69b","agent_id":"acb594f61d1631b05","agent_type":"general-purpose","hook_event_name":"SubagentStart"}
```

Gatilhos tentados:

- run subagent: the Agent tool (subagent_type general-purpose) running one Bash command

### `SubagentStop` — Claude Code

Disparou 6 vez(es) na(s) run(s) `compact-auto`, `compact-manual`, `subagent`, `subagent-exit2`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `agent_id`, `agent_transcript_path`, `agent_type`, `background_tasks`, `cwd`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path`.

Payload, verbatim (stop_hook_active: false):

```json
{"session_id":"049615d1-d898-4fdb-ac17-53e8749b4b97","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/049615d1-d898-4fdb-ac17-53e8749b4b97.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"3ab1ba79-1a1c-47f8-8fd5-752a1894b69b","permission_mode":"bypassPermissions","agent_id":"acb594f61d1631b05","agent_type":"general-purpose","hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/049615d1-d898-4fdb-ac17-53e8749b4b97/subagents/agent-acb594f61d1631b05.jsonl","last_assistant_message":"PONG","background_tasks":[],"session_crons":[]}
```

Payload, verbatim (stop_hook_active: true):

```json
{"session_id":"54b1292d-2d58-42bc-afaf-84baf89dc352","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/54b1292d-2d58-42bc-afaf-84baf89dc352.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"e57be662-12a6-46ed-85f2-8bf695bc7694","permission_mode":"bypassPermissions","agent_id":"af5a008acb95c5a66","agent_type":"general-purpose","hook_event_name":"SubagentStop","stop_hook_active":true,"agent_transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/54b1292d-2d58-42bc-afaf-84baf89dc352/subagents/agent-af5a008acb95c5a66.jsonl","last_assistant_message":"Acknowledged. The subagent stop hook was executed successfully with:\n- Hook: `SubagentStop`\n- Output path: `/private/tmp/claude-501/-Users-jonhvmp-myspace-github-leopold/f8164f0a-f022-4498-9d87-6f196802cf56/scratchpad/final`\n- Result: `probe exit2 SubagentStop`\n\nIs there anything else you'd like me to do?","background_tasks":[],"session_crons":[]}
```

Gatilhos tentados:

- run subagent: the Agent tool (subagent_type general-purpose) running one Bash command

Respostas que o harness honrou:

- `exit2` → **honrada** — SubagentStop fired 2 times in the run (exit 2 once, then the subagent stopped again); stop_hook_active on the second: true; hook_response: outcome=success exit_code=0 *(run subagent-exit2)*

### `TaskCreated` — Claude Code

Disparou 2 vez(es) na(s) run(s) `tasks`, `tasks-exit2`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `task_description`, `task_id`, `task_subject`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"24a348d1-5aa2-479f-aefe-51d20940d6cf","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/24a348d1-5aa2-479f-aefe-51d20940d6cf.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"f04c18bc-db45-4ccf-aebc-e0b6c15435b0","hook_event_name":"TaskCreated","task_id":"1","task_subject":"probe task","task_description":"probe"}
```

Gatilhos tentados:

- run tasks: TaskCreate then TaskUpdate(status=completed) then TaskList

### `TaskCompleted` — Claude Code

Disparou 2 vez(es) na(s) run(s) `tasks`, `tasks-exit2`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `task_description`, `task_id`, `task_subject`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"24a348d1-5aa2-479f-aefe-51d20940d6cf","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/24a348d1-5aa2-479f-aefe-51d20940d6cf.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"f04c18bc-db45-4ccf-aebc-e0b6c15435b0","hook_event_name":"TaskCompleted","task_id":"1","task_subject":"probe task","task_description":"probe"}
```

Gatilhos tentados:

- run tasks: TaskCreate then TaskUpdate(status=completed) then TaskList

Respostas que o harness honrou:

- `exit2` → **honrada** — hook_response: outcome=error exit_code=2; final reply: Task created, updated to completed, and here's the status from TaskList:  *(run tasks-exit2)*

### `Stop` — Claude Code

Disparou 29 vez(es) na(s) run(s) `add-dir`, `additional-context`, `command`, `compact-auto`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `filechanged-cwd`, `filechanged-nested`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `setup-init`, `setup-maintenance`, `stop-block`, `stop-exit2`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `teams`, `tools`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `background_tasks`, `cwd`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path`.

Payload, verbatim (stop_hook_active: false):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/sub","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","permission_mode":"bypassPermissions","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"DONE","background_tasks":[],"session_crons":[]}
```

Payload, verbatim (stop_hook_active: true):

```json
{"session_id":"6e892317-009f-4b39-98c7-b8059db80916","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/6e892317-009f-4b39-98c7-b8059db80916.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"da942d3a-2805-441e-b5f2-17c165d0e5d8","permission_mode":"bypassPermissions","hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"Understood. The stop hook has executed and captured the exit state. The probe shows `exit2 Stop` was recorded.\n\nWhat would you like me to do next? Are you testing the hook behavior, debugging the probe system, or is there a specific issue with the stop hook that needs investigation?","background_tasks":[],"session_crons":[]}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `exit2` → **honrada** — Stop fired 2 times (exit 2 once; the model continued and stopped again); stop_hook_active on the second: true; hook_response: outcome=success exit_code=0 *(run stop-exit2)*
- `decision:block` → **honrada** — Stop fired 2 times ({"decision":"block"} once); stop_hook_active on the second: true *(run stop-block)*
- `systemMessage` → **honrada** — marker PROBE_SYSMSG Stop appears 2 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*

### `StopFailure` — Claude Code

Disparou 5 vez(es) na(s) run(s) `fail-500`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `error`, `hook_event_name`, `last_assistant_message`, `prompt_id`, `session_id`, `transcript_path`.

Payload, verbatim (error: "authentication_failed"):

```json
{"session_id":"e175fdc4-0642-4929-adf4-f4d2b726fe67","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/e175fdc4-0642-4929-adf4-f4d2b726fe67.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"1403dcf9-1cdd-4834-a5f3-4e1fabdef016","hook_event_name":"StopFailure","error":"authentication_failed","last_assistant_message":"Failed to authenticate. API Error: 401 PROBE invalid credentials"}
```

Payload, verbatim (error: "rate_limit"):

```json
{"session_id":"9a7d2b2e-5b6d-4db8-b454-40ddd4c47b40","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/9a7d2b2e-5b6d-4db8-b454-40ddd4c47b40.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4298ce5d-a63c-4816-890d-1eeea7d5d0df","hook_event_name":"StopFailure","error":"rate_limit","last_assistant_message":"API Error: Server is temporarily limiting requests (not your usage limit) · PROBE rate limited"}
```

Payload, verbatim (error: "server_error"):

```json
{"session_id":"5189f5c3-682d-4a38-af63-21fa311293bb","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/5189f5c3-682d-4a38-af63-21fa311293bb.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"20cb75b2-493f-4666-817a-84c47154ca60","hook_event_name":"StopFailure","error":"server_error","last_assistant_message":"API Error: 500 PROBE internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:19200)."}
```

Gatilhos tentados:

- run fail-401: ANTHROPIC_BASE_URL at a Python-stdlib stub answering HTTP 401 (CLAUDE_CODE_MAX_RETRIES=0)
- run fail-429: ANTHROPIC_BASE_URL at a Python-stdlib stub answering HTTP 429 (CLAUDE_CODE_MAX_RETRIES=0)
- run fail-500: ANTHROPIC_BASE_URL at a Python-stdlib stub answering HTTP 500 (CLAUDE_CODE_MAX_RETRIES=0)
- run fail-529: ANTHROPIC_BASE_URL at a Python-stdlib stub answering HTTP 529 (CLAUDE_CODE_MAX_RETRIES=0)
- run unauth: a fresh CLAUDE_CONFIG_DIR with no login (Not logged in)

Respostas que o harness honrou:

- `observe` → **n/a** — HTTP 401 from the stub (1 request(s) to /v1/messages?beta=true) → StopFailure error=; Stop fired: 0; SessionEnd fired: 0 *(run fail-401)*
- `observe` → **n/a** — HTTP 429 from the stub (1 request(s) to /v1/messages?beta=true) → StopFailure error=; Stop fired: 0; SessionEnd fired: 1 *(run fail-429)*
- `observe` → **n/a** — HTTP 500 from the stub (1 request(s) to /v1/messages?beta=true) → StopFailure error=authentication_failed; Stop fired: 0; SessionEnd fired: 0 *(run fail-500)*
- `observe` → **n/a** — HTTP 529 from the stub (1 request(s) to /v1/messages?beta=true) → StopFailure error=; Stop fired: 0; SessionEnd fired: 0 *(run fail-529)*
- `observe` → **n/a** — unauthenticated temp config dir: StopFailure error=; events that fired: InstructionsLoaded MessageDisplay SessionStart UserPromptSubmit  *(run unauth)*

### `TeammateIdle` — Claude Code

**Não disparou no Claude Code 2.1.259 (Claude Code).** Gatilho tentado: run teams: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and a prompt asking for TeamCreate + one teammate going idle (reply: NO_TEAM_TOOL)

### `InstructionsLoaded` — Claude Code

Disparou 38 vez(es) na(s) run(s) `add-dir`, `additional-context`, `command`, `command-exit2`, `compact-auto`, `compact-manual`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `fail-401`, `fail-429`, `fail-500`, `fail-529`, `filechanged-cwd`, `filechanged-nested`, `model-switch`, `model-switch-exit2`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `prompt-exit2`, `setup-init`, `setup-maintenance`, `stop-block`, `stop-exit2`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `teams`, `tools`, `unauth`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `file_path`, `hook_event_name`, `load_reason`, `memory_type`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","hook_event_name":"InstructionsLoaded","file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/CLAUDE.md","memory_type":"Project","load_reason":"session_start"}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `systemMessage` → **não observável** — marker PROBE_SYSMSG InstructionsLoaded appears 0 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*
- `additionalContext` → **não honrada** — the model repeated 'PROBE_CTX InstructionsLoaded': no; the marker is in the transcript 0
0 time(s) (event fired in the run: 1 times) *(run additional-context)*

### `ConfigChange` — Claude Code

Disparou 2 vez(es) na(s) run(s) `config-change`, `config-change-exit2`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `file_path`, `hook_event_name`, `prompt_id`, `session_id`, `source`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"23d889d0-a993-443d-8c40-260d3d2d2180","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/23d889d0-a993-443d-8c40-260d3d2d2180.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"2df4e6ad-452e-4eda-a97c-4e395086d0a9","hook_event_name":"ConfigChange","source":"project_settings","file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.claude/settings.json"}
```

Gatilhos tentados:

- run config-change: the session's own Bash rewrites .claude/settings.json mid-session (jq adds a key), then sleeps 3s

Respostas que o harness honrou:

- `exit2` → **não observável** — hook_response: ; the file on disk keeps the edit (the block stops the reload, not the write): probeKey present = true *(run config-change-exit2)*

### `CwdChanged` — Claude Code

Disparou 2 vez(es) na(s) run(s) `filechanged-cwd`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `new_cwd`, `old_cwd`, `prompt_id`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/sub","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","hook_event_name":"CwdChanged","old_cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","new_cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/sub"}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `systemMessage` → **não observável** — marker PROBE_SYSMSG CwdChanged appears 0 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*

### `DirectoryAdded` — Claude Code

**Não disparou no Claude Code 2.1.259 (Claude Code).** Gatilho tentado: run add-dir: the /add-dir command in -p (answer: /add-dir isn't available in this environment.); run add-dir-control: an SDK control_request register_repo_root over stream-json stdin (response: "error")

### `FileChanged` — Claude Code

Disparou 6 vez(es) na(s) run(s) `filechanged-nested`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `event`, `file_path`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path`.

Payload, verbatim (file_path: "/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN.md"):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","hook_event_name":"FileChanged","file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/.leopold/PLAN.md","event":"change"}
```

Payload, verbatim (file_path: "/private/tmp/leopold-hookprobe.gjQnXe/claude-project/PLAN.md"):

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","hook_event_name":"FileChanged","file_path":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/PLAN.md","event":"change"}
```

Gatilhos tentados:

- run filechanged-cwd: the same wiring, with `cd sub` (CwdChanged) BEFORE the edits and the external append
- run filechanged-nested: the same two entries with NO PLAN.md in the project root — an Edit of .leopold/PLAN.md plus an append from another process
- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `observe` → **n/a** — two entries wired: matcher .leopold/PLAN.md (registers the watch) and matcher PLAN.md (receives); firings per entry and path:  2 matches=PLAN.md -> .leopold/PLAN.md; 2 matches=PLAN.md -> PLAN.md; — the session's own Edit and the other process's append produce payloads of the same shape (file_path + event), nothing in the payload tells them apart; the path-shaped entry never fires itself *(run tools)*
- `observe (after a cd in the session)` → **n/a** — after `cd sub` (CwdChanged) the same wiring fired 0 times for two Edits and one external append — a cwd change detaches the watches *(run filechanged-cwd)*
- `observe (no root PLAN.md)` → **n/a** — with no PLAN.md in the project root, FileChanged fired 2 times for .leopold/PLAN.md (Edit + external append):  2 .leopold/PLAN.md; *(run filechanged-nested)*

### `WorktreeCreate` — Claude Code

Disparou 2 vez(es) na(s) run(s) `worktree`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `name`, `prompt_id`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"cb14dfc0-a66d-486e-aeec-c0d6d37375c3","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/cb14dfc0-a66d-486e-aeec-c0d6d37375c3.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","hook_event_name":"WorktreeCreate","name":"probe-wt"}
```

Gatilhos tentados:

- run worktree: `claude -p --worktree probe-wt` in a git project (the hook creates the worktree and echoes its path — an empty answer aborts the session)

Respostas que o harness honrou:

- `worktree` → **honrada** — the session ran inside the path the hook echoed: yes; worktrees after the run: 2 *(run worktree)*

### `WorktreeRemove` — Claude Code

**Não disparou no Claude Code 2.1.259 (Claude Code).** Gatilho tentado: run worktree: the --worktree session exiting with a clean worktree; run worktree-agent: an Agent tool call with isolation worktree finishing

### `PreCompact` — Claude Code

Disparou 2 vez(es) na(s) run(s) `compact-auto`, `compact-manual`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `custom_instructions`, `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path`, `trigger`.

Payload, verbatim (trigger: "auto"):

```json
{"session_id":"8696992c-e252-4b26-aa6e-0f09b973a8fc","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/8696992c-e252-4b26-aa6e-0f09b973a8fc.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"b1988ab3-5c85-48da-81fd-b0bd3a241365","hook_event_name":"PreCompact","trigger":"auto","custom_instructions":null}
```

Payload, verbatim (trigger: "manual"):

```json
{"session_id":"ea4f4119-202c-4931-9721-72c83db1f7af","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/ea4f4119-202c-4931-9721-72c83db1f7af.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"5dc35203-ab1c-4bb5-900f-f1a67c33d899","hook_event_name":"PreCompact","trigger":"manual","custom_instructions":null}
```

Gatilhos tentados:

- run compact-auto: --autocompact 100000 and three full reads of a 120 KB file (CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000 + CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 fired both events too in the pilot)
- run compact-manual: `claude -p --resume <id> /compact`

Respostas que o harness honrou:

- `observe` → **n/a** — auto compaction: PreCompact fired 1 times, PostCompact 1 times; compact_boundary in the stream: {"trigger":"auto","pre_tokens":70493,"post_tokens":7859}; SessionStart fired again after each compaction (source: compact,startup,) *(run compact-auto)*
- `observe` → **n/a** — manual compaction via /compact on a resumed session: PreCompact 1, PostCompact 1 (trigger: manual) *(run compact-manual)*

### `PostCompact` — Claude Code

Disparou 2 vez(es) na(s) run(s) `compact-auto`, `compact-manual`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `compact_summary`, `cwd`, `hook_event_name`, `prompt_id`, `session_id`, `transcript_path`, `trigger`.

Payload, verbatim (trigger: "auto"):

```json
{"session_id":"8696992c-e252-4b26-aa6e-0f09b973a8fc","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/8696992c-e252-4b26-aa6e-0f09b973a8fc.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"b1988ab3-5c85-48da-81fd-b0bd3a241365","hook_event_name":"PostCompact","trigger":"auto","compact_summary":"<analysis>\nLet me carefully analyze this conversation chronologically:\n\n1. **Initial Setup**: The conversation begins with system context showing a git repository with branch \"main\" and some modified/untracked files (.leopold/PLAN.md, PLAN.md, .claude/settings.json files, probe-allow.txt).\n\n2. **User's Primary Request**: The user explicitly requests:\n   - Read big.txt (whole file, no offset/limit) three separate times, one call at a time\n   - Run Bash command: wc -c big.txt\n …[+4237 chars]"}
```

Payload, verbatim (trigger: "manual"):

```json
{"session_id":"ea4f4119-202c-4931-9721-72c83db1f7af","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/ea4f4119-202c-4931-9721-72c83db1f7af.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"5dc35203-ab1c-4bb5-900f-f1a67c33d899","hook_event_name":"PostCompact","trigger":"manual","compact_summary":"<analysis>\nThe conversation history is minimal and focused on two distinct requests:\n\n1. Initial Request (Message 1): The user asked me to read big.txt in its entirety and respond with \"DONE\".\n   - I executed this request using the Read tool\n   - The Read tool returned a partial view due to character limits (showing first 24527 of 120001 characters)\n   - The file contains what appears to be encoded or random string data\n\n2. Second Request (Current Message): The user is now as…[+3716 chars]"}
```

Gatilhos tentados:

- run compact-auto: --autocompact 100000 and three full reads of a 120 KB file (CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000 + CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 fired both events too in the pilot)
- run compact-manual: `claude -p --resume <id> /compact`

### `PreModelSwitch` — Claude Code

Disparou 2 vez(es) na(s) run(s) `model-switch`, `model-switch-exit2`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cache_ttl`, `context_tokens`, `cwd`, `estimated_cache_write_usd`, `from_model`, `hook_event_name`, `pricing`, `prompt_cache_warm`, `prompt_id`, `requested_model`, `session_id`, `source`, `to_model`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"1d5b76b2-f059-4f62-8a9d-48a0f9f6f1c9","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/1d5b76b2-f059-4f62-8a9d-48a0f9f6f1c9.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"3112dde5-323d-492f-aaf9-4843adb1d9af","hook_event_name":"PreModelSwitch","from_model":"claude-haiku-4-5-20251001","to_model":"claude-sonnet-5","requested_model":"sonnet","source":"command","context_tokens":0,"prompt_cache_warm":false,"cache_ttl":"1h","estimated_cache_write_usd":0,"pricing":"catalog"}
```

Gatilhos tentados:

- run model-switch: the /model sonnet command in a -p session started on haiku

Respostas que o harness honrou:

- `exit2` → **honrada** — PostModelSwitch fired 0 times after the block (0 = the switch did not happen); final: Model switch to Sonnet 5 was blocked by a PreModelSwitch hook: [bash /Users/jonhvmp/myspace/github/leopold/scripts/probe/dump-hook.sh PreModelSwitch --out /priv *(run model-switch-exit2)*

### `PostModelSwitch` — Claude Code

Disparou 1 vez(es) na(s) run(s) `model-switch`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cache_ttl`, `context_tokens`, `cwd`, `estimated_cache_write_usd`, `from_model`, `hook_event_name`, `pricing`, `prompt_cache_warm`, `prompt_id`, `requested_model`, `session_id`, `source`, `to_model`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"1d5b76b2-f059-4f62-8a9d-48a0f9f6f1c9","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/1d5b76b2-f059-4f62-8a9d-48a0f9f6f1c9.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project","prompt_id":"3112dde5-323d-492f-aaf9-4843adb1d9af","hook_event_name":"PostModelSwitch","from_model":"claude-haiku-4-5-20251001","to_model":"claude-sonnet-5","requested_model":"sonnet","source":"command","context_tokens":0,"prompt_cache_warm":false,"cache_ttl":"1h","estimated_cache_write_usd":0,"pricing":"catalog"}
```

Gatilhos tentados:

- run model-switch: the /model sonnet command in a -p session started on haiku

### `Elicitation` — Claude Code

**Não disparou no Claude Code 2.1.259 (Claude Code).** Gatilho tentado: run elicit-observe: a stdio MCP stub whose tool sends elicitation/create back to the client

Respostas que o harness honrou:

- `action:accept+content` → **não honrada** — the MCP server received the hook's answer: ; ElicitationResult fired: 0 (it fires only on the user/cancel path) *(run elicit-accept)*

### `ElicitationResult` — Claude Code

**Não disparou no Claude Code 2.1.259 (Claude Code).** Gatilho tentado: run elicit-observe: the same elicitation, unanswered by any hook, in a headless session (auto-cancelled)

Respostas que o harness honrou:

- `observe` → **n/a** — with no hook answer the headless session cancelled: action=; the MCP server received:  *(run elicit-observe)*

### `SessionEnd` — Claude Code

Disparou 34 vez(es) na(s) run(s) `add-dir`, `additional-context`, `command`, `command-exit2`, `compact-auto`, `compact-manual`, `compact-manual-seed`, `config-change`, `config-change-exit2`, `fail-429`, `filechanged-cwd`, `filechanged-nested`, `model-switch`, `model-switch-exit2`, `perm-allow`, `perm-auto`, `perm-deny`, `perm-host`, `posttool-block`, `pretool-deny`, `prompt-exit2`, `setup-init`, `setup-maintenance`, `stop-block`, `stop-exit2`, `subagent`, `subagent-exit2`, `system-message`, `tasks`, `tasks-exit2`, `teams`, `tools`, `worktree-agent`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `prompt_id`, `reason`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"777e68b4-1ad1-4f6c-9d81-64d0cae95a84","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-leopold-hookprobe-gjQnXe-claude-project/777e68b4-1ad1-4f6c-9d81-64d0cae95a84.jsonl","cwd":"/private/tmp/leopold-hookprobe.gjQnXe/claude-project/sub","prompt_id":"4c67eb26-a782-4cfe-8201-a875dc0f7985","hook_event_name":"SessionEnd","reason":"other"}
```

Gatilhos tentados:

- run tools: a headless `claude -p` turn in a project with a CLAUDE.md that runs `true`, `false`, `grep -c zzz /dev/null`, an Edit of .leopold/PLAN.md and of the root PLAN.md, `sleep 6` (the driver appends to both files from another process meanwhile), `cat` and, last, `cd sub && pwd`

Respostas que o harness honrou:

- `systemMessage` → **não observável** — marker PROBE_SYSMSG SessionEnd appears 0 times in the stream-json output (outside hook_response echoes:  5 informational;); in the transcript:  2 PROBE_SYSMSG PostToolBatch; 2 PROBE_SYSMSG PostToolUse; 2 PROBE_SYSMSG PreToolUse; 2 PROBE_SYSMSG SessionStart; 2 PROBE_SYSMSG Stop; 1 PROBE_SYSMSG UserPromptSubmit; *(run system-message)*

## Eventos — Codex CLI

### `SessionStart` — Codex CLI

Disparou 25 vez(es) na(s) run(s) `additional-context`, `compact`, `exec-as-role-4`, `fail-401`, `fail-429`, `fail-500`, `fail-529`, `interrupt`, `perm-allow`, `perm-deny`, `perm-onrequest`, `posttool-block`, `pretool-deny`, `prompt-exit2`, `role-bogus`, `role-bogus-strict`, `stop-block`, `stop-exit2`, `strict-config`, `subagent`, `subagent-exit2`, `subagent-role`, `system-message`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `source`, `transcript_path`.

Payload, verbatim (source: "startup"):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","source":"startup"}
```

Payload, verbatim (source: "compact"):

```json
{"session_id":"01a064f2-3530-7453-9e93-f1a7093bb39d","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-46-30-01a064f2-3530-7453-9e93-f1a7093bb39d.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","source":"compact"}
```

Gatilhos tentados:

- run tools: a headless `codex exec` turn in a project with an AGENTS.md that runs `true`, `false`, `grep -c zzz /dev/null`, an apply_patch edit of .leopold/PLAN.md, `sleep 6` (the driver appends to .leopold/PLAN.md from another process meanwhile) and `cat`

Respostas que o harness honrou:

- `systemMessage` → **não observável** — marker PROBE_SYSMSG SessionStart in the --json stream: 0 times; in the rollout transcript: 0
0 times *(run system-message)*
- `additionalContext` → **não honrada** — the model repeated 'PROBE_CTX SessionStart': no *(run additional-context)*
- `--strict-config with the probe's hook block` → **n/a** — rc=0; the hook wiring the shared writer emits passes --strict-config: yes *(run strict-config)*

### `SessionEnd` — Codex CLI

Disparou 24 vez(es) na(s) run(s) `additional-context`, `compact`, `exec-as-role-4`, `fail-401`, `fail-429`, `fail-500`, `fail-529`, `interrupt`, `perm-allow`, `perm-deny`, `perm-onrequest`, `posttool-block`, `pretool-deny`, `prompt-exit2`, `role-bogus`, `role-bogus-strict`, `stop-block`, `stop-exit2`, `strict-config`, `subagent`, `subagent-exit2`, `subagent-role`, `system-message`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `reason`, `session_id`, `transcript_path`.

Payload, verbatim:

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"SessionEnd","reason":"other"}
```

Gatilhos tentados:

- run tools: a headless `codex exec` turn in a project with an AGENTS.md that runs `true`, `false`, `grep -c zzz /dev/null`, an apply_patch edit of .leopold/PLAN.md, `sleep 6` (the driver appends to .leopold/PLAN.md from another process meanwhile) and `cat`

Respostas que o harness honrou:

- `systemMessage` → **não observável** — marker PROBE_SYSMSG SessionEnd in the --json stream: 0 times; in the rollout transcript: 0
0 times *(run system-message)*

### `SubagentStart` — Codex CLI

Disparou 3 vez(es) na(s) run(s) `subagent`, `subagent-exit2`, `subagent-role`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `agent_id`, `agent_type`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `transcript_path`, `turn_id`.

Payload, verbatim (agent_type: "default"):

```json
{"session_id":"01a064ef-43f8-7a31-a2c4-e372c36fb4bd","turn_id":"01a064ef-557b-76b3-b60f-c3e732663d6c","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-43-21-01a064ef-556c-7670-a0f2-9f6a2fe2c42a.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"SubagentStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","agent_id":"01a064ef-556c-7670-a0f2-9f6a2fe2c42a","agent_type":"default"}
```

Payload, verbatim (agent_type: "probe-reviewer"):

```json
{"session_id":"01a064ef-8fc9-7782-b75b-cfdcb7ee8a12","turn_id":"01a064ef-af79-77d2-99ca-62914c6c39a4","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-43-44-01a064ef-af6b-73a1-b2d6-9d4f09708e5d.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"SubagentStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","agent_id":"01a064ef-af6b-73a1-b2d6-9d4f09708e5d","agent_type":"probe-reviewer"}
```

Gatilhos tentados:

- run subagent-role: spawn_agent with agent_type probe-reviewer (.codex/agents/probe-reviewer.toml)
- run subagent: spawn_agent (default role) + wait_agent

Respostas que o harness honrou:

- `observe` → **n/a** — spawn tool name as seen by PreToolUse: collaborationspawn_agent; SubagentStop carries agent_transcript_path: true *(run subagent)*
- `role file` → **honrada** — agent_type in SubagentStart: probe-reviewer; the role's fixed reply came back: yes *(run subagent-role)*
- `role file with an unknown key` → **n/a** — without --strict-config: Ignoring malformed agent role definition: failed to deserialize agent role file at /tmp/leopold-hookprobe.gjQnXe/codex-project/.codex/agents/bogus.toml: unknown field `bogus_key`  ; reply: unknown agent_type 'bogus' *(run role-bogus)*
- `role file with an unknown key (--strict-config)` → **n/a** — with --strict-config: Ignoring malformed agent role definition: failed to deserialize agent role file at /tmp/leopold-hookprobe.gjQnXe/codex-project/.codex/agents/bogus.toml: unknown field `bogus_key`  ; reply: unknown agent_type 'bogus' *(run role-bogus-strict)*
- `codex exec -c agent_role="probe-reviewer"` → **n/a** — rc=1; reply: ; stderr: Error loading config.toml: unknown configuration field `agent_role` in -c/--config override  *(run exec-as-role-1)*
- `codex exec -c agent_type="probe-reviewer"` → **n/a** — rc=1; reply: ; stderr: Error loading config.toml: unknown configuration field `agent_type` in -c/--config override  *(run exec-as-role-2)*
- `codex exec -c role="probe-reviewer"` → **n/a** — rc=1; reply: ; stderr: Error loading config.toml: unknown configuration field `role` in -c/--config override  *(run exec-as-role-3)*
- `codex exec -c agents.probe-reviewer.config_file=".codex/agents/probe-reviewer.toml"` → **n/a** — rc=0; reply: NO_ROLE; stderr:  *(run exec-as-role-4)*
- `codex exec -p <role file as profile>` → **n/a** — rc=1; stderr: Error loading config.toml: /private/tmp/leopold-hookprobe.gjQnXe/codex-home/probe-reviewer.config.toml:1:1: unknown configuration field `name`  *(run exec-as-role-profile)*

### `SubagentStop` — Codex CLI

Disparou 4 vez(es) na(s) run(s) `subagent`, `subagent-exit2`, `subagent-role`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `agent_id`, `agent_transcript_path`, `agent_type`, `cwd`, `hook_event_name`, `last_assistant_message`, `model`, `permission_mode`, `session_id`, `stop_hook_active`, `transcript_path`, `turn_id`.

Payload, verbatim (stop_hook_active: false):

```json
{"session_id":"01a064ef-43f8-7a31-a2c4-e372c36fb4bd","turn_id":"01a064ef-557b-76b3-b60f-c3e732663d6c","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-43-17-01a064ef-43f8-7a31-a2c4-e372c36fb4bd.jsonl","agent_transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-43-21-01a064ef-556c-7670-a0f2-9f6a2fe2c42a.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"SubagentStop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":false,"agent_id":"01a064ef-556c-7670-a0f2-9f6a2fe2c42a","agent_type":"default","last_assistant_message":"PONG"}
```

Payload, verbatim (stop_hook_active: true):

```json
{"session_id":"01a064f0-23a6-7082-a96c-4b3b8175e81b","turn_id":"01a064f0-35b9-7352-bbc3-b7de53c28f04","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-44-14-01a064f0-23a6-7082-a96c-4b3b8175e81b.jsonl","agent_transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-44-19-01a064f0-35ac-77d1-9871-fd30fa81b96c.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"SubagentStop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":true,"agent_id":"01a064f0-35ac-77d1-9871-fd30fa81b96c","agent_type":"default","last_assistant_message":"PONG"}
```

Gatilhos tentados:

- run subagent: spawn_agent (default role) + wait_agent

Respostas que o harness honrou:

- `exit2` → **honrada** — SubagentStop fired 2 times (exit 2 once); stop_hook_active on the second: true *(run subagent-exit2)*

### `PreToolUse` — Codex CLI

Disparou 29 vez(es) na(s) run(s) `additional-context`, `compact`, `interrupt`, `perm-allow`, `perm-deny`, `perm-onrequest`, `posttool-block`, `pretool-deny`, `role-bogus`, `role-bogus-strict`, `subagent`, `subagent-exit2`, `subagent-role`, `system-message`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`, `turn_id`.

Payload, verbatim (Bash: {"command":"true"}):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PreToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"true"},"tool_use_id":"exec-c858a358-22fb-46df-92ea-98636929adb5"}
```

Payload, verbatim (Bash: {"command":"false"}):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PreToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"false"},"tool_use_id":"exec-dcaa043b-6d5e-4e48-9fa5-c4aee89bc754"}
```

Payload, verbatim (Bash: {"command":"grep -c zzz /dev/null"}):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PreToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"grep -c zzz /dev/null"},"tool_use_id":"exec-16f28f82-27fc-422d-ac03-8261b9f48361"}
```

Payload, verbatim (apply_patch: {"command":"*** Begin Patch\n*** Update File: /tmp/leopold-hookprobe.gjQnXe/code):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PreToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: /tmp/leopold-hookprobe.gjQnXe/codex-project/.leopold/PLAN.md\n@@\n-- [ ] item one\n+- [ ] item one (edited)\n*** End Patch"},"tool_use_id":"exec-c46dd3f8-1a63-4260-94b3-ca57ce5579f6"}
```

Gatilhos tentados:

- run tools: a headless `codex exec` turn in a project with an AGENTS.md that runs `true`, `false`, `grep -c zzz /dev/null`, an apply_patch edit of .leopold/PLAN.md, `sleep 6` (the driver appends to .leopold/PLAN.md from another process meanwhile) and `cat`

Respostas que o harness honrou:

- `permissionDecision:deny` → **honrada** — PostToolUse fired 0 times after the deny (0 = the tool never ran); reason reached the model: yes *(run pretool-deny)*
- `systemMessage` → **não observável** — marker PROBE_SYSMSG PreToolUse in the --json stream: 0 times; in the rollout transcript: 0
0 times *(run system-message)*
- `additionalContext` → **não honrada** — the model repeated 'PROBE_CTX PreToolUse': no *(run additional-context)*

### `PermissionRequest` — Codex CLI

Disparou 1 vez(es) na(s) run(s) `perm-deny`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `transcript_path`, `turn_id`.

Payload, verbatim:

```json
{"session_id":"01a064f1-6f6f-75e1-bc35-e4fb8d06d50d","turn_id":"01a064f1-6fb2-7720-9805-3bb26d504576","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-45-39-01a064f1-6f6f-75e1-bc35-e4fb8d06d50d.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PermissionRequest","model":"gpt-5.6-sol","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"curl -sI https://example.com | head -1","description":"The sandboxed command returned no output, consistent with curl’s silent mode hiding a network-access failure. Allow this exact command to run once with network access?"}}
```

Gatilhos tentados:

- run perm-allow: --approve-for-me and a curl that needs network escalation out of the workspace-write sandbox
- run perm-onrequest: -s workspace-write -c approval_policy="on-request" and the same curl (fired: 0 times)

Respostas que o harness honrou:

- `decision:allow` → **não honrada** — the escalated curl ran (an HTTP status line came back): no; PermissionRequest fired: 0 *(run perm-allow)*
- `decision:deny` → **honrada** — the deny message reached the model: yes; an HTTP status line came back: no; stderr: Rejected(\"PROBE_DENY\") *(run perm-deny)*
- `decision:allow (approval_policy=on-request)` → **não honrada** — under approval_policy=on-request in headless exec the hook fired 0 times; reply:  *(run perm-onrequest)*

### `PostToolUse` — Codex CLI

Disparou 24 vez(es) na(s) run(s) `additional-context`, `compact`, `perm-allow`, `perm-deny`, `perm-onrequest`, `posttool-block`, `subagent`, `subagent-exit2`, `subagent-role`, `system-message`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path`, `turn_id`.

Payload, verbatim (Bash: {"command":"true"}):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PostToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"true"},"tool_response":"","tool_use_id":"exec-c858a358-22fb-46df-92ea-98636929adb5"}
```

Payload, verbatim (Bash: {"command":"false"}):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PostToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"false"},"tool_response":"","tool_use_id":"exec-dcaa043b-6d5e-4e48-9fa5-c4aee89bc754"}
```

Payload, verbatim (Bash: {"command":"grep -c zzz /dev/null"}):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PostToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"grep -c zzz /dev/null"},"tool_response":"0\n","tool_use_id":"exec-16f28f82-27fc-422d-ac03-8261b9f48361"}
```

Payload, verbatim (apply_patch: {"command":"*** Begin Patch\n*** Update File: /tmp/leopold-hookprobe.gjQnXe/code):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PostToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: /tmp/leopold-hookprobe.gjQnXe/codex-project/.leopold/PLAN.md\n@@\n-- [ ] item one\n+- [ ] item one (edited)\n*** End Patch"},"tool_response":"Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM /tmp/leopold-hookprobe.gjQnXe/codex-project/.leopold/PLAN.md\n","tool_use_id":"exec-c46dd3f8-1a63-4260-94b3-ca57ce5579f6"}
```

Gatilhos tentados:

- run tools: a headless `codex exec` turn in a project with an AGENTS.md that runs `true`, `false`, `grep -c zzz /dev/null`, an apply_patch edit of .leopold/PLAN.md, `sleep 6` (the driver appends to .leopold/PLAN.md from another process meanwhile) and `cat`

Respostas que o harness honrou:

- `observe` → **n/a** — Bash `true`: tool_response=""; Bash `false`: PostToolUse fired yes with tool_response="" — no exit code in either; PreToolUse calls without a PostToolUse in the run: 0 (failed apply_patch attempts); edit tool name: apply_patch, *(run tools)*
- `decision:block` → **honrada** — the reason PROBE_BLOCK reached the model/stream: yes; reply: ``` *(run posttool-block)*
- `systemMessage` → **não observável** — marker PROBE_SYSMSG PostToolUse in the --json stream: 0 times; in the rollout transcript: 0
0 times *(run system-message)*
- `additionalContext` → **honrada** — the model repeated 'PROBE_CTX PostToolUse': yes *(run additional-context)*

### `PreCompact` — Codex CLI

Disparou 1 vez(es) na(s) run(s) `compact`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `session_id`, `transcript_path`, `trigger`, `turn_id`.

Payload, verbatim:

```json
{"session_id":"01a064f2-3530-7453-9e93-f1a7093bb39d","turn_id":"01a064f2-3555-7173-9583-c58b54a53f71","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-46-30-01a064f2-3530-7453-9e93-f1a7093bb39d.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PreCompact","model":"gpt-5.6-sol","trigger":"auto"}
```

Gatilhos tentados:

- run compact: -c model_auto_compact_token_limit=6000 and three full cats of a 120 KB file

Respostas que o harness honrou:

- `observe` → **n/a** — auto compaction: PreCompact fired 1 times, PostCompact 1 times (trigger: auto) *(run compact)*

### `PostCompact` — Codex CLI

Disparou 1 vez(es) na(s) run(s) `compact`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `session_id`, `transcript_path`, `trigger`, `turn_id`.

Payload, verbatim:

```json
{"session_id":"01a064f2-3530-7453-9e93-f1a7093bb39d","turn_id":"01a064f2-3555-7173-9583-c58b54a53f71","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-46-30-01a064f2-3530-7453-9e93-f1a7093bb39d.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"PostCompact","model":"gpt-5.6-sol","trigger":"auto"}
```

Gatilhos tentados:

- run compact: -c model_auto_compact_token_limit=6000 and three full cats of a 120 KB file

### `UserPromptSubmit` — Codex CLI

Disparou 24 vez(es) na(s) run(s) `additional-context`, `compact`, `exec-as-role-4`, `fail-401`, `fail-429`, `fail-500`, `fail-529`, `interrupt`, `perm-allow`, `perm-deny`, `perm-onrequest`, `posttool-block`, `pretool-deny`, `prompt-exit2`, `role-bogus`, `role-bogus-strict`, `stop-block`, `stop-exit2`, `strict-config`, `subagent`, `subagent-exit2`, `subagent-role`, `system-message`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `permission_mode`, `prompt`, `session_id`, `transcript_path`, `turn_id`.

Payload, verbatim:

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"UserPromptSubmit","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","prompt":"Do these steps in order with tools, one tool call per step: 1) run the shell command: true  2) run the shell command: false (it fails; continue)  3) run: grep -c zzz /dev/null (exit 1; continue)  4) edit the file .leopold/PLAN.md with your file-edit tool so 'item one' becomes 'item one (edited)' (keep the leading '- [ ] ')  5) run the shell command: sleep 6  6) run: cat .leopold/PLAN.md. Then reply with the single word DONE."}
```

Gatilhos tentados:

- run tools: a headless `codex exec` turn in a project with an AGENTS.md that runs `true`, `false`, `grep -c zzz /dev/null`, an apply_patch edit of .leopold/PLAN.md, `sleep 6` (the driver appends to .leopold/PLAN.md from another process meanwhile) and `cat`

Respostas que o harness honrou:

- `exit2` → **honrada** — the model answered the prompt: no; Stop fired: 0; errors:  *(run prompt-exit2)*
- `systemMessage` → **não observável** — marker PROBE_SYSMSG UserPromptSubmit in the --json stream: 0 times; in the rollout transcript: 0
0 times *(run system-message)*
- `additionalContext` → **não honrada** — the model repeated 'PROBE_CTX UserPromptSubmit': no *(run additional-context)*

### `Stop` — Codex CLI

Disparou 20 vez(es) na(s) run(s) `additional-context`, `compact`, `exec-as-role-4`, `perm-allow`, `perm-deny`, `perm-onrequest`, `posttool-block`, `pretool-deny`, `role-bogus`, `role-bogus-strict`, `stop-block`, `stop-exit2`, `strict-config`, `subagent`, `subagent-exit2`, `subagent-role`, `system-message`, `tools`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `last_assistant_message`, `model`, `permission_mode`, `session_id`, `stop_hook_active`, `transcript_path`, `turn_id`.

Payload, verbatim (stop_hook_active: false):

```json
{"session_id":"01a064ee-a7c6-7af3-872f-dd265be1acc2","turn_id":"01a064ee-a831-76d0-bfad-138dcf2efcf2","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-42-37-01a064ee-a7c6-7af3-872f-dd265be1acc2.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"Stop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":false,"last_assistant_message":"DONE"}
```

Payload, verbatim (stop_hook_active: true):

```json
{"session_id":"01a064f0-7715-7743-bfbe-b516cf211385","turn_id":"01a064f0-773e-79d1-b5fc-d8d705d614ca","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-44-35-01a064f0-7715-7743-bfbe-b516cf211385.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"Stop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":true,"last_assistant_message":"FIRST_STOP"}
```

Gatilhos tentados:

- run fail-401: a custom model provider whose base_url is a Python-stdlib stub answering HTTP 401 (the turn fails; which hooks fire?)
- run fail-429: a custom model provider whose base_url is a Python-stdlib stub answering HTTP 429 (the turn fails; which hooks fire?)
- run fail-500: a custom model provider whose base_url is a Python-stdlib stub answering HTTP 500 (the turn fails; which hooks fire?)
- run fail-529: a custom model provider whose base_url is a Python-stdlib stub answering HTTP 529 (the turn fails; which hooks fire?)
- run tools: a headless `codex exec` turn in a project with an AGENTS.md that runs `true`, `false`, `grep -c zzz /dev/null`, an apply_patch edit of .leopold/PLAN.md, `sleep 6` (the driver appends to .leopold/PLAN.md from another process meanwhile) and `cat`

Respostas que o harness honrou:

- `exit2` → **honrada** — Stop fired 2 times (exit 2 once); stop_hook_active on the second: true; messages: 2 *(run stop-exit2)*
- `decision:block` → **honrada** — Stop fired 2 times ({"decision":"block"} once); stop_hook_active on the second: true *(run stop-block)*
- `systemMessage` → **não observável** — marker PROBE_SYSMSG Stop in the --json stream: 0 times; in the rollout transcript: 0
0 times *(run system-message)*
- `observe (API failure HTTP 401)` → **n/a** — HTTP 401 from the stub (3 request(s):  1 /v1/models; 2 /v1/responses;) → stream:  1 error; 4 item.completed; 1 thread.started; 1 turn.failed; 1 turn.started;; hooks that fired: SessionEnd SessionStart UserPromptSubmit ; error: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again. Your access token co *(run fail-401)*
- `observe (API failure HTTP 429)` → **n/a** — HTTP 429 from the stub (2 request(s):  1 /v1/models; 1 /v1/responses;) → stream:  1 error; 4 item.completed; 1 thread.started; 1 turn.failed; 1 turn.started;; hooks that fired: SessionEnd SessionStart UserPromptSubmit ; error: exceeded retry limit, last status: 429 Too Many Requests exceeded retry limit, last status: 429 Too Many Requests  *(run fail-429)*
- `observe (API failure HTTP 500)` → **n/a** — HTTP 500 from the stub (2 request(s):  1 /v1/models; 1 /v1/responses;) → stream:  1 error; 4 item.completed; 1 thread.started; 1 turn.failed; 1 turn.started;; hooks that fired: SessionEnd SessionStart UserPromptSubmit ; error: We're currently experiencing high demand, which may cause temporary errors. We're currently experiencing high demand, which may cause tempor *(run fail-500)*
- `observe (API failure HTTP 529)` → **n/a** — HTTP 529 from the stub (2 request(s):  1 /v1/models; 1 /v1/responses;) → stream:  1 error; 4 item.completed; 1 thread.started; 1 turn.failed; 1 turn.started;; hooks that fired: SessionEnd SessionStart UserPromptSubmit ; error: unexpected status 529 <unknown status code>: PROBE overloaded, url: http://127.0.0.1:19429/v1/responses unexpected status 529 <unknown statu *(run fail-529)*

### `Interrupt` — Codex CLI

Disparou 1 vez(es) na(s) run(s) `interrupt`. `hook_event_name`: present; `session_id`: present. Chaves do payload: `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `transcript_path`, `turn_id`.

Payload, verbatim:

```json
{"session_id":"01a064f2-7877-7f72-8286-b141dc83d8b0","turn_id":"01a064f2-789f-7081-8c7d-352f750ce929","transcript_path":"/private/tmp/leopold-hookprobe.gjQnXe/codex-home/sessions/2026/09/02/rollout-2026-09-02T22-46-47-01a064f2-7877-7f72-8286-b141dc83d8b0.jsonl","cwd":"/tmp/leopold-hookprobe.gjQnXe/codex-project","hook_event_name":"Interrupt","model":"gpt-5.6-sol","permission_mode":"bypassPermissions"}
```

Gatilhos tentados:

- run interrupt: SIGINT to the codex exec process while its shell command sleeps

Respostas que o harness honrou:

- `observe` → **n/a** — after SIGINT: Interrupt fired 1, Stop fired 0, SessionEnd fired 1 *(run interrupt)*

## Conclusões

- **Todo evento que uma sessão headless consegue alcançar dispara no Claude Code 2.1.259 (Claude Code), no `.claude/settings.json` do próprio projeto, com o mesmo prefixo `session_id`/`transcript_path`/`cwd`.** Os que não dispararam não têm gatilho headless nesta versão: `PermissionDenied` (o modo auto nega sem consultá-lo), `TeammateIdle` (sem ferramenta `TeamCreate` no `-p`), `DirectoryAdded` (`/add-dir` não existe no `-p` e o control request `register_repo_root` responde como registrado), `Notification` (nada pergunta numa sessão headless) e `WorktreeRemove` (a saída da sessão `--worktree` não o chamou) — cada linha abaixo nomeia o gatilho tentado.
- **A maioria dos comandos Bash que falham não chega ao `PostToolUse` no Claude Code — e os que chegam não são sucessos.** Exit 0 dispara `PostToolUse` com `tool_response.{stdout,stderr,interrupted}` e sem código de saída; exit diferente de zero normalmente dispara `PostToolUseFailure`, cujo `error` é a string `"Exit code 1"` (mais `is_interrupt`). A exceção está nesta mesma captura: `grep -c zzz /dev/null`, que sai com 1, chegou ao `PostToolUse` carregando `returnCodeInterpretation: "No matches found"` — o harness reinterpreta um conjunto de exits não-zero como "não é erro" e os anota em vez de mandá-los ao evento de falha. Então quem decide é o OBJETO de resposta, não o evento: `returnCodeInterpretation` (um não-zero reinterpretado), `interrupted` (cortado no meio) e `backgroundTaskId` (lançado, não terminado) significam, cada um, que o comando não saiu limpo com 0. O Codex dispara `PostToolUse` nos dois casos, com `tool_response` como string e **sem código de saída** em nenhum deles — um gate de evidência de conclusão precisa ler o resultado do comando do próprio registro, nunca do payload do hook.
- **`FileChanged` não distingue a edição da própria sessão de uma escrita de outro processo, e o matcher faz dois trabalhos.** Tanto a ferramenta `Edit` quanto um append externo produzem o mesmo payload `{file_path, event: "change"}`; a correlação tem de ser um `PostToolUse` no mesmo caminho no mesmo instante. O matcher *registra* um watch como caminho literal relativo à raiz do projeto (`PLAN.md`, `.leopold/PLAN.md`) e *despacha* pelo basename do arquivo alterado (`PLAN.md`, `*`) — então um arquivo aninhado precisa de duas entradas, uma em forma de caminho que nunca dispara sozinha e uma em forma de basename que recebe (runs `tools`, `filechanged-nested`); `PLAN.md|.envrc` não registra nada, e um `cd` na sessão (`CwdChanged`) desliga todos os watches (run `filechanged-cwd`). Hooks de `FileChanged` rodam fora do turno: nunca aparecem como `hook_started` no stream.
- **A ferramenta de edição do Codex é `apply_patch`** (`tool_input.command` carrega o patch), o shell dele é reportado como `Bash`, e as ferramentas multi-agente chegam ao `PreToolUse` como `collaborationspawn_agent` / `collaborationwait_agent`. Um arquivo de role em `.codex/agents/<role>.toml` (`name`, `description`, `developer_instructions` e qualquer chave do `config.toml`) é honrado por `spawn_agent(agent_type=<role>)`; uma chave desconhecida faz o Codex ignorar o arquivo com um `Ignoring malformed agent role definition` logado (com e sem `--strict-config`). **`codex exec` não roda *como* uma role:** `agent_role`, `agent_type` e `role` são rejeitados como campos de config desconhecidos, um arquivo de role não é uma camada `--profile` válida, e `agents.<name>.config_file` só declara a role para spawn.
- **Exit 2 é honrado onde os docs dizem, nos dois harnesses:** `TaskCompleted` (a task fica pendente), `UserPromptSubmit` e `UserPromptExpansion` (o prompt nunca chega ao modelo), `Stop` / `SubagentStop` (o agente continua e para de novo com `stop_hook_active: true`), `PreModelSwitch` (nenhum `PostModelSwitch` segue). `{"decision":"block"}` no `Stop` faz o mesmo nos dois. **O `ConfigChange` é o único exit 2 que esta página não consegue julgar:** um hook de `ConfigChange` nunca chega ao stream — sem `hook_started`, sem `hook_response`, logo sem exit code — e o arquivo manter a edição é verdade tendo o reload sido bloqueado ou adotado, e é por isso que a linha dele diz `unobservable`. Foi medido à parte, por efeito colateral (uma reescrita dos settings que acrescenta um hook, contra uma run de controle), em [ConfigChange exit 2 — Verificação ao vivo](config-reload-block.pt-BR.md): o reload É bloqueado e o arquivo MANTÉM a edição.
- **`PermissionRequest` precisa que exista um caminho de decisão.** No Claude Code dispara sob `--permission-prompts none` (e um CLI `-p` comum com o `host` padrão nega sem consultá-lo); `decision.behavior` allow/deny é honrado (allow roda a ferramenta, deny devolve a mensagem ao modelo). No Codex dispara sob `--approve-for-me` para uma escalação do sandbox (rede), com o mesmo contrato `decision.behavior` honrado (`Rejected("PROBE_DENY")` no stream); `approval_policy="on-request"` no `exec` headless nunca pergunta.
- **Um erro de API é um `StopFailure` no Claude Code e um `turn.failed` simples no Codex.** `ANTHROPIC_BASE_URL` no stub com `CLAUDE_CODE_MAX_RETRIES=0` disparou `StopFailure` para toda classe, com `error` (não `error_type`): `rate_limit` para 429, `server_error` para 500 *e* 529, `authentication_failed` para 401 e para login ausente; `Stop` não dispara e `SessionEnd` ainda dispara. O Codex não tem hook de falha: o stub de provider terminou cada turno com `turn.failed`, e só `SessionStart`, `UserPromptSubmit` e `SessionEnd` dispararam — sem `Stop`, sem `Interrupt`.
- **Compactação dispara `PreCompact`/`PostCompact` nos dois**, com `trigger` (`auto` / `manual`); o Claude Code acrescenta `custom_instructions` antes e o `compact_summary` completo depois, e então dispara `SessionStart` com `source: "compact"`; o stream carrega um `compact_boundary` com `pre_tokens`/`post_tokens`. Os payloads do Codex carregam `turn_id` e `model` e nada sobre o resumo.
- **`Interrupt` é real no Codex:** SIGINT no `codex exec` no meio de um comando o dispara (sem `Stop`), depois `SessionEnd`. O Codex limita os timeouts dos hooks de `SessionEnd` e `Interrupt` a 3 s (`clamping … hook timeout to 3s` no stream) — um hook nesses eventos precisa ser rápido.
- **O processo do hook herda o ambiente do pai nos dois harnesses** (`CODEX_HOME` chegou ao hook; o Claude Code acrescenta `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_CODE_ENTRYPOINT`; o Codex não acrescenta nada seu), e `hook_event_name` e `session_id` estavam presentes em todo payload capturado dos dois harnesses — um hook pode confiar neles, e o fallback nome-por-argumento do dump hook nunca precisou agir.

## O que isto decide para o Leopold

- Toda capacidade da missão desta run é plugada só em eventos capturados acima, com os campos de payload que as capturas mostram; um campo que o probe não capturou manda o item de volta ao probe, nunca a um palpite.
- Onde o Codex não tem o evento (`StopFailure`, `PostToolUseFailure`, `TaskCompleted`, `FileChanged`, `ConfigChange`), a capacidade sai no Claude Code com o substituto do Codex que as capturas permitem — `PostToolUse` mais a edição do PLAN.md para evidência de conclusão, `turn.failed` no stream `--json` para erros de API — e o `leopold doctor` nomeia o que o Codex não consegue, citando a versão que esta página registra.
- Os hooks de `Interrupt` e `SessionEnd` no Codex ficam abaixo de 3 s; um hook que precise fazer mais registra a intenção e deixa o turno seguinte terminar.

## Runs

| Harness | Run | rc | s | Comando |
| --- | --- | --- | --- | --- |
| claude | `tools` | 0 | 38 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `filechanged-cwd` | 0 | 30 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `filechanged-nested` | 0 | 16 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `tasks` | 0 | 11 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `tasks-exit2` | 0 | 11 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `subagent` | 0 | 11 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `subagent-exit2` | 0 | 14 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `config-change` | 0 | 9 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `config-change-exit2` | 0 | 8 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `command` | 0 | 2 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `command-exit2` | 0 | 1 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `prompt-exit2` | 0 | 1 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `stop-exit2` | 0 | 7 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `stop-block` | 0 | 5 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `posttool-block` | 0 | 6 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `pretool-deny` | 0 | 5 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `perm-allow` | 0 | 6 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-prompts none` |
| claude | `perm-deny` | 0 | 6 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-prompts none` |
| claude | `perm-host` | 0 | 7 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose ` |
| claude | `perm-auto` | 0 | 8 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode auto` |
| claude | `system-message` | 0 | 4 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `additional-context` | 0 | 8 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `compact-auto` | 0 | 37 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `compact-manual-seed` | 0 | 6 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `compact-manual` | 0 | 19 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `fail-401` | 1 | 0 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `fail-429` | 1 | 1 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `fail-500` | 1 | 1 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `fail-529` | 1 | 0 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `elicit-observe` | 1 | 0 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `elicit-accept` | 1 | 0 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `worktree` | 0 | 4 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `worktree-agent` | 0 | 10 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `setup-init` | 0 | 3 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `setup-maintenance` | 0 | 3 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `model-switch` | 0 | 1 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `model-switch-exit2` | 0 | 1 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `add-dir` | 0 | 1 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `add-dir-control` | 0 | 0 | `claude -p --input-format stream-json (control_request register_repo_root directory=/tmp/leopold-hookprobe.gjQnXe/extra-dir)` |
| claude | `teams` | 0 | 5 | `claude -p --setting-sources project --strict-mcp-config --model haiku --output-format stream-json --include-hook-events --verbose --permission-mode bypassPermis` |
| claude | `unauth` | 1 | 0 | `CLAUDE_CONFIG_DIR=<temp> claude -p --setting-sources project --model haiku --permission-mode bypassPermissions` |
| codex | `tools` | 0 | 40 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `subagent` | 0 | 19 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `subagent-role` | 0 | 16 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `role-bogus` | 0 | 10 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `role-bogus-strict` | 0 | 11 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox --strict-config` |
| codex | `subagent-exit2` | 0 | 21 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `stop-exit2` | 0 | 12 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `stop-block` | 0 | 12 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `prompt-exit2` | 0 | 4 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `posttool-block` | 0 | 12 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `pretool-deny` | 0 | 11 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `perm-allow` | 0 | 12 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --approve-for-me` |
| codex | `perm-deny` | 0 | 18 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --approve-for-me` |
| codex | `perm-onrequest` | 0 | 12 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> -s workspace-write -c approval_policy="on-request"` |
| codex | `system-message` | 0 | 8 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `additional-context` | 0 | 12 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox` |
| codex | `compact` | 0 | 16 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox -c model_auto_compact_token_limi` |
| codex | `interrupt` | 1 | 8 | `codex exec … (SIGINT sent to the process after PreToolUse of sleep 20)` |
| codex | `fail-401` | 1 | 2 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox -c model_provider="probe" -c mod` |
| codex | `fail-429` | 1 | 1 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox -c model_provider="probe" -c mod` |
| codex | `fail-500` | 1 | 2 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox -c model_provider="probe" -c mod` |
| codex | `fail-529` | 1 | 1 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox -c model_provider="probe" -c mod` |
| codex | `exec-as-role-1` | 1 | 0 | `codex exec --strict-config -c agent_role="probe-reviewer"` |
| codex | `exec-as-role-2` | 1 | 0 | `codex exec --strict-config -c agent_type="probe-reviewer"` |
| codex | `exec-as-role-3` | 1 | 0 | `codex exec --strict-config -c role="probe-reviewer"` |
| codex | `exec-as-role-4` | 0 | 0 | `codex exec --strict-config -c agents.probe-reviewer.config_file=".codex/agents/probe-reviewer.toml"` |
| codex | `exec-as-role-profile` | 1 | 0 | `codex exec --strict-config -p probe-reviewer (the role file copied as CODEX_HOME/probe-reviewer.config.toml)` |
| codex | `strict-config` | 0 | 6 | `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -C <project> --dangerously-bypass-approvals-and-sandbox --strict-config` |

## Hermeticidade

Toda escrita caiu sob a raiz `mktemp -d` (`/tmp/leopold-hookprobe.gjQnXe`), sob `<out>`, ou nos diretórios de transcript dos próprios harnesses para aquele projeto temporário. Os fingerprints de nomes de entrada de `~/.claude` e `~/.codex` reais foram idênticos antes e depois (inalterado / MUDOU); o `auth.json` copiado para o `CODEX_HOME` temporário foi apagado ao fim do probe. Para repetir: `bash scripts/probe-hook-events.sh --out <dir>` (nunca faz parte do `make test`; `make hooks-check` faz o lint).

<!-- @emit hook_events_probed=claude:26/33,codex:12/12 -->
