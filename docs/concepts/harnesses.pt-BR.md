# Harnesses: Claude Code e Codex

Leopold não é um plugin do Claude Code que por acaso roda em outro lugar. É uma
camada de harness que fica em cima do agente de código que você usa — e hoje isso
significa **Claude Code** e **OpenAI Codex CLI**.

Isso funciona não por abstração esperta do lado do Leopold, mas porque o Codex
reimplementou o contrato de hooks do Claude Code quase literalmente: mesmos nomes de
evento, mesmas chaves de payload, mesmos formatos de resposta. Os hooks do Leopold
rodam nos dois harnesses como os mesmos scripts shell, sem alteração.

## O que já era portátil

O brief é o ponto central do Leopold, e nunca foi específico de harness:

```
.leopold/
  MISSION.md      o que estamos fazendo e por quê
  CHARTER.md      como decidir quando ninguém está olhando
  GUARDRAILS.md   os orçamentos e as condições de parada
  PLAN.md         o checklist que o run queima
  DECISIONS.md    o que foi decidido, e com que base
  state.json      estado do run (ativo, iteração, orçamentos)
  events.jsonl    o log de eventos append-only
```

Markdown puro e um JSON. Nada ali sabe nem se importa com qual agente está lendo. Um
brief escrito no Claude Code roda no Codex e vice-versa.

## O que realmente difere

| | Claude Code | Codex CLI |
|---|---|---|
| Home | `~/.claude` | `~/.codex` |
| Skills | `~/.claude/skills/` | `~/.codex/skills/` (mesmo formato `SKILL.md`) |
| Configuração | `settings.json` (JSON) | `config.toml` (TOML) |
| Memória do projeto | `CLAUDE.md` | `AGENTS.md` |
| Manifesto de plugin | `.claude-plugin/` | `.codex-plugin/` |
| Seam headless | `@anthropic-ai/claude-agent-sdk` | `codex exec --json` |
| Hook precisa de trust | não | **sim, uma vez** |

Essa última linha é a única diferença de comportamento de verdade, e o resto desta
página é basicamente sobre ela.

## Nenhum harness dispara "menos" eventos — eles disparam eventos diferentes

É tentador ler a tabela acima como "o Codex é o harness menor, então deve disparar um
subconjunto dos eventos de ciclo de vida". Ele não dispara, e a sonda resolveu isso: cada
um dos **12 eventos que o Codex CLI 0.152.1 documenta disparou** num run headless
hermético — `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`
e `Interrupt`. Compactação, subagents e prompts de permissão todos chegam a um hook no
Codex.

O Claude Code 2.1.259 documenta **33**, dos quais 26 dispararam headless; os sete que não
dispararam não têm gatilho headless nessa versão (`PermissionDenied`, `Notification`,
`TeammateIdle`, `DirectoryAdded`, `WorktreeRemove`, `Elicitation`, `ElicitationResult`).
Então a diferença real não é tamanho, e sim **quais** eventos existem: o Claude Code tem
eventos de task, arquivo, configuração, worktree e falha para os quais o Codex não tem
equivalente, e o Codex tem `Interrupt`, que o Claude Code não dispara.

Toda afirmação desta página vem daquela captura, não de uma página de docs:
[Hook Events](../reference/hook-events.md) é regenerado por `make probe-hook-events` e
guarda um payload literal — ou o gatilho tentado, para um evento que não disparou — para
as 45 linhas. O `hooks/hook-matrix.tsv` é derivado dele, e é ele, não esta prosa, que
decide o status de cada capacidade por harness.

## Os hooks são os mesmos scripts

O engine de run se apoia em hooks sempre ativos que ficam inertes a menos que um run
esteja ativo; os três cujo comportamento mais difere entre os harnesses estão abaixo, e o
conjunto completo está em [Hooks](../reference/hooks.md) (o
[`persona-guard.sh`](../reference/persona-guard-hooks.md) é o que só é armado enquanto um
persona run está ativo — o mesmo script nos dois harnesses também).

**`guard-irreversible.sh` (PreToolUse) — a trava do git.** Nega `git commit` e
`git push` enquanto um run está ativo, então o run deixa o trabalho staged e você
publica. O Codex entrega o PreToolUse com as mesmas chaves do Claude Code —
`tool_name` (a ferramenta de shell dele chega como `Bash`), `tool_input.command`,
`cwd`, `transcript_path` — e honra a mesma resposta:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
 "permissionDecision":"deny","permissionDecisionReason":"…"}}
```

**`stop-continuity.sh` (Stop) — o motor autônomo.** Quando o agente termina um turno,
ele lê `state.json` e `PLAN.md`; se ainda há trabalho e nenhuma condição de parada
bateu, bloqueia o encerramento e reinjeta a próxima instrução. O Codex entrega o Stop
com `session_id`, `turn_id`, `cwd`, `transcript_path` e `stop_hook_active` (verificado
no codex-cli 0.150.1; o Claude Code 2.1.258 envia `session_id`, `prompt_id`, `cwd`,
`transcript_path`, `stop_hook_active` e `last_assistant_message`), e honra a mesma
resposta:

```json
{"decision":"block","reason":"…"}
```

O `session_id` é o que vincula um run à única sessão que o conduz: é igual ao
`CODEX_THREAD_ID` na shell tool do Codex e ao `CLAUDE_CODE_SESSION_ID` no Claude Code, e
o hook continua só a sessão que bate com o `owner` do run
([Hooks](../reference/hooks.pt-BR.md)). Uma diferença importa para quem escreve hooks:
um processo de hook do Codex não herda nenhuma variável `CODEX_*` (o do Claude Code herda
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` e `CLAUDE_PROJECT_DIR`), então no Codex o payload
é a única identidade que um hook tem — por isso a checagem de owner lê o payload, nunca o
ambiente.

**`permission-policy.sh` (PermissionRequest) — o prompt que o run responde sozinho.**
Quando a sessão que conduz um run esbarra num pedido de permissão, o hook responde em vez
de esperar: allow, exceto que um `git commit` / `git push` é entregue à trava do git acima
e o deny dela é repetido literalmente. Os dois harnesses mandam as mesmas chaves de
payload (`tool_name`, `tool_input`, `cwd`, `session_id`) e leem a mesma resposta:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest",
 "decision":{"behavior":"deny","message":"…"}}}
```

Este é o único ponto em que os dois harnesses não são iguais, e o Leopold diz isso em vez
de fingir o contrário. O Claude Code (2.1.259) dispara o evento sob
`--permission-prompts none` e honra **allow e deny**. O Codex (0.152.1) dispara só sob
`--approve-for-me` e honra **apenas deny** — uma resposta allow é ignorada — então no
Codex o hook é a voz da trava do git no prompt, e a autonomia fica nas flags de sandbox do
driver. O `hooks/hook-matrix.tsv` registra isso como `substitute`, e o `leopold doctor`
imprime o custo na linha em vez de alegar paridade.

**`subagent-account.sh` (SubagentStart / SubagentStop) e `subagent-cap.sh`
(PreToolUse) — o que os filhos custam, e o teto.** Esses dois *não* diferem. Os dois
harnesses disparam os dois eventos de subagent com as mesmas chaves de contabilidade
(`agent_id`, `agent_type`, e `agent_transcript_path` no stop), então o livro-razão indexa
igual em cada um; e o deny do teto no `PreToolUse` é honrado nos dois, casando `Agent|Task`
no Claude Code e `collaborationspawn_agent` no Codex com uma string de matcher só. As
quatro linhas da matriz são `available`.

**`verify-receipt.sh` (PostToolUse / PostToolUseFailure) — a evidência de que um item
está pronto.** Esse *difere*, e a matriz diz isso. No Claude Code a maioria dos comandos
Bash que falham nem chega ao `PostToolUse` — eles disparam `PostToolUseFailure` com
`error: "Exit code 1"` — então os dois eventos juntos dão um recibo com exit code de
verdade. O disparo do `PostToolUse` ainda assim não é, por si só, um sucesso: três campos
do objeto de resposta dele (`returnCodeInterpretation`, `interrupted`, `backgroundTaskId`)
negam cada um um sucesso, e o recibo registra `outcome: nonzero` ou `incomplete` em vez de
um `0` forjado. O Codex não tem evento de falha de ferramenta, e o `PostToolUse` dele
dispara para sucesso e falha igualmente com `tool_response` só de stdout: um recibo no
Codex registra `exit_code: null`, `outcome: ran`, e prova que a verificação **rodou**
depois da última edição, nunca que ela passou. Por isso a linha é `substitute`, o `leopold doctor` cita o custo na
linha do Codex, e o bound ainda assim é entregue nos dois harnesses em vez de ser contido
à interseção.

**`done-gate.sh` (PreToolUse / TaskCompleted) — pronto significa verificado.** Este difere
pela *metade*. O gate de `PreToolUse` que recusa uma edição de `.leopold/PLAN.md`
transformando um `- [ ]` em `- [x]` é `available` nos dois — `Edit` / `Write` / `MultiEdit`
do Claude Code, `apply_patch` do Codex, cujo `tool_input.command` carrega o patch. O
`TaskCompleted`, onde exit 2 deixa a task pendente, só existe no Claude Code: o Codex não
tem evento de task nenhum, então a matriz marca essa linha como `substitute`, o instalador
recusa a spec lá pelo nome, e a metade do PLAN.md carrega o bound inteiro. O
`leopold doctor` nomeia na mesma linha o evento que falta no Codex em vez de deixar um
evento conectado parecer paridade.

**`compact-checkpoint.sh` (PreCompact / PostCompact) — a janela que sobrevive a uma
compactação.** `available` nos dois, e este surpreendeu a sonda: o Codex dispara os dois
eventos de compactação, com `trigger` mais `turn_id` e `model`. O que ele *não* carrega é
o `custom_instructions` antes e o `compact_summary` depois do Claude Code — o que aqui não
custa nada, porque o checkpoint é composto a partir de estado durável
(`.leopold/state.json`, `PLAN.md`, o journal) e nunca do resumo do payload. Veja
[Continuidade](continuity.md#compactacao-o-outro-jeito-de-uma-janela-ser-cortada).

**`stop-failure.sh` (StopFailure) — um erro de API é uma espera, não um veredito.** Só
Claude Code. Num turno que falha o `Stop` não dispara de jeito nenhum, então o
`StopFailure` é a única testemunha, e o `error` dele nomeia a classe (`rate_limit`,
`server_error`, `authentication_failed`). O Codex não tem hook de falha: um erro de API
encerra o turno como `turn.failed` no stream `--json`, que o driver lê no lugar — a matriz
marca a linha como `unavailable` e o `leopold doctor` diz isso em palavras em vez de
deixar o silêncio parecer cobertura.

**`file-watch.sh` (FileChanged) e `config-guard.sh` (ConfigChange) — os detectores de
segundo escritor e de adulteração.** Só Claude Code; as duas linhas são `unavailable` no
Codex, o instalador recusa as specs lá pelo nome, e o doctor imprime a consequência: um
segundo escritor nos arquivos do plano, e uma edição do wiring dos hooks no meio do run,
não são detectados no Codex.

**`review-lens-roles` — a única capacidade cujo lado Codex é o mais rico.** As lentes de
review do driver são **agent roles** nativos do Codex (`$CODEX_HOME/agents/<lens>.toml`,
honrados por `spawn_agent(agent_type=<lens>)` e ecoados de volta no `SubagentStart`); o
Claude Code não tem arquivos de role, então as lentes dele são as sessões SDK do próprio
driver e a matriz marca o *Claude Code* como `substitute`. A paridade não é afirmada duas
vezes — ela é derivada por teste da própria lista de lentes do driver.

Ou seja: autonomia não é exclusividade do Claude. O `/leopold-run` mantém uma sessão
Codex andando do mesmo jeito que mantém uma sessão do Claude Code — mesmos orçamentos,
mesma detecção de não-progresso, mesmo teto de contexto.

## O único passo manual no Codex

O Codex não executa um hook declarado no `config.toml` enquanto você não confiar nele
uma vez. Até lá ele fica inerte em silêncio — sem erro, simplesmente não roda.

O Leopold não tenta forjar essa aprovação. Dois caminhos:

1. **Abra o Codex uma vez e aprove os hooks do Leopold.** Depois disso a trava do git,
   o motor de continuidade e a política de permissão ficam vivos em toda sessão
   interativa.
2. **Instale o Leopold como plugin do Codex.** Hooks vindos de plugin já são confiados
   na instalação do plugin, então não tem passo separado.

Workers headless iniciados por `leopold run --provider codex` se armam sozinhos — um
run conduzido pelo driver fica travado desde o primeiro turno, tendo você aprovado
algo ou não.

O `leopold doctor` diz em qual estado você está.

## Instalando

```bash
./install.sh                     # todo harness encontrado na máquina
./install.sh --harness claude    # só Claude Code
./install.sh --harness codex     # só Codex
./install.sh --harness all       # os dois, instalados ou não
```

As skills vão para o diretório de skills de cada harness. Hooks, templates, docs e
extensions vão para um único home compartilhado — `~/.claude/leopold` quando o Claude
Code está em jogo (assim instalações existentes continuam funcionando), senão
`~/.codex/leopold`. Dá para sobrescrever com `LEOPOLD_HOME`.

A configuração do Codex é escrita no `config.toml` como um bloco delimitado por
marcadores:

```toml
# >>> leopold (managed) >>>
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/stop-continuity.sh"
timeout = 15

[[hooks.PreToolUse]]
matcher = "Bash|Edit|Write|MultiEdit|NotebookEdit"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/guard-irreversible.sh"
timeout = 5

[[hooks.PermissionRequest]]

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/permission-policy.sh"
timeout = 5
[[hooks.PreCompact]]

[[hooks.PreCompact.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/compact-checkpoint.sh"
timeout = 10

[[hooks.PostCompact]]

[[hooks.PostCompact.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/compact-checkpoint.sh"
timeout = 10

[[hooks.SubagentStart]]

[[hooks.SubagentStart.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/subagent-account.sh"
timeout = 10

[[hooks.SubagentStop]]

[[hooks.SubagentStop.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/subagent-account.sh"
timeout = 10

[[hooks.PreToolUse]]
matcher = "Agent|Task|collaborationspawn_agent"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/subagent-cap.sh"
timeout = 5

[[hooks.PostToolUse]]
matcher = "Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/verify-receipt.sh"
timeout = 10

[[hooks.PreToolUse]]
matcher = "Edit|Write|MultiEdit|apply_patch"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/done-gate.sh"
timeout = 5
# <<< leopold (managed) <<<
```

Reinstalar troca o bloco e mais nada. Sua config é copiada antes, e o arquivo mesclado
é validado — se não fosse parsear, a instalação volta atrás e imprime o bloco para
você colar na mão.

## As extensions instalam em todo harness que você tem

As quatro extensions embutidas — `serena`, `enhance`, `ovmem`, `gstack` — também não
são exclusivas do Claude. Cada uma instala, reporta e remove **por harness**:

| Extension | Claude Code | Codex CLI |
|---|---|---|
| serena | `claude mcp add --scope user` + 4 hooks no `settings.json` | `codex mcp add` + os mesmos 4 hooks no `config.toml`, `--context=codex`, `serena-hooks --client=codex` |
| enhance | `UserPromptSubmit` no `settings.json`, injeção em texto puro | `UserPromptSubmit` no `config.toml`, JSON `hookSpecificOutput.additionalContext` |
| ovmem | 4 hooks no `settings.json`, flush de 25s em processo | os mesmos 4 no `config.toml`; `SessionEnd` declarado com 3s e o flush destacado, porque o Codex limita esse hook a 3 segundos |
| gstack | `./setup --host claude` → `~/.claude/skills` | `./setup --host codex` → `~/.codex/skills` (checkout em `~/.gstack/repos/gstack`) |

Duas regras valem para as quatro. **Um escritor por formato:** o wiring em JSON e em
TOML mora num único helper compartilhado, `extensions/lib/harness.sh`, então os dois
harnesses não têm como divergir em silêncio. E **nada reporta por máquina:**
`status`, `remove` e `doctor` respondem uma linha por harness, então uma máquina com
dois harnesses nunca vê o estado de um passado como o dos dois, e o gate de confiança
dos hooks do Codex é nomeado em vez de aparecer como um verde que ainda não está no ar.

```bash
bash extensions/serena/manage.sh doctor   # ou ovmem / gstack / enhance
leopold doctor                            # todo harness presente, numa passada só
```

Os dados do engine são compartilhados mesmo com o wiring não sendo: o ovmem mantém um
diretório de memória por máquina, então uma decisão registrada numa sessão do Codex
volta numa do Claude Code, e o ledger e o prompt profile do enhancer são os mesmos
arquivos de qualquer cadeira.

Cada suíte é hermética — `HOME`/`CLAUDE_HOME`/`CODEX_HOME` temporários, CLIs stubadas,
sem rede: `make serena-test`, `make ovmem-test`, `make gstack-test`,
`make enhance-test`, mais o `make codex-install-test` para a instalação do Codex
inteira, de ponta a ponta.

## O dashboard lê runs do Codex

O `leopold watch` mostra tokens, custo e contexto reais num run do Codex — o painel
não fica em branco e, mais importante, nunca vira zero.

Ele acha o transcript do mesmo jeito nos dois harnesses: o caminho que o hook reportou
no `state.json`, ou então a sessão mais nova deste projeto — um transcript do Claude
Code em `~/.claude/projects/`, ou um rollout do Codex em
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` cujo `session_meta.cwd` é este projeto.
Depois ele fareja qual é qual e parseia de acordo: o `usage` + `model` por mensagem do
Claude Code, ou as linhas `event_msg` do Codex com `payload.type == "token_count"`
(`info.total_token_usage`, incluindo `cached_input_tokens` e
`reasoning_output_tokens`).

O Codex reporta tokens e nunca dólares, então o custo é precificado por uma tabela
interna por modelo, com input cacheado cobrado a 0.1x. Um modelo desconhecido cai numa
taxa padrão diferente de zero: um run precificado em zero desligaria o `--budget-usd`
em silêncio, o único modo de falha que um orçamento não pode ter. E um rollout vivo que
ainda não reportou uso diz **"waiting for session data…"** em vez de cravar `$0.00`.

As abas de dashboard das extensions seguem a mesma regra. Um `dashboard.module` no
`extension.json` pode ser um caminho relativo ao asset home (`ovmem/dashboard.py`),
resolvido Claude-first exatamente como os instaladores fazem — então a aba de memória
aparece numa máquina sem `~/.claude` em vez de sumir calada.

Coberto pelo `make watch-test` (só stdlib, sem rede), que checa a detecção do Codex, a
precificação, a descoberta por `cwd`, o fallback de modelo desconhecido e o caso do
"sem uso ainda".

## Escolhendo o harness de um run

```bash
leopold harness                    # o que tem aqui, e o que cada um consegue fazer
leopold run                        # conduz no harness padrão
leopold run --provider codex       # conduz no Codex
LEOPOLD_PROVIDER=codex leopold run # o mesmo, pelo ambiente
```

A precedência é `--provider` → `LEOPOLD_PROVIDER` → o único harness instalado → **o
harness de cuja sessão o Leopold foi lançado** → Claude Code como último recurso. Um
nome que o Leopold não reconhece é erro, não fallback silencioso — conduzir um run no
harness errado por causa de typo não é um modo de falha que valha a pena existir.

Esse quarto passo existe porque o desempate era o terceiro: numa máquina com os dois, o
`workflow --run` lançado de uma sessão Codex iniciava o Agent SDK do Claude. Cada CLI
marca o ambiente do filho — o Codex exporta `CODEX_THREAD_ID` (e `CODEX_CI`), o Claude
Code exporta `CLAUDECODE` / `CLAUDE_CODE_SESSION_ID` — então o run agora pertence à
cadeira de onde você o lançou. Sem marcador nenhum, o fallback para Claude é o de sempre.

### Um run, dois harnesses

Um run não precisa escolher um. O `--provider hybrid` atribui um harness **por papel**:

```bash
leopold workflow --run --provider hybrid \
  --executor-provider codex \
  --review-provider claude
```

`executor` são os workers, `review` são as lentes de review, painéis de hipótese e
juízes de torneio, `conductor` são as decisões de turno e o roteamento. Um papel sem
flag herda o default resolvido. O provider de cada agente cai no `.leopold/events.jsonl`
(`run_start`, `wf_phase`, `wf_agent_start`), porque um run dividido entre dois harnesses
que não registra qual respondeu é um run que você não consegue depurar.

Um run sem flag de híbrido não gera atribuição de papel nenhuma — que é exatamente por
que um run single-provider continua byte-idêntico ao que sempre foi.

## Como o driver alcança cada harness

Tudo no driver — turnos do worker, decisões do conductor, lentes de review, painéis
de hipótese, roteamento, juízes de torneio — passa por um único seam,
`packages/driver/src/sdk.ts`, e consome um único formato de mensagem. O provider atrás
desse seam é trocável:

- **claude** — o `query` do Agent SDK, no seu próprio login do Claude Code.
- **codex** — `codex exec --json`, no seu próprio login do Codex. Itens multi-turno
  usam `codex exec resume <thread_id>`, o que dá ao worker a propriedade que importa:
  contexto novo por item do plano, contexto contínuo dentro de um item.

Como o formato é idêntico, nenhum call site sabe qual harness respondeu. O mapeamento
que o lado Codex precisa fazer é pequeno e mora em um arquivo só:

| Conceito do driver | Codex |
|---|---|
| `cwd` | `-C <dir>` |
| `model` | `-m <model>` |
| `effort` | `-c model_reasoning_effort=…` (`max` → `xhigh`) |
| sessão read-only (`disallowedTools`) | `--sandbox read-only` |
| guard do `canUseTool` | o hook PreToolUse + `--dangerously-bypass-hook-trust` |
| `total_cost_usd` | uso de tokens precificado por modelo |

Vale saber sobre esse último: o Codex reporta contagem de tokens, nunca um valor em
dólar, então o `--budget-usd` precifica o run com uma tabela interna. Um modelo
desconhecido cai numa taxa padrão em vez de zero — precificar um run como zero
desligaria o orçamento em silêncio, e esse é o único modo de falha que um orçamento
não pode ter.
