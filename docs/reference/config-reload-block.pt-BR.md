# ConfigChange exit 2 — Verificação ao vivo

**A pergunta:** o `hooks/config-guard.sh` recusa um reload de settings durante uma run do
Leopold saindo com exit 2 no `ConfigChange`, e diz ao operador que a sessão portanto
"mantém o wiring de hooks com que começou" — o git lock em primeiro lugar. Isso é uma
afirmação de segurança, e o probe de eventos de hook não conseguia sustentá-la.
[Eventos de hook](hook-events.md) registra a resposta `exit2` do `ConfigChange` como
**unobservable**: o único `exit2` do probe inteiro que não está marcado como *honored*. O
seu único dado positivo — o arquivo em disco continuava com a edição — é igualmente
verdadeiro tendo o reload sido bloqueado ou adotado, então não prova nada sozinho.

**A resposta: o exit 2 bloqueia o reload, e o arquivo mantém a edição.** As duas metades
estão medidas abaixo, contra um controle, três vezes cada.

## Versões

| Componente | Versão |
| --- | --- |
| Claude Code CLI (`claude`) | 2.1.260 (Claude Code) |
| `jq` | jq-1.7.1-apple |
| SO | Darwin 27.0.0 arm64 |
| Data | 2026-09-04 |

O probe que escreveu [Eventos de hook](hook-events.md) rodou contra a 2.1.259; esta
página é um patch depois, e diz isso em vez de tomar emprestado o cabeçalho daquela.

## Por que o probe não conseguia ver

Um hook de `ConfigChange` **nunca aparece no stream da sessão**. Com
`--include-hook-events` ligado, `hook_started` / `hook_response` saíram para
`SessionStart`, `UserPromptSubmit`, `PreToolUse` e `Stop` — e para mais nada. A string
`ConfigChange` não ocorre em lugar nenhum do stream de nenhuma das runs abaixo:

```
$ jq -r 'select(.type=="system" and .subtype=="hook_started") | .hook_event' block3.stream.jsonl | sort | uniq -c
   4 PreToolUse
   2 SessionStart
   2 Stop
   2 UserPromptSubmit
$ grep -c ConfigChange block3.stream.jsonl
0
```

Sem `hook_response` não há campo `exit_code`, então o veredito de que toda outra resposta
é lida não existe para esta. Ele tem que ser lido de um **efeito colateral**.

## Método (hermético, pareado)

Um projeto descartável por run sob o diretório de scratch da própria sessão, com
`git init`, um `CLAUDE.md` e um `.claude/settings.json` que declara exatamente um hook:

```json
{ "hooks": { "ConfigChange": [ { "hooks": [ { "type": "command",
  "command": "bash $P/.claude/hooks/cg.sh", "timeout": 10 } ] } ] } }
```

O `cg.sh` anexa a um log o payload que recebeu e então sai com **2** (runs `block`) ou
**0** (runs `allow`) — a única diferença entre os dois braços.

Ao lado dele fica o `settings-v2.json`: o mesmo arquivo **mais** um hook `PreToolUse`
extra em `Bash`, cujo script anexa `NEW_HOOK_FIRED` a um arquivo marcador. Esse hook é o
efeito colateral observável — nada consegue dispará-lo a não ser que a sessão adote os
settings reescritos.

Um turno headless por run, idêntico nos dois braços:

```
claude -p "Run this exact Bash command: bash rewire.sh. Then run this exact Bash command:
           echo SECOND_CALL. Then reply DONE."
        --model haiku --permission-mode bypassPermissions
        --output-format stream-json [--include-hook-events] --verbose
```

O `rewire.sh` copia o `settings-v2.json` por cima do `.claude/settings.json` e dorme 4 s.
A sequência é: **chamada de ferramenta 1** reescreve os settings → o `ConfigChange`
dispara e responde → **chamada de ferramenta 2** acontece sob o wiring que a sessão tem
agora.

O payload que o `ConfigChange` entregou, verbatim (run `block`, caminhos como reportados):

```json
{"session_id":"41421919-ea1a-4f29-b2cf-f43ed7abdbf0","transcript_path":"/Users/jonhvmp/.claude/projects/-private-tmp-…-cgprobe-block/41421919-ea1a-4f29-b2cf-f43ed7abdbf0.jsonl","cwd":"/private/tmp/…/cgprobe/block","scratchpad_dir":"/private/tmp/…/scratchpad","prompt_id":"bb22d94f-47fb-4110-bb65-b9282fd2e991","hook_event_name":"ConfigChange","source":"project_settings","file_path":"/private/tmp/…/cgprobe/block/.claude/settings.json"}
```

`source` e `file_path` são os dois campos que o `hooks/config-guard.sh` lê, exatamente
como [Eventos de hook](hook-events.md) os registra.

## Evidência

| Run | exit do `ConfigChange` | disparou | 2ª chamada feita | hook novo disparou | edição mantida em disco |
| --- | --- | --- | --- | --- | --- |
| `allow`  | 0 | 1 | sim | **sim** | sim |
| `allow2` | 0 | 1 | sim | **sim** | sim |
| `allow3` | 0 | 1 | sim | **sim** | sim |
| `block`  | 2 | 1 | sim | **não** | sim |
| `block2` | 2 | 1 | sim | **não** | sim |
| `block3` | 2 | 1 | sim | **não** | sim |

Os dois braços fizeram as mesmas duas chamadas de ferramenta — a ausência do marcador no
braço `block` não é ausência da segunda chamada:

```
=== allow
TOOL Bash :: bash rewire.sh
TOOL Bash :: echo SECOND_CALL
=== block
TOOL Bash :: bash rewire.sh
TOOL Bash :: echo SECOND_CALL
```

E o stream conta a mesma coisa de forma independente. Existem dois hooks `PreToolUse` no
nível de usuário nesta máquina, então duas chamadas produzem quatro disparos; os settings
reescritos acrescentam um terceiro hook, que só pode disparar na segunda chamada:

```
allow3 (exit 0):   5 PreToolUse hook_started   ← 4 + o hook recém-declarado
block3 (exit 2):   4 PreToolUse hook_started   ← o hook recém-declarado nunca rodou
```

O arquivo em disco manteve a edição em todas as runs, `block` incluída:

```
$ jq -r '.hooks | has("PreToolUse")' block/.claude/settings.json
true
```

## O que isso decide para o Leopold

- **O exit 2 do `hooks/config-guard.sh` faz o que diz.** A sessão em execução não adota a
  nova configuração; a run mantém o wiring de hooks com que começou, o git lock incluído.
  A mensagem no stderr voltada ao operador está sustentada.
- **Ele não desfaz a escrita, e nada neste evento consegue.** É por isso que o hook loga
  `config_change_blocked` tão alto quanto recusa: o evento é o registro durável de que o
  arquivo em disco e a sessão viva divergiram, e o `scripts/leopold-watch.py` o renderiza
  como crítico.
- **O veredito é um efeito colateral, nunca um campo do stream.** O
  `scripts/probe-hook-events.sh` agora mede do mesmo jeito: o par
  `config-change` / `config-change-exit2` reescreve os settings da sessão para um gêmeo
  que carrega um hook `PreToolUse` extra e etiquetado, e conta se ele dispara —
  `config-change` é o controle, e rodar `config-change-exit2` sem ele registra
  "NO CONTROL" em vez de um veredito. Refaça com `make probe-hook-events`.
- **O Codex não é afetado.** O Codex CLI 0.152.1 não tem `ConfigChange` nenhum
  (`hooks/hook-matrix.tsv`), então uma edição do `config.toml` no meio da run não é
  detectada lá e o `leopold doctor` diz isso por harness.
