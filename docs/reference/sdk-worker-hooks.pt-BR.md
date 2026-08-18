# Hooks do Worker SDK — Verificação ao Vivo

**A pergunta:** o driver SDK inicia cada item do plano como um worker novo com
`settingSources: ["user", "project"]` (`packages/driver/src/worker.ts`). Ou seja,
os hooks estão *configurados* para carregar — mas um worker do driver realmente
dispara `SessionStart`, `UserPromptSubmit`, `Stop` e `SessionEnd`? Essa afirmação
vinha sendo assumida sem verificação. Esta página é a evidência capturada de uma
execução ao vivo.

**A resposta: sim — os quatro disparam, por worker, a partir das duas fontes de
configuração.**

## Versões

| Componente | Versão |
| --- | --- |
| Claude Code CLI (`claude`) | 2.1.234 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.228 |
| Node.js | v22.22.0 |
| Driver do Leopold | build de `packages/driver` em 0.18.x (`dist/worker.js`, com `settingSources: ["user", "project"]`) |
| Data | 2026-08-18 |

## Método (hermético)

- Um projeto descartável sob `mktemp -d` (`/tmp/leopold-hookprobe.*/project`), com
  `git init` e um `.leopold/` vazio próprio.
- Um script de hook marcador que anexa o payload completo do stdin (rotulado
  `user` ou `project`) em `$MARKER_DIR/<hook_event_name>.log`.
- O hook ligado de forma idêntica em `SessionStart`, `UserPromptSubmit`, `Stop` e
  `SessionEnd`, **tanto** em um `CLAUDE_CONFIG_DIR/settings.json` temporário
  (fonte user) **quanto** no `.claude/settings.json` do projeto temporário (fonte
  project).
- Um worker real do driver, pelo caminho de produção — um script Node chamando
  `runItem` de `dist/worker.js` com um brief mínimo apontando para o projeto
  temporário — com um prompt trivial ("responda com um bloco leopold-status").
- Duas execuções: (1) totalmente hermética com `CLAUDE_CONFIG_DIR` novo e sem
  login; (2) uma confirmação autenticada com os hooks marcadores apenas no
  settings do projeto temporário, para provar o comportamento em um turno real
  completo do modelo.

## Evidência — execução 1 (`CLAUDE_CONFIG_DIR` temporário, sem login)

O diretório de configuração novo não tem login, então o turno do modelo falhou
("Not logged in") — e os hooks dispararam mesmo assim, das duas fontes, provando
que o harness os liga e dispara antes da chamada ao modelo. Conteúdo dos arquivos
marcadores, literal:

```
=== markers/SessionStart.log ===
2026-08-18T08:20:57.857Z  user     {"session_id":"f76e7e02-bf74-4048-9639-42bb8921a875","transcript_path":"/tmp/leopold-hookprobe.Nypw5l/claude-config/projects/-tmp-leopold-hookprobe-Nypw5l-project/f76e7e02-bf74-4048-9639-42bb8921a875.jsonl","cwd":"/tmp/leopold-hookprobe.Nypw5l/project","hook_event_name":"SessionStart","source":"startup"}
2026-08-18T08:20:57.858Z  project  {…mesmo payload…}

=== markers/UserPromptSubmit.log ===
2026-08-18T08:20:57.919Z  user     {"session_id":"f76e7e02-…","prompt_id":"c35b44c0-…","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"Do not use any tools. Reply with exactly one fenced leopold-status block …"}
2026-08-18T08:20:57.920Z  project  {…mesmo payload…}

=== markers/SessionEnd.log ===
2026-08-18T08:20:57.978Z  user     {"session_id":"f76e7e02-…","prompt_id":"c35b44c0-…","hook_event_name":"SessionEnd","reason":"other"}
2026-08-18T08:20:57.978Z  project  {…mesmo payload…}
```

Sem `Stop.log` nesta execução — o turno falhou antes de um stop do assistente,
então o `Stop` não disparou. O `SessionEnd` disparou mesmo assim.

## Evidência — execução 2 (autenticada, turno real completo)

Mesma sonda, hooks marcadores no `.claude/settings.json` do projeto temporário. O
worker completou um turno real (`TURN status= done`, `COST 0.8902` USD reportado
pela mensagem `result`). Os quatro arquivos marcadores existem; conteúdo, literal:

```
=== markers2/SessionStart.log ===
2026-08-18T08:22:52.636Z  project  {"session_id":"9698a738-b760-44cf-8813-a457c3ea1790","transcript_path":"…/9698a738-….jsonl","cwd":"/tmp/leopold-hookprobe.Nypw5l/project","hook_event_name":"SessionStart","source":"startup"}

=== markers2/UserPromptSubmit.log ===
2026-08-18T08:22:56.572Z  project  {"session_id":"9698a738-…","prompt_id":"3c23f2fb-…","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"Do not use any tools. Reply with exactly one fenced leopold-status block …"}

=== markers2/Stop.log ===
2026-08-18T08:23:08.451Z  project  {"session_id":"9698a738-…","prompt_id":"3c23f2fb-…","permission_mode":"default","effort":{"level":"xhigh"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"```leopold-status\nSTATUS: done\nITEM: hook probe\nSUMMARY: probe complete\n…```","background_tasks":[],"session_crons":[]}

=== markers2/SessionEnd.log ===
2026-08-18T08:23:08.632Z  project  {"session_id":"9698a738-…","prompt_id":"3c23f2fb-…","hook_event_name":"SessionEnd","reason":"other"}
```

## Conclusões

1. **Hooks disparam por worker do SDK.** Cada sessão de `runItem` dispara
   `SessionStart(source: "startup")` → `UserPromptSubmit` → (em turno completo)
   `Stop` → `SessionEnd(reason: "other")`, nessa ordem.
2. **As duas fontes de configuração carregam**, exatamente como
   `settingSources: ["user", "project"]` promete: o mesmo evento chega uma vez
   pelo hook de nível user e outra pelo de nível project, com milissegundos de
   diferença.
3. **Cada worker é uma sessão própria** — `session_id` e transcript novos por
   item. Uma execução de 30 itens produz, portanto, 30 pares
   `SessionStart`/`SessionEnd`: qualquer hook indexado só por `session_id` (o
   flush do ovmem é) criará um registro por item, a menos que se torne ciente da
   run.
4. **`SessionEnd` dispara mesmo em turno com falha** (execução 1): um hook de
   flush não pode assumir que a sessão produziu conteúdo útil.
5. **Os processos de hook herdam o ambiente do driver** — `$MARKER_DIR` definido
   no processo do `runItem` chegou aos comandos de hook. Essa é a costura que um
   flush ciente da run pode usar.

## A política que essa evidência decidiu

Como os hooks disparam por worker, os flushes do ovmem por item são
**suprimidos**: o driver marca o ambiente de **toda sessão SDK que ele cria** —
workers por item, lentes de review, juízes de torneio, sessões de hipótese e de
rota — com `LEOPOLD_SDK_WORKER=1` na sua única costura de query
(`packages/driver/src/sdk.ts`; um único call site deixaria as sessões de reviewer
e juiz, que também carregam hooks via `settingSources: ["user","project"]`,
fazendo flush sem a marca), e o `ovmem.py` pula o
caminho de escrita (os flushes de `SessionEnd` e `PreCompact`) quando a marca está
presente, registrando uma linha no log em vez de falhar em silêncio. As leituras
de memória (rehydrate, recall) seguem intactas. A reversão é uma env var no
driver: `LEOPOLD_OVMEM_WORKER_FLUSH=1` restaura os flushes por item. Decisão D4 no
DECISIONS.md da run; garantido hermeticamente por `scripts/test-ovmem-ext.sh` e
`packages/driver/test/worker-env.test.ts`.

## Hermeticidade

A sonda nunca tocou este repositório: `git status --porcelain .leopold` estava
vazio antes e depois, e um `sha1sum` sobre um tar de `.leopold/` foi idêntico
antes e depois das duas execuções
(`3a59fc63914dda7f8bb1cb65c5924293bfb2db2e`). Todas as escritas ficaram sob a
raiz do `mktemp -d`.

<!-- @emit hooks_fire=true -->
