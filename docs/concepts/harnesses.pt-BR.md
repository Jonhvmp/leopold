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

O Leopold se apoia em exatamente dois hooks.

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
com `cwd`, `transcript_path` e `stop_hook_active`, e honra a mesma resposta:

```json
{"decision":"block","reason":"…"}
```

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

## Escolhendo o harness de um run

```bash
leopold harness                    # o que tem aqui, e o que cada um consegue fazer
leopold run                        # conduz no harness padrão
leopold run --provider codex       # conduz no Codex
LEOPOLD_PROVIDER=codex leopold run # o mesmo, pelo ambiente
```

A precedência é `--provider` → `LEOPOLD_PROVIDER` → o que estiver instalado → Claude
Code como desempate. Um nome que o Leopold não reconhece é erro, não fallback
silencioso — conduzir um run no harness errado por causa de typo não é um modo de
falha que valha a pena existir.

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
