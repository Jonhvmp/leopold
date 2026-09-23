#!/usr/bin/env python3
"""Leopold hook-event probe: render docs/reference/hook-events.md (+ .pt-BR.md).

Reads what scripts/probe-hook-events.sh captured under <out> — manifest.json (the
verbatim `--version` output, runs, triggers tried, fingerprints), <harness>/<Event>.jsonl
(the payloads exactly as the dump hook received them), the .meta.jsonl sidecars and
evidence.jsonl (what each reply did) — and writes one section per event per harness.
Every number and version string on the page comes from those files; nothing is typed by
hand except the curated findings at the top of this file, which are written against the
versions the manifest names.

    python3 render-hook-events.py <out> --docs docs/reference

Python stdlib only.
"""
import argparse
import json
import os
import sys
from collections import OrderedDict

ELIDE_AT = 480  # a string value longer than this is cut, with the byte count stated

# Which payloads to quote for an event: the first one, plus the first of every distinct
# value of the discriminator (so PreCompact shows auto AND manual, StopFailure every
# error class, FileChanged every path). `None` means the first payload only.
DISCRIMINATOR = {
    "SessionStart": "source", "Setup": "trigger", "PreCompact": "trigger", "PostCompact": "trigger",
    "StopFailure": "error", "Stop": "stop_hook_active", "SubagentStop": "stop_hook_active",
    "SubagentStart": "agent_type", "PermissionRequest": "tool_name", "PreToolUse": "tool_name",
    "PostToolUse": "tool_name", "PostToolUseFailure": "tool_name", "FileChanged": "file_path",
    "Elicitation": "mode", "ElicitationResult": "action", "UserPromptExpansion": "command_name",
    "ConfigChange": "source", "PreModelSwitch": "to_model", "PostModelSwitch": "to_model",
    "SessionEnd": "reason", "TaskCreated": None, "TaskCompleted": None, "CwdChanged": None,
    "Interrupt": None, "UserPromptSubmit": None, "MessageDisplay": None, "PostToolBatch": None,
    "InstructionsLoaded": "file_path", "WorktreeCreate": None, "WorktreeRemove": None,
}
MAX_QUOTES = 4
# For the tool events, prefer the canonical Bash probes over whatever else the model ran.
PREFERRED_COMMANDS = ("true", "false", "grep -c zzz /dev/null")


def elide(v):
    if isinstance(v, str) and len(v) > ELIDE_AT:
        return v[:ELIDE_AT] + "…[+%d chars]" % (len(v) - ELIDE_AT)
    if isinstance(v, dict):
        return OrderedDict((k, elide(x)) for k, x in v.items())
    if isinstance(v, list):
        return [elide(x) for x in v]
    return v


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def read_jsonl(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line, object_pairs_hook=OrderedDict))
            except json.JSONDecodeError:
                rows.append({"__unparseable__": line})
    return rows


def pick_quotes(event, payloads, metas):
    key = DISCRIMINATOR.get(event)
    chosen, seen = [], set()
    # Preferred Bash probes first for the tool events.
    if event in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
        for cmd in PREFERRED_COMMANDS:
            for p in payloads:
                if p.get("tool_name") == "Bash" and (p.get("tool_input") or {}).get("command") == cmd:
                    chosen.append(p)
                    seen.add(("Bash", cmd))
                    break
    for p in payloads:
        if len(chosen) >= MAX_QUOTES:
            break
        if key is None:
            if not chosen:
                chosen.append(p)
            continue
        val = p.get(key)
        if event in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
            tag = (val, (p.get("tool_input") or {}).get("command") if val == "Bash" else None)
            if val == "Bash" and tag not in seen and any(c[0] == "Bash" for c in seen):
                continue  # one non-canonical Bash line is enough
        else:
            tag = val if not isinstance(val, (dict, list)) else dumps(val)
        if tag in seen:
            continue
        seen.add(tag)
        chosen.append(p)
    if not chosen and payloads:
        chosen.append(payloads[0])
    return chosen


def load_event(out, h, ev):
    """Payloads and their records for one event.

    The dump hook writes one RECORD per firing (run, mode, reply, ... and the payload
    itself as a JSON string) and, right after it, the verbatim payload line. The records
    are the source of truth — they cannot be misaligned by a hook the harness killed
    between the two writes. A verbatim line that has no record (the hook died after the
    record write never happens; before it, both are lost) is still quoted, unattributed,
    so that nothing captured is silently dropped.
    """
    metas = read_jsonl(os.path.join(out, h, ev + ".meta.jsonl"))
    verbatim = read_jsonl(os.path.join(out, h, ev + ".jsonl"))
    payloads = []
    for m in metas:
        raw = m.get("payload")
        if raw is None:
            continue
        try:
            payloads.append(json.loads(raw, object_pairs_hook=OrderedDict))
        except (json.JSONDecodeError, TypeError):
            payloads.append(OrderedDict([("__unparseable__", raw)]))
    if len(verbatim) > len(payloads):
        # Extra verbatim lines: quote them too, attributed to no run.
        seen = {dumps(p) for p in payloads}
        for v in verbatim:
            if dumps(v) not in seen:
                payloads.append(v)
                metas.append(OrderedDict([("run", ""), ("has_hook_event_name", "true" if "hook_event_name" in v else "false"),
                                          ("has_session_id", "true" if "session_id" in v else "false"), ("unattributed", True)]))
    return payloads, metas


def presence(metas, field):
    vals = [m.get(field) for m in metas]
    if not vals:
        return "—"
    yes = sum(1 for v in vals if v == "true")
    if yes == len(vals):
        return "present"
    if yes == 0:
        return "absent"
    return "present in %d of %d" % (yes, len(vals))


T = {
    "en": {
        "title": "# Hook Events — Live Probe of Both Harnesses",
        "intro": (
            "**The question:** which lifecycle hook events actually fire from a *headless* session on the "
            "installed binaries, with what payload, and which reply does each harness honor? Leopold's rules "
            "become hooks only on events that were captured, never on a docs page or a `strings` dump. This "
            "page is generated by `scripts/probe-hook-events.sh` from the verbatim payloads it recorded; rerun "
            "it on both binaries and the page rewrites itself.\n\n"
            "**The answer in one line:** {claude_fired} of the {claude_total} events Claude Code documents fired "
            "on `{claude_version}`; {codex_fired} of the {codex_total} events Codex CLI documents fired on "
            "`{codex_version}`. Every event that did not fire is recorded below with the trigger tried."
        ),
        "versions": "## Versions",
        "versions_head": "| Component | Version |\n| --- | --- |",
        "v_claude": "Claude Code CLI (`claude --version`)", "v_codex": "Codex CLI (`codex --version`)",
        "v_model": "Claude Code model alias for the probe", "v_codex_model": "Codex model (from the captured payloads)",
        "v_jq": "jq", "v_py": "Python (stubs, renderer)", "v_bash": "bash (hooks, driver)", "v_os": "OS",
        "v_leo": "Leopold", "v_date": "Probed at (UTC)",
        "method": "## Method (hermetic)",
        "method_body": (
            "- A throwaway project under `mktemp -d` per harness (`{temp_root}`): `git init`-ed, with a "
            "`CLAUDE.md` / `AGENTS.md`, a `.leopold/PLAN.md` and a root `PLAN.md` (the `FileChanged` control), "
            "a 120 KB file to compact against, a project command (`.claude/commands/probecmd.md`) and a Codex "
            "role file (`.codex/agents/probe-reviewer.toml`).\n"
            "- `scripts/probe/dump-hook.sh <event>` wired on **every** event of each harness's documented matrix "
            "through the shared writer in `extensions/lib/harness.sh` — `leo_wire_hooks_json` into the project's "
            "`.claude/settings.json`, `leo_wire_hooks_toml` into a temp `CODEX_HOME/config.toml`; nothing pastes "
            "JSON or TOML by hand. The hook appends its stdin verbatim to `<out>/<harness>/<event>.jsonl` — the "
            "event name is its argument, so a payload without `hook_event_name` still files under the right "
            "name — and answers per reply mode (observe / allow / deny / exit 2 / `systemMessage` / "
            "`additionalContext` / elicitation accept / worktree).\n"
            "- **Claude Code:** `claude -p --setting-sources project --output-format stream-json "
            "--include-hook-events` in a clean environment. The real config dir is only *read* (macOS keeps the "
            "login in the Keychain — exactly how [SDK Worker Hooks](sdk-worker-hooks.md) run 2 authenticated); a "
            "temp `CLAUDE_CONFIG_DIR` is used for one pass only, the unauthenticated *hooks-fire-anyway* run.\n"
            "- **Codex CLI:** `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust` with stdin "
            "closed, a temp `CODEX_HOME` holding a copy of `auth.json` that is deleted when the probe ends, and a "
            "temp `HOME` on top of it, so a stray `~/.codex` reference from the process cannot reach the real home.\n"
            "- One trigger per event: a passing and a failing Bash command; the session's own edit of "
            "`.leopold/PLAN.md` and an append from *another process*; an `Agent` / `spawn_agent` spawn; a "
            "TaskCreate + TaskUpdate completion with exit-2 blocking; forced compaction "
            "(`CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `/compact` on a resumed "
            "session; Codex `-c model_auto_compact_token_limit`); an API failure through `ANTHROPIC_BASE_URL` "
            "and a Codex `model_providers.<id>.base_url` pointed at a Python-stdlib stub answering 429, 529, 500 "
            "and 401; a permission request for a non-allowlisted tool with allow and deny replies; a "
            "`settings.json` edit mid-session; an MCP elicitation from a stdio stub; `--worktree`; `--init` / "
            "`--maintenance`; `/model`; a `register_repo_root` control request; SIGINT to `codex exec`; a Codex "
            "role file exercised by `spawn_agent` and by `codex exec` with `--strict-config`.\n"
            "- **Hermeticity is asserted, not assumed:** the entry names of the real `~/.claude` and `~/.codex` "
            "are fingerprinted before and after (the check `scripts/test-harness-lib.sh` runs, minus SQLite "
            "`-wal`/`-shm`/`-journal` side files, which the Codex desktop app creates and removes beside its own "
            "databases on its own schedule) and the probe fails if either changed; the full name lists are kept "
            "under `<out>/fingerprints/`. This run: `~/.claude` {fp_claude}, `~/.codex` {fp_codex}.\n"
            "- Payloads below are quoted **verbatim**; only string values longer than {elide} characters are "
            "cut with an explicit `…[+N chars]` marker. The raw files under `<out>/` hold every byte."
        ),
        "matrix": "## Matrix — {label} ({version})",
        "matrix_head": "| Event | Fired | Runs | `hook_event_name` | `session_id` | Replies exercised |\n| --- | --- | --- | --- | --- | --- |",
        "fired": "yes ×{n}", "not_fired": "**not fired**",
        "events_h": "## Events — {label}",
        "not_fired_body": "**Not fired on {label} {version}.** Trigger tried: {triggers}",
        "fired_in": "Fired {n} time(s) in run(s) {runs}. `hook_event_name`: {hen}; `session_id`: {sid}. Payload keys: {keys}.",
        "payload_h": "Payload, verbatim{which}:",
        "which_first": "", "which_n": " ({desc})",
        "replies_h": "Replies the harness honored:",
        "reply_line": "- `{reply}` → **{result}** — {evidence} *(run {run})*",
        "triggers_h": "Triggers tried:",
        "findings": "## Findings",
        "policy": "## What this decides for Leopold",
        "hermeticity": "## Hermeticity",
        "hermeticity_body": (
            "Every write landed under the `mktemp -d` root (`{temp_root}`), under `<out>`, or in the harnesses' "
            "own transcript directories for that temp project. The real `~/.claude` and `~/.codex` entry-name "
            "fingerprints were identical before and after ({fp_claude} / {fp_codex}); the temp `CODEX_HOME`'s "
            "copied `auth.json` was deleted when the probe ended. Rerun: `bash scripts/probe-hook-events.sh "
            "--out <dir>` (never part of `make test`; linted by `make hooks-check`)."
        ),
        "unchanged": "unchanged", "changed": "CHANGED",
        "runs_h": "## Runs",
        "runs_head": "| Harness | Run | rc | s | Command |\n| --- | --- | --- | --- | --- |",
        "no_replies": "No reply beyond observe was exercised on this event.",
    },
    "pt-BR": {
        "title": "# Eventos de hook — Probe ao vivo nos dois harnesses",
        "intro": (
            "**A pergunta:** quais eventos de hook do ciclo de vida realmente disparam a partir de uma sessão "
            "*headless* nos binários instalados, com qual payload, e qual resposta cada harness honra? As regras "
            "do Leopold só viram hooks em eventos capturados — nunca a partir de uma página de docs ou de um dump "
            "de `strings`. Esta página é gerada por `scripts/probe-hook-events.sh` a partir dos payloads "
            "verbatim que ele gravou; rode de novo nos dois binários e a página se reescreve.\n\n"
            "**A resposta em uma linha:** {claude_fired} dos {claude_total} eventos que o Claude Code documenta "
            "dispararam em `{claude_version}`; {codex_fired} dos {codex_total} eventos que o Codex CLI documenta "
            "dispararam em `{codex_version}`. Todo evento que não disparou está registrado abaixo com o gatilho "
            "tentado."
        ),
        "versions": "## Versões",
        "versions_head": "| Componente | Versão |\n| --- | --- |",
        "v_claude": "Claude Code CLI (`claude --version`)", "v_codex": "Codex CLI (`codex --version`)",
        "v_model": "Alias de modelo do Claude Code usado no probe", "v_codex_model": "Modelo do Codex (dos payloads capturados)",
        "v_jq": "jq", "v_py": "Python (stubs, renderizador)", "v_bash": "bash (hooks, driver)", "v_os": "SO",
        "v_leo": "Leopold", "v_date": "Probe executado em (UTC)",
        "method": "## Método (hermético)",
        "method_body": (
            "- Um projeto descartável sob `mktemp -d` por harness (`{temp_root}`): com `git init`, um "
            "`CLAUDE.md` / `AGENTS.md`, um `.leopold/PLAN.md` e um `PLAN.md` na raiz (o controle do "
            "`FileChanged`), um arquivo de 120 KB para forçar compactação, um comando de projeto "
            "(`.claude/commands/probecmd.md`) e um arquivo de role do Codex (`.codex/agents/probe-reviewer.toml`).\n"
            "- `scripts/probe/dump-hook.sh <event>` plugado em **todo** evento da matriz documentada de cada "
            "harness pelo writer compartilhado em `extensions/lib/harness.sh` — `leo_wire_hooks_json` no "
            "`.claude/settings.json` do projeto, `leo_wire_hooks_toml` num `CODEX_HOME/config.toml` temporário; "
            "nada cola JSON ou TOML à mão. O hook anexa seu stdin verbatim em `<out>/<harness>/<event>.jsonl` — "
            "o nome do evento é o argumento dele, então um payload sem `hook_event_name` ainda é arquivado sob o "
            "nome certo — e responde conforme o modo (observe / allow / deny / exit 2 / `systemMessage` / "
            "`additionalContext` / aceite de elicitation / worktree).\n"
            "- **Claude Code:** `claude -p --setting-sources project --output-format stream-json "
            "--include-hook-events` em ambiente limpo. O diretório de config real é apenas *lido* (o macOS guarda "
            "o login no Keychain — exatamente como a run 2 de [Hooks do worker SDK](sdk-worker-hooks.md) "
            "autenticou); um `CLAUDE_CONFIG_DIR` temporário é usado numa única passagem, a run não autenticada "
            "*os-hooks-disparam-mesmo-assim*.\n"
            "- **Codex CLI:** `codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust` com stdin "
            "fechado, um `CODEX_HOME` temporário com uma cópia do `auth.json`, apagada quando o probe termina, e um "
            "`HOME` temporário por cima, para que uma referência solta a `~/.codex` pelo processo não alcance o home real.\n"
            "- Um gatilho por evento: um comando Bash que passa e um que falha; a edição do próprio `.leopold/PLAN.md` "
            "pela sessão e um append vindo de *outro processo*; um spawn via `Agent` / `spawn_agent`; um "
            "TaskCreate + TaskUpdate concluído com bloqueio por exit 2; compactação forçada "
            "(`CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `/compact` numa sessão "
            "retomada; Codex `-c model_auto_compact_token_limit`); uma falha de API via `ANTHROPIC_BASE_URL` e via "
            "`model_providers.<id>.base_url` do Codex apontados para um stub em Python stdlib que responde 429, "
            "529, 500 e 401; um pedido de permissão para uma ferramenta fora do allowlist com respostas allow e "
            "deny; uma edição do `settings.json` no meio da sessão; uma elicitation MCP de um stub stdio; "
            "`--worktree`; `--init` / `--maintenance`; `/model`; um control request `register_repo_root`; SIGINT no "
            "`codex exec`; um arquivo de role do Codex exercitado por `spawn_agent` e por `codex exec` com "
            "`--strict-config`.\n"
            "- **A hermeticidade é afirmada, não presumida:** os nomes das entradas de `~/.claude` e `~/.codex` reais "
            "são fingerprintados antes e depois (a mesma checagem que `scripts/test-harness-lib.sh` roda, menos os "
            "arquivos laterais SQLite `-wal`/`-shm`/`-journal`, que o app desktop do Codex cria e remove ao lado dos "
            "próprios bancos no seu próprio ritmo) e o probe falha se qualquer um mudou; as listas completas de nomes "
            "ficam em `<out>/fingerprints/`. Nesta execução: `~/.claude` {fp_claude}, `~/.codex` {fp_codex}.\n"
            "- Os payloads abaixo são citados **verbatim**; apenas valores string com mais de {elide} caracteres "
            "são cortados com um marcador explícito `…[+N chars]`. Os arquivos brutos sob `<out>/` guardam cada "
            "byte. Dados capturados — payloads, notas de gatilho e linhas de evidência — são citados como "
            "gravados, em inglês."
        ),
        "matrix": "## Matriz — {label} ({version})",
        "matrix_head": "| Evento | Disparou | Runs | `hook_event_name` | `session_id` | Respostas exercitadas |\n| --- | --- | --- | --- | --- | --- |",
        "fired": "sim ×{n}", "not_fired": "**não disparou**",
        "events_h": "## Eventos — {label}",
        "not_fired_body": "**Não disparou no {label} {version}.** Gatilho tentado: {triggers}",
        "fired_in": "Disparou {n} vez(es) na(s) run(s) {runs}. `hook_event_name`: {hen}; `session_id`: {sid}. Chaves do payload: {keys}.",
        "payload_h": "Payload, verbatim{which}:",
        "which_first": "", "which_n": " ({desc})",
        "replies_h": "Respostas que o harness honrou:",
        "reply_line": "- `{reply}` → **{result}** — {evidence} *(run {run})*",
        "triggers_h": "Gatilhos tentados:",
        "findings": "## Conclusões",
        "policy": "## O que isto decide para o Leopold",
        "hermeticity": "## Hermeticidade",
        "hermeticity_body": (
            "Toda escrita caiu sob a raiz `mktemp -d` (`{temp_root}`), sob `<out>`, ou nos diretórios de transcript "
            "dos próprios harnesses para aquele projeto temporário. Os fingerprints de nomes de entrada de "
            "`~/.claude` e `~/.codex` reais foram idênticos antes e depois ({fp_claude} / {fp_codex}); o `auth.json` "
            "copiado para o `CODEX_HOME` temporário foi apagado ao fim do probe. Para repetir: `bash "
            "scripts/probe-hook-events.sh --out <dir>` (nunca faz parte do `make test`; `make hooks-check` faz o lint)."
        ),
        "unchanged": "inalterado", "changed": "MUDOU",
        "runs_h": "## Runs",
        "runs_head": "| Harness | Run | rc | s | Comando |\n| --- | --- | --- | --- | --- |",
        "no_replies": "Nenhuma resposta além de observe foi exercitada neste evento.",
    },
}
LABEL = {"claude": "Claude Code", "codex": "Codex CLI"}
RESULT_PT = {"honored": "honrada", "not-honored": "não honrada", "unobservable": "não observável", "n/a": "n/a"}

# Curated findings, written against the versions the manifest names. When a rerun on a
# newer binary contradicts one of these, edit the line — the generated sections above it
# are the evidence, these are the reading.
FINDINGS = {
    "en": [
        "**Every event a headless session can reach fires on Claude Code {claude_version}, in the project's own `.claude/settings.json`, with the same `session_id`/`transcript_path`/`cwd` prefix.** The ones that did not fire have no headless trigger on this version: `PermissionDenied` (auto mode denies without consulting it), `TeammateIdle` (no `TeamCreate` tool in `-p`), `DirectoryAdded` (`/add-dir` is not available in `-p` and the `register_repo_root` control request answers as recorded), `Notification` (nothing prompts in a headless session) and `WorktreeRemove` (the `--worktree` session's exit did not call it) — each row below names the trigger tried.",
        "**Most failing Bash commands do not reach `PostToolUse` on Claude Code — and the ones that do are not passes.** Exit 0 fires `PostToolUse` with `tool_response.{stdout,stderr,interrupted}` and no exit code; a non-zero exit normally fires `PostToolUseFailure` whose `error` is the string `\"Exit code 1\"` (plus `is_interrupt`). The exception is in this same capture: `grep -c zzz /dev/null`, which exits 1, reached `PostToolUse` carrying `returnCodeInterpretation: \"No matches found\"` — the harness re-interprets a set of non-zero exits as \"not an error\" and annotates them instead of routing them to the failure event. So the response OBJECT decides, not the event: `returnCodeInterpretation` (a re-interpreted non-zero), `interrupted` (cut off mid-run) and `backgroundTaskId` (launched, not finished) each mean the command did not cleanly exit 0. Codex fires `PostToolUse` for both, with `tool_response` as a string and **no exit code** either way — a done-evidence gate must read the command's outcome from its own record, never from the hook payload.",
        "**`FileChanged` cannot tell the session's own edit from another process's write, and its matcher does two jobs.** Both the `Edit` tool and an external append produce the same `{file_path, event: \"change\"}` payload; the correlation has to be a `PostToolUse` on the same path in the same instant. The matcher *registers* a watch as a literal path relative to the project root (`PLAN.md`, `.leopold/PLAN.md`) and *dispatches* on the changed file's basename (`PLAN.md`, `*`) — so a nested file needs two entries, one path-shaped that never fires itself and one basename-shaped that receives (runs `tools`, `filechanged-nested`); `PLAN.md|.envrc` registers nothing, and a `cd` in the session (`CwdChanged`) detaches every watch (run `filechanged-cwd`). `FileChanged` hooks run outside the turn: they never appear as `hook_started` in the stream.",
        "**Codex's edit tool is `apply_patch`** (`tool_input.command` holds the patch), its shell is reported as `Bash`, and its multi-agent tools reach `PreToolUse` as `collaborationspawn_agent` / `collaborationwait_agent`. A role file in `.codex/agents/<role>.toml` (`name`, `description`, `developer_instructions` plus any `config.toml` key) is honored by `spawn_agent(agent_type=<role>)`; an unknown key makes Codex ignore the file with a logged `Ignoring malformed agent role definition` (with and without `--strict-config`). **`codex exec` cannot run *as* a role:** `agent_role`, `agent_type` and `role` are rejected as unknown config fields, a role file is not a valid `--profile` layer, and `agents.<name>.config_file` only declares the role for spawning.",
        "**Exit 2 is honored where the docs say, on both harnesses:** `TaskCompleted` (the task stays pending), `UserPromptSubmit` and `UserPromptExpansion` (the prompt never reaches the model), `Stop` / `SubagentStop` (the agent continues and stops again with `stop_hook_active: true`), `PreModelSwitch` (no `PostModelSwitch` follows). `{\"decision\":\"block\"}` on `Stop` does the same on both. **`ConfigChange` is the one exit 2 this page cannot judge:** a `ConfigChange` hook never reaches the stream — no `hook_started`, no `hook_response`, so no exit code — and the file keeping the edit is true whether the reload was blocked or adopted, which is why its row reads `unobservable`. It was measured separately, by side effect (a settings rewrite that adds a hook, against a control run), in [ConfigChange exit 2 — Live Verification](config-reload-block.md): the reload IS blocked and the file DOES keep the edit.",
        "**`PermissionRequest` needs a decision path to exist.** On Claude Code it fires under `--permission-prompts none` (and a plain CLI `-p` with the default `host` denies without consulting it); `decision.behavior` allow/deny is honored (allow runs the tool, deny returns the message to the model). On Codex it fires under `--approve-for-me` for a sandbox escalation (network), with the same `decision.behavior` contract honored (`Rejected(\"PROBE_DENY\")` in the stream); `approval_policy=\"on-request\"` in headless `exec` never asks.",
        "**An API error is a `StopFailure` on Claude Code and a plain `turn.failed` on Codex.** `ANTHROPIC_BASE_URL` at the stub with `CLAUDE_CODE_MAX_RETRIES=0` fired `StopFailure` for every class, with `error` (not `error_type`): `rate_limit` for 429, `server_error` for 500 *and* 529, `authentication_failed` for 401 and for a missing login; `Stop` does not fire and `SessionEnd` still does. Codex has no failure hook: the provider stub ended each turn with `turn.failed`, and only `SessionStart`, `UserPromptSubmit` and `SessionEnd` fired — no `Stop`, no `Interrupt`.",
        "**Compaction fires `PreCompact`/`PostCompact` on both**, with `trigger` (`auto` / `manual`); Claude Code adds `custom_instructions` before and the full `compact_summary` after, then fires `SessionStart` with `source: \"compact\"`; the stream carries a `compact_boundary` with `pre_tokens`/`post_tokens`. Codex's payloads carry `turn_id` and `model` and nothing about the summary.",
        "**`Interrupt` is real on Codex:** SIGINT to `codex exec` mid-command fires it (no `Stop`), then `SessionEnd`. Codex clamps `SessionEnd` and `Interrupt` hook timeouts to 3 s (`clamping … hook timeout to 3s` in its stream) — a hook on those events must be quick.",
        "**The hook process inherits the parent's environment on both harnesses** (`CODEX_HOME` reached the hook; Claude Code adds `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_CODE_ENTRYPOINT`; Codex adds nothing of its own), and `hook_event_name` and `session_id` were present in every captured payload of both harnesses — a hook can trust them, and the dump hook's name-by-argument fallback never had to fire.",
    ],
    "pt-BR": [
        "**Todo evento que uma sessão headless consegue alcançar dispara no Claude Code {claude_version}, no `.claude/settings.json` do próprio projeto, com o mesmo prefixo `session_id`/`transcript_path`/`cwd`.** Os que não dispararam não têm gatilho headless nesta versão: `PermissionDenied` (o modo auto nega sem consultá-lo), `TeammateIdle` (sem ferramenta `TeamCreate` no `-p`), `DirectoryAdded` (`/add-dir` não existe no `-p` e o control request `register_repo_root` responde como registrado), `Notification` (nada pergunta numa sessão headless) e `WorktreeRemove` (a saída da sessão `--worktree` não o chamou) — cada linha abaixo nomeia o gatilho tentado.",
        "**A maioria dos comandos Bash que falham não chega ao `PostToolUse` no Claude Code — e os que chegam não são sucessos.** Exit 0 dispara `PostToolUse` com `tool_response.{stdout,stderr,interrupted}` e sem código de saída; exit diferente de zero normalmente dispara `PostToolUseFailure`, cujo `error` é a string `\"Exit code 1\"` (mais `is_interrupt`). A exceção está nesta mesma captura: `grep -c zzz /dev/null`, que sai com 1, chegou ao `PostToolUse` carregando `returnCodeInterpretation: \"No matches found\"` — o harness reinterpreta um conjunto de exits não-zero como \"não é erro\" e os anota em vez de mandá-los ao evento de falha. Então quem decide é o OBJETO de resposta, não o evento: `returnCodeInterpretation` (um não-zero reinterpretado), `interrupted` (cortado no meio) e `backgroundTaskId` (lançado, não terminado) significam, cada um, que o comando não saiu limpo com 0. O Codex dispara `PostToolUse` nos dois casos, com `tool_response` como string e **sem código de saída** em nenhum deles — um gate de evidência de conclusão precisa ler o resultado do comando do próprio registro, nunca do payload do hook.",
        "**`FileChanged` não distingue a edição da própria sessão de uma escrita de outro processo, e o matcher faz dois trabalhos.** Tanto a ferramenta `Edit` quanto um append externo produzem o mesmo payload `{file_path, event: \"change\"}`; a correlação tem de ser um `PostToolUse` no mesmo caminho no mesmo instante. O matcher *registra* um watch como caminho literal relativo à raiz do projeto (`PLAN.md`, `.leopold/PLAN.md`) e *despacha* pelo basename do arquivo alterado (`PLAN.md`, `*`) — então um arquivo aninhado precisa de duas entradas, uma em forma de caminho que nunca dispara sozinha e uma em forma de basename que recebe (runs `tools`, `filechanged-nested`); `PLAN.md|.envrc` não registra nada, e um `cd` na sessão (`CwdChanged`) desliga todos os watches (run `filechanged-cwd`). Hooks de `FileChanged` rodam fora do turno: nunca aparecem como `hook_started` no stream.",
        "**A ferramenta de edição do Codex é `apply_patch`** (`tool_input.command` carrega o patch), o shell dele é reportado como `Bash`, e as ferramentas multi-agente chegam ao `PreToolUse` como `collaborationspawn_agent` / `collaborationwait_agent`. Um arquivo de role em `.codex/agents/<role>.toml` (`name`, `description`, `developer_instructions` e qualquer chave do `config.toml`) é honrado por `spawn_agent(agent_type=<role>)`; uma chave desconhecida faz o Codex ignorar o arquivo com um `Ignoring malformed agent role definition` logado (com e sem `--strict-config`). **`codex exec` não roda *como* uma role:** `agent_role`, `agent_type` e `role` são rejeitados como campos de config desconhecidos, um arquivo de role não é uma camada `--profile` válida, e `agents.<name>.config_file` só declara a role para spawn.",
        "**Exit 2 é honrado onde os docs dizem, nos dois harnesses:** `TaskCompleted` (a task fica pendente), `UserPromptSubmit` e `UserPromptExpansion` (o prompt nunca chega ao modelo), `Stop` / `SubagentStop` (o agente continua e para de novo com `stop_hook_active: true`), `PreModelSwitch` (nenhum `PostModelSwitch` segue). `{\"decision\":\"block\"}` no `Stop` faz o mesmo nos dois. **O `ConfigChange` é o único exit 2 que esta página não consegue julgar:** um hook de `ConfigChange` nunca chega ao stream — sem `hook_started`, sem `hook_response`, logo sem exit code — e o arquivo manter a edição é verdade tendo o reload sido bloqueado ou adotado, e é por isso que a linha dele diz `unobservable`. Foi medido à parte, por efeito colateral (uma reescrita dos settings que acrescenta um hook, contra uma run de controle), em [ConfigChange exit 2 — Verificação ao vivo](config-reload-block.pt-BR.md): o reload É bloqueado e o arquivo MANTÉM a edição.",
        "**`PermissionRequest` precisa que exista um caminho de decisão.** No Claude Code dispara sob `--permission-prompts none` (e um CLI `-p` comum com o `host` padrão nega sem consultá-lo); `decision.behavior` allow/deny é honrado (allow roda a ferramenta, deny devolve a mensagem ao modelo). No Codex dispara sob `--approve-for-me` para uma escalação do sandbox (rede), com o mesmo contrato `decision.behavior` honrado (`Rejected(\"PROBE_DENY\")` no stream); `approval_policy=\"on-request\"` no `exec` headless nunca pergunta.",
        "**Um erro de API é um `StopFailure` no Claude Code e um `turn.failed` simples no Codex.** `ANTHROPIC_BASE_URL` no stub com `CLAUDE_CODE_MAX_RETRIES=0` disparou `StopFailure` para toda classe, com `error` (não `error_type`): `rate_limit` para 429, `server_error` para 500 *e* 529, `authentication_failed` para 401 e para login ausente; `Stop` não dispara e `SessionEnd` ainda dispara. O Codex não tem hook de falha: o stub de provider terminou cada turno com `turn.failed`, e só `SessionStart`, `UserPromptSubmit` e `SessionEnd` dispararam — sem `Stop`, sem `Interrupt`.",
        "**Compactação dispara `PreCompact`/`PostCompact` nos dois**, com `trigger` (`auto` / `manual`); o Claude Code acrescenta `custom_instructions` antes e o `compact_summary` completo depois, e então dispara `SessionStart` com `source: \"compact\"`; o stream carrega um `compact_boundary` com `pre_tokens`/`post_tokens`. Os payloads do Codex carregam `turn_id` e `model` e nada sobre o resumo.",
        "**`Interrupt` é real no Codex:** SIGINT no `codex exec` no meio de um comando o dispara (sem `Stop`), depois `SessionEnd`. O Codex limita os timeouts dos hooks de `SessionEnd` e `Interrupt` a 3 s (`clamping … hook timeout to 3s` no stream) — um hook nesses eventos precisa ser rápido.",
        "**O processo do hook herda o ambiente do pai nos dois harnesses** (`CODEX_HOME` chegou ao hook; o Claude Code acrescenta `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_CODE_ENTRYPOINT`; o Codex não acrescenta nada seu), e `hook_event_name` e `session_id` estavam presentes em todo payload capturado dos dois harnesses — um hook pode confiar neles, e o fallback nome-por-argumento do dump hook nunca precisou agir.",
    ],
}
POLICY = {
    "en": [
        "Every capability of this run's mission is wired only on events captured above, with the payload fields the captures show; a field the probe did not capture sends the item back to the probe, never to a guess.",
        "Where Codex lacks the event (`StopFailure`, `PostToolUseFailure`, `TaskCompleted`, `FileChanged`, `ConfigChange`), the capability ships on Claude Code with the Codex substitute the captures allow — `PostToolUse` plus the PLAN.md edit for done-evidence, `turn.failed` in the `--json` stream for API errors — and `leopold doctor` names what Codex cannot do, quoting the version this page records.",
        "The `Interrupt` and `SessionEnd` hooks on Codex stay under 3 s; a hook that must do more records the intent and lets the next turn finish it.",
    ],
    "pt-BR": [
        "Toda capacidade da missão desta run é plugada só em eventos capturados acima, com os campos de payload que as capturas mostram; um campo que o probe não capturou manda o item de volta ao probe, nunca a um palpite.",
        "Onde o Codex não tem o evento (`StopFailure`, `PostToolUseFailure`, `TaskCompleted`, `FileChanged`, `ConfigChange`), a capacidade sai no Claude Code com o substituto do Codex que as capturas permitem — `PostToolUse` mais a edição do PLAN.md para evidência de conclusão, `turn.failed` no stream `--json` para erros de API — e o `leopold doctor` nomeia o que o Codex não consegue, citando a versão que esta página registra.",
        "Os hooks de `Interrupt` e `SessionEnd` no Codex ficam abaixo de 3 s; um hook que precise fazer mais registra a intenção e deixa o turno seguinte terminar.",
    ],
}


def render(out, lang, leopold_version):
    t = T[lang]
    manifest = json.load(open(os.path.join(out, "manifest.json"), encoding="utf-8"), object_pairs_hook=OrderedDict)
    evidence = read_jsonl(os.path.join(out, "evidence.jsonl"))
    versions = manifest.get("versions", {})
    cv, xv = versions.get("claude", ""), versions.get("codex", "")
    events = manifest["events"]
    fp = manifest.get("fingerprints", {})

    def fp_state(h):
        b, a = fp.get(h + "_before"), fp.get(h + "_after")
        if a is None:
            return "—"
        if a == b:
            return t["unchanged"]
        d = (fp.get(h + "_diff") or "").strip()
        return t["changed"] + (" (`%s`)" % d if d else "")

    data = {}
    for h in ("claude", "codex"):
        data[h] = {}
        for ev in events[h]:
            data[h][ev] = load_event(out, h, ev)

    codex_model = ""
    for ev in ("SessionStart", "Stop", "UserPromptSubmit"):
        for p in data["codex"].get(ev, ([], []))[0]:
            if p.get("model"):
                codex_model = p["model"]
                break
        if codex_model:
            break

    fired = {h: sum(1 for ev in events[h] if data[h][ev][0]) for h in ("claude", "codex")}
    lines = [t["title"], ""]
    lines.append(t["intro"].format(claude_fired=fired["claude"], claude_total=len(events["claude"]), claude_version=cv,
                                   codex_fired=fired["codex"], codex_total=len(events["codex"]), codex_version=xv))
    lines += ["", t["versions"], "", t["versions_head"]]
    lines.append("| %s | `%s` |" % (t["v_claude"], cv))
    lines.append("| %s | `%s` |" % (t["v_codex"], xv))
    lines.append("| %s | `%s` |" % (t["v_model"], manifest.get("claude_model_alias", "")))
    lines.append("| %s | `%s` |" % (t["v_codex_model"], codex_model or "—"))
    lines.append("| %s | `%s` |" % (t["v_jq"], versions.get("jq", "")))
    lines.append("| %s | `%s` |" % (t["v_py"], versions.get("python", "")))
    lines.append("| %s | `%s` |" % (t["v_bash"], versions.get("bash", "")))
    lines.append("| %s | `%s` |" % (t["v_os"], versions.get("os", "")))
    lines.append("| %s | %s (`scripts/probe-hook-events.sh`, `scripts/probe/dump-hook.sh`) |" % (t["v_leo"], leopold_version))
    lines.append("| %s | %s |" % (t["v_date"], manifest.get("probed_at", "")))
    lines += ["", t["method"], "", t["method_body"].format(temp_root=manifest.get("temp_root", "/tmp/leopold-hookprobe.*"),
                                                             fp_claude=fp_state("claude"), fp_codex=fp_state("codex"), elide=ELIDE_AT)]

    for h in ("claude", "codex"):
        ver = cv if h == "claude" else xv
        lines += ["", t["matrix"].format(label=LABEL[h], version=ver), "", t["matrix_head"]]
        for ev in events[h]:
            payloads, metas = data[h][ev]
            runs = sorted({m.get("run", "") for m in metas if m.get("run")})
            replies = sorted({e["reply"] for e in evidence if e["harness"] == h and e["event"] == ev and e["reply"] != "observe" and not e["reply"].startswith("observe")})
            rep = ", ".join("`%s`" % r for r in replies) if replies else "—"
            if payloads:
                lines.append("| `%s` | %s | %s | %s | %s | %s |" % (ev, t["fired"].format(n=len(payloads)), ", ".join(runs) or "—",
                                                                   presence(metas, "has_hook_event_name"), presence(metas, "has_session_id"), rep))
            else:
                lines.append("| `%s` | %s | — | — | — | %s |" % (ev, t["not_fired"], rep))

    for h in ("claude", "codex"):
        ver = cv if h == "claude" else xv
        lines += ["", t["events_h"].format(label=LABEL[h])]
        for ev in events[h]:
            payloads, metas = data[h][ev]
            triggers = manifest.get("triggers", {}).get(h, {}).get(ev, [])
            lines += ["", "### `%s` — %s" % (ev, LABEL[h]), ""]
            if not payloads:
                lines.append(t["not_fired_body"].format(label=LABEL[h], version=ver, triggers=" · ".join(triggers) or "(none recorded)"))
            else:
                runs = sorted({m.get("run", "") for m in metas if m.get("run")})
                keys = sorted({k for p in payloads for k in p.keys()})
                lines.append(t["fired_in"].format(n=len(payloads), runs=", ".join("`%s`" % r for r in runs) or "—",
                                                  hen=presence(metas, "has_hook_event_name"), sid=presence(metas, "has_session_id"),
                                                  keys=", ".join("`%s`" % k for k in keys)))
                quotes = pick_quotes(ev, payloads, metas)
                key = DISCRIMINATOR.get(ev)
                for i, p in enumerate(quotes):
                    desc = ""
                    if len(quotes) > 1:
                        if ev in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
                            desc = "%s: %s" % (p.get("tool_name"), dumps(elide(p.get("tool_input")))[:80])
                        elif key:
                            desc = "%s: %s" % (key, dumps(p.get(key)))
                    lines += ["", t["payload_h"].format(which=(t["which_n"].format(desc=desc) if desc else t["which_first"])), "", "```json", dumps(elide(p)), "```"]
                if triggers:
                    lines += ["", t["triggers_h"], ""]
                    lines += ["- " + x for x in triggers]
            rows = [e for e in evidence if e["harness"] == h and e["event"] == ev]
            if rows:
                lines += ["", t["replies_h"], ""]
                for e in rows:
                    res = e["result"] if lang == "en" else RESULT_PT.get(e["result"], e["result"])
                    lines.append(t["reply_line"].format(reply=e["reply"], result=res, evidence=e["evidence"], run=e.get("run") or "—"))

    lines += ["", t["findings"], ""]
    for f in FINDINGS[lang]:
        lines.append("- " + f.replace("{claude_version}", cv).replace("{codex_version}", xv))
    lines += ["", t["policy"], ""]
    for f in POLICY[lang]:
        lines.append("- " + f)
    lines += ["", t["runs_h"], "", t["runs_head"]]
    for r in manifest.get("runs", []):
        lines.append("| %s | `%s` | %s | %s | `%s` |" % (r["harness"], r["name"], r["rc"], r["seconds"], r["args"].replace("|", "\\|")[:160]))
    lines += ["", t["hermeticity"], "", t["hermeticity_body"].format(temp_root=manifest.get("temp_root", ""), fp_claude=fp_state("claude"), fp_codex=fp_state("codex"))]
    lines += ["", "<!-- @emit hook_events_probed=claude:%d/%d,codex:%d/%d -->" % (fired["claude"], len(events["claude"]), fired["codex"], len(events["codex"])), ""]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--docs", required=True, help="docs/reference directory to write into")
    args = ap.parse_args()
    root = os.path.abspath(os.path.join(args.docs, "..", ".."))
    try:
        leopold_version = open(os.path.join(root, "VERSION"), encoding="utf-8").read().strip()
    except OSError:
        leopold_version = "working tree"
    for lang, name in (("en", "hook-events.md"), ("pt-BR", "hook-events.pt-BR.md")):
        text = render(args.out, lang, leopold_version)
        path = os.path.join(args.docs, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote %s (%d bytes)" % (path, len(text.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
