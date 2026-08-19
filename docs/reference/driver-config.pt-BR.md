# Configuração do Driver

Configuração do [driver SDK](../architecture/driver.md). Ele lê o brief em
`.leopold/` do projeto atual e roda o loop de orquestração.

## Uso

```bash
npm i -g leopold-driver      # or: cd packages/driver && npm install && npm run build

# from a project that has a .leopold/ brief, with Claude Code logged in:
leopold run                          # conduct the run (serial)
leopold run --dry-run                # load the brief, show the plan, do nothing
leopold run --parallel 3             # independent plan items concurrently, one worktree each
leopold run --worktree               # isolate the whole run in a git worktree
leopold run --budget-usd 5           # hard-stop at a USD cap
leopold workflow                     # compile the brief into a dynamic workflow (emit)
leopold workflow --print             # dump the compiled args JSON
leopold workflow --run               # execute it headlessly (experimental runtime)
leopold graph                        # print + validate the plan's graph (exit 1 if invalid)
leopold graph --mermaid              # the same graph as a fenced mermaid diagram
leopold insights                     # summarize the run's events.jsonl
leopold recall "consulta"            # busca no arquivo de runs do projeto (decisões + Reversals, offline)
leopold persona run <flow>           # conduz um run de cliente sintético headless (motor do driver)
leopold persona report <run-dir>     # re-sintetiza o REPORT.md só dos diários do run
leopold persona list                 # personas (status de contrato) e fluxos do projeto
```

## Pré-voo do grafo (`leopold graph`)

O comando que você roda antes de confiar em um plano. Ele lê o `.leopold/PLAN.md` e
monta o mesmo grafo em que o scheduler roteia — tipos de nó (`@gate`, `@human`,
`@tool`, `@verify`), arestas de dependência `(after:)`, rotas condicionais `@on`,
sinais `@emit`/`@needs` —, imprime e valida. **Um grafo malformado falha aqui, antes
do primeiro agente rodar**, com os itens culpados nomeados:

```
✗ Cycle: item 4 ("Run the migration") -> item 9 ("Roll back") -> item 4 (…). …
✗ item 7 ("Ship it") routes to item 12, which does not exist (`@on fail`).
✗ item 5 ("Deploy") needs signal "approved", which no item emits.
✗ item 8 ("Clean up") is unreachable: no wave and no route can dispatch it.
```

| Flag | Propósito |
| --- | --- |
| *(nenhuma)* | árvore ASCII: uma linha por nó com tipo, checkbox, dependências e sinais; rotas aparecem sob a origem como `→ on <cond> → item N` |
| `--mermaid` | um bloco `mermaid` — uma forma por tipo de nó, setas pontilhadas rotuladas para as rotas |
| `--json` | a forma de máquina: `{ plan, nodes, edges, diagnostics }` |
| `--quiet` | não imprime nada quando está tudo certo — para um pré-voo em script |
| `--plan CAMINHO` | valida um plano fora do `.leopold/` |

Códigos de saída: `0` grafo sadio, `1` malformado (diagnósticos no stderr), `2` não
havia plano para ler. Então um gate é só:

```bash
leopold graph --quiet || exit 1
```

Um plano que não usa nada da gramática de grafo nunca falha nessa checagem: arestas
`(after:)` só apontam para itens anteriores, então não podem ciclar, apontar para o
vazio nem isolar nada.

## Runs de persona (`leopold persona`) { #persona-runs-leopold-persona }

O motor headless sobre o módulo de
[teste com personas](../concepts/persona-testing.md). Ele conduz os artefatos de
`.leopold/persona/` que uma sessão construiu com `/leopold-persona` — um worker
supervisionado por persona através de `flows/<flow>.md`, o contrato do diário, a
allowlist de domínios e o limite de irreversibilidade impostos pelo driver,
continuidade de janela a partir do `JOURNEY.jsonl` — e escreve o `REPORT.md`
determinístico entre personas. Mesma árvore de run da skill na sessão,
byte-compatível.

```bash
leopold persona run checkout                     # o elenco inteiro, serial
leopold persona run checkout --persona maria     # uma persona
leopold persona run checkout --persona all --parallel 3   # fan-out do elenco
leopold persona run checkout --provider codex    # conduz no Codex
leopold persona report .leopold/persona/runs/<run-dir>    # relatório só dos diários
leopold persona list                             # status de contrato + veredito de parse dos fluxos
```

| Flag | Padrão | Propósito |
| --- | --- | --- |
| `--persona <id>\|all` | `all` | roda uma persona ou o elenco inteiro |
| `--parallel N` | `1` | roda até N personas ao mesmo tempo, cada uma no seu subdiretório de run (sem worktree — personas escrevem artefatos, não código) |
| `--provider claude\|codex` | resolvido como [acima](#escolhendo-o-harness) | qual harness roda os workers de persona |

`persona report <run-dir>` reescreve o `REPORT.md` só dos diários — byte a byte
idêntico fora do marcador de sumário executivo — então um relatório é sempre
reproduzível a partir do seu run. `persona list` sai com 0 sempre, incluindo a
resposta honesta de "nada pra rodar".

| Var | Padrão | Propósito |
| --- | --- | --- |
| `LEOPOLD_APP_VERSION` | a seção "App version pin" do fluxo | a identidade do build pinada em todo cabeçalho de diário e relatório |
| `LEOPOLD_WEBHOOK` | nenhum | as mesmas notificações JSON mascaradas do `leopold run` |

## Autenticação

Usa o seu login existente do harness — Claude Code ou Codex — para o worker, o maestro
e cada agente de painel. **Nenhuma API key é necessária.** `ANTHROPIC_API_KEY` só entra
em um ambiente headless sem autenticação do Claude Code.

## Escolhendo o harness

Todo comando que fala com um modelo aceita `--provider claude|codex` — o `run`, o
`workflow --run` **e** o `persona run`. Ordem de resolução:

1. `--provider claude|codex`
2. `LEOPOLD_PROVIDER`
3. o único harness instalado, se só houver um
4. **o harness de cuja sessão o Leopold foi lançado**
5. Claude Code

O passo 4 é o que importa numa máquina com os dois. Cada CLI marca o ambiente do filho
— o Codex exporta `CODEX_THREAD_ID` (e `CODEX_CI`), o Claude Code exporta `CLAUDECODE` /
`CLAUDE_CODE_SESSION_ID` — então um run lançado de uma sessão Codex pertence ao Codex em
vez de cair no desempate. Sem marcador nenhum, o fallback para Claude é o de sempre.

```bash
leopold run --provider codex
leopold workflow --run --provider codex
LEOPOLD_PROVIDER=codex leopold run
```

### Híbrido: um harness por papel

Um mesmo run pode executar num harness e revisar no outro:

```bash
leopold workflow --run --provider hybrid \
  --executor-provider codex \
  --review-provider claude
```

| Papel | Cobre |
| --- | --- |
| `executor` | os workers que fazem os itens do plano |
| `review` | lentes de review, painéis de hipótese, juízes de torneio |
| `conductor` | decisões de turno e smart routing |

Um papel sem flag herda o default resolvido, então `--provider hybrid` sozinho é todo
papel no mesmo harness, e não um run meio configurado. O provider de cada agente é
registrado no `.leopold/events.jsonl` (`run_start`, `wf_phase`, `wf_agent_start`), então
a trilha de auditoria diz quem rodou o quê em vez de deixar isso para inferência.

Equivalentes em env: `LEOPOLD_EXECUTOR_PROVIDER`, `LEOPOLD_REVIEW_PROVIDER`,
`LEOPOLD_CONDUCTOR_PROVIDER`. Uma flag ganha da env para o mesmo papel.

Um run sem flag de híbrido não gera atribuição de papel nenhuma — é isso que mantém um
run single-provider byte-idêntico.

## Flags

| Flag | Padrão | Propósito |
| --- | --- | --- |
| `--parallel N` | `1` | roda até N itens independentes do plano ao mesmo tempo, cada um na própria worktree, reaplicando cada diff na árvore principal como um patch staged |
| `--worktree` | desligado | isola uma run serial em uma worktree git dedicada |
| `--budget-usd N` | nenhum | interrompe a run quando o gasto real acumulado atinge N |
| `--no-review` | review ligado | desliga o painel de revisão de lentes diversas |
| `--no-conformance` | conformidade ligada | desliga a lente de conformidade (só ativa em itens que declaram linhas de aceite `@scenario`) |
| `--max-review-rounds N` | `2` | rodadas de revisão→correção por item antes de ele fechar mesmo assim |
| `--no-hypotheses` | painel ligado | desliga o painel de causa raiz em itens em nova tentativa |
| `--no-literal-reset` | reset ligado | para de restaurar o snapshot pré-tentativa em nova tentativa numa run isolada (numa run não isolada cai para reenquadrar) |
| `--best-of-k N` | `1` | resolve um item crítico e isolado em worktree por um torneio de N tentativas independentes (limitado a 2..6; opt-in, custa N×) |
| `--smart-routing` | desligado | pesquisa o raio de impacto real de cada item antes de rotear esforço (cai para palavras-chave; nunca rebaixa um piso critical) |
| `--slice-scope` | desligado | entrega o conjunto de arquivos do smart-routing ao worker como uma nota de escopo "comece por estes arquivos" (precisa de `--smart-routing`) |
| `--learn-on-finish` | desligado | em um término limpo, minera a run em propostas de emendas ao charter |
| `--ask` | off | restaura o `@human` que trava: a run para com `awaiting_human` em vez de decidir o nó sob um papel sintetizado |
| `--autonomy full\|ask` | `full` | o mesmo knob por extenso (`ask`, `halt` e `human` significam todos `ask`) |
| `--dry-run` | — | carrega o brief e reporta; não roda nada |

## Variáveis de ambiente

| Var | Padrão | Propósito |
| --- | --- | --- |
| `LEOPOLD_CONDUCTOR_MODEL` | o padrão do seu Claude Code | o modelo do maestro (e dos painéis) |
| `LEOPOLD_WORKER_MODEL` | o padrão do seu Claude Code | o modelo do worker |
| `LEOPOLD_MAX_TURNS_PER_ITEM` | `40` | budget de turnos do worker por item |
| `LEOPOLD_WEBHOOK` | nenhum | URL para notificações JSON via POST (Slack/Discord/etc.) |
| `LEOPOLD_WORKTREE` | `0` | `1` = o mesmo que `--worktree` |
| `LEOPOLD_BUDGET_USD` | nenhum | o mesmo que `--budget-usd` |
| `LEOPOLD_REVIEW` | `1` | `0` = o mesmo que `--no-review` |
| `LEOPOLD_CONFORMANCE` | `1` | `0` = o mesmo que `--no-conformance` |
| `LEOPOLD_MAX_REVIEW_ROUNDS` | `2` | o mesmo que `--max-review-rounds` |
| `LEOPOLD_PARALLEL` | `1` | o mesmo que `--parallel` |
| `LEOPOLD_HYPOTHESES` | `1` | `0` = o mesmo que `--no-hypotheses` |
| `LEOPOLD_LITERAL_RESET` | `1` | `0` = o mesmo que `--no-literal-reset` |
| `LEOPOLD_BEST_OF_K` | `1` | o mesmo que `--best-of-k` (>1 ativa; limitado a 2..6) |
| `LEOPOLD_SMART_ROUTING` | `0` | `1` = o mesmo que `--smart-routing` |
| `LEOPOLD_SLICE_SCOPE` | `0` | `1` = o mesmo que `--slice-scope` |
| `LEOPOLD_LEARN_ON_FINISH` | `0` | `1` = o mesmo que `--learn-on-finish` |
| `LEOPOLD_AUTONOMY` | `full` | `ask` = o mesmo que `--ask` (também respeitado pelo Stop hook e pelo engine de workflow) |
| `ANTHROPIC_API_KEY` | nenhum | só para ambientes headless sem autenticação do Claude Code |

## Toggles no brief (GUARDRAILS.md)

A postura de orquestração pode viver junto com o brief em vez da linha de comando.
O `GUARDRAILS.md` pode definir qualquer um destes como `key: on|off`:

```markdown
## Judgment posture
- autonomy: full             # full | ask

## Quality & orchestration (SDK driver)
- review: on
- conformance: on
- hypotheses: on
- literal_reset: on
- best_of_k: 1
- smart_routing: off
- slice_scope: off
- learn_on_finish: off
```

Precedência: **flag de CLI / env var explícita → GUARDRAILS.md → padrão embutido.**

### `autonomy: full | ask` { #autonomy }

O `autonomy` é o único toggle que não é `on|off` — e o único que muda o que um plano
*significa*.

| Valor | O que um nó `@human` faz |
| --- | --- |
| `full` *(padrão)* | Nada trava por uma decisão de julgamento. O Leopold sintetiza o papel que a decisão exige, o assume, conclui o item e registra a decisão no `DECISIONS.md` com uma linha de **Reversal**. Escalações, grafos inválidos e falhas repetidas recebem o mesmo tratamento. |
| `ask` | Os dois engines param no nó com `awaiting_human`, nomeiam o item e deixam tudo staged. Responda, marque o item `[x]` e rode de novo para retomar. |

`ask`, `halt` e `human` escrevem a mesma postura estrita; um valor não reconhecido é
ignorado e o padrão vale. O driver, o `/leopold-workflow` e o Stop hook in-session leem
essa mesma chave com a mesma precedência, então um plano significa uma coisa só nos dois
engines.

**Uma persona decide; ela nunca publica.** `git commit`, `push`, force-push, `tag`,
`publish` e abrir um PR externo continuam negados sob qualquer postura, e nenhuma persona
pode aumentar um budget, limpar o kill switch ou editar o `GUARDRAILS.md`. Veja
[Personas](../concepts/personas.md).

## Condições de parada

Vêm do `.leopold/GUARDRAILS.md`, as mesmas do engine in-session: plano completo,
kill switch (`touch .leopold/STOP`), falhas repetidas, o budget de iterações, o budget em
USD e uma escalação ou grafo inválido que os caminhos de persona não conseguiram resolver.

O `awaiting_human` **não** está entre elas sob a postura padrão — um nó `@human` é
decidido, não estacionado. Defina `autonomy: ask` para tê-lo de volta.

A lista completa e autoritativa de todas as condições de parada restantes — e, para cada
uma, se uma persona pode afetá-la — está em
[O que ainda para a run](../concepts/personas.md#o-que-ainda-para-a-run).

## Notificações

Ao concluir ou escalar, o driver escreve no terminal e no `events.jsonl`,
e faz POST de JSON para `LEOPOLD_WEBHOOK` se estiver definido:

```json
{ "title": "Leopold finished", "body": "Plan complete; everything staged.", "source": "leopold" }
```

Quando `learn_on_finish` está ligado, o aviso de conclusão também lista as emendas
propostas ao charter (escritas em `.leopold/CHARTER-amendments.md`; o charter
em si nunca é editado).
