# Harnesses: Claude Code e Codex

Leopold não é um plugin do Claude Code que por acaso roda em outro lugar. É uma
camada de harness que fica em cima do agente de código que você usa — e hoje isso
significa **Claude Code** e **OpenAI Codex CLI**.

Isso funciona não por abstração esperta do lado do Leopold, mas porque o Codex
reimplementou o contrato de hooks do Claude Code quase literalmente: mesmos nomes de
evento, mesmas chaves de payload, mesmos formatos de resposta. Os dois hooks do
Leopold rodam nos dois harnesses como os mesmos scripts shell, sem alteração.

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

## Os hooks são os mesmos scripts

O engine de run se apoia em exatamente dois hooks sempre ativos (um terceiro, o
[`persona-guard.sh`](../reference/persona-guard-hooks.md), é armado apenas
enquanto um persona run está ativo — o mesmo script nos dois harnesses também).

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

Ou seja: autonomia não é exclusividade do Claude. O `/leopold-run` mantém uma sessão
Codex andando do mesmo jeito que mantém uma sessão do Claude Code — mesmos orçamentos,
mesma detecção de não-progresso, mesmo teto de contexto.

## O único passo manual no Codex

O Codex não executa um hook declarado no `config.toml` enquanto você não confiar nele
uma vez. Até lá ele fica inerte em silêncio — sem erro, simplesmente não roda.

O Leopold não tenta forjar essa aprovação. Dois caminhos:

1. **Abra o Codex uma vez e aprove os hooks do Leopold.** Depois disso a trava do git
   e o motor de continuidade ficam vivos em toda sessão interativa.
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
[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/guard-irreversible.sh"
timeout = 5

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "/home/voce/.claude/leopold/hooks/stop-continuity.sh"
timeout = 15
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
