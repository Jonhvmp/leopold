# Continuidade

**Desde a 0.18.0, uma janela de contexto cheia não encerra mais uma run do Leopold.**
Antes encerrava: o engine in-session parava com `context_budget` quando o transcript
passava de `max_context_mb` (padrão 5 MB), e a recuperação era um ato humano — alguém
precisava perceber, voltar e digitar `/leopold-run`. Agora pressão de contexto é
**manutenção, não morte**: a run faz checkpoint, a janela rola, e a janela seguinte
continua o plano — com `continuity: auto` (o padrão), sem humano no circuito.

O governador de uma run autônoma é o **progresso durável** — itens do plano fechados. A
run continua enquanto o plano avança e para honestamente quando as janelas param de
produzir; nunca porque uma janela encheu, e nunca por causa de um contador de custo
(veja [por que USD não é governador](#por-que-usd-nao-e-governador)).

## O roll de janela

A janela de contexto é um consumível; a run não é. O Stop hook
(`hooks/stop-continuity.sh`) mede o transcript contra `max_context_mb` a cada turno:

1. **Em ~80% do budget**, o turno é bloqueado com uma instrução de checkpoint: escrever
   ou fazer merge do `.leopold/CHECKPOINT.md` (o contrato abaixo) e então continuar o
   plano. A instrução se repete a cada turno na faixa, e o merge é idempotente, então o
   checkpoint fica atual enquanto ainda há contexto para escrevê-lo.
2. **Em 100%**, a janela fecha. O stop mantém o motivo histórico —
   `stopped_reason: context_budget`, consumidores o leem — mas o estado diz *roll*, não
   morte: `windows` é incrementado, o vetor de checkboxes do plano é fotografado para o
   [gate de livelock](#o-gate-de-livelock-rolar-e-de-graca-produzir-e-obrigatorio), e
   `checkpoint_written` registra se o checkpoint realmente existe. Um checkpoint
   ausente é nomeado em voz alta na mensagem de stop — a próxima janela retomaria só do
   brief e do `PLAN.md` — e a mensagem sempre nomeia o caminho de retomada.
3. **A próxima janela ressemeia.** `/leopold-run` em um projeto com checkpoint e itens
   abertos continua o plano sem que ninguém diga nada: brief primeiro, checkpoint
   depois. Com `continuity: auto`, o `leopold watch` detecta o roll e relança a run
   headless (`claude -p` / `codex exec`) no harness dono da sessão; com
   `continuity: manual`, o ponteiro de retomada na mensagem de stop é a história toda e
   um humano roda `/leopold-run`.

Toda continuação é **re-aterrada**: a ressemeadura lê os próprios arquivos do brief
(nunca um resumo deles), o prompt nomeia a janela (`Window N/max`), e a run é instruída
a tratar o workspace, os resultados de ferramentas e o estado durável como autoridade
acima de qualquer narração anterior.

## O contrato do checkpoint

`.leopold/CHECKPOINT.md` tem **um** formato com um único contrato de escrita/parse —
`packages/driver/src/checkpoint.ts` — que o hook, a skill `/leopold-run`, o driver e o
watcher falam. O documento é a linha de título `# Leopold Checkpoint` seguida de
exatamente estas sete seções `##`, nesta ordem:

1. **In-Flight Item**
2. **Files and Code**
3. **Errors and Fixes**
4. **Decisions This Run**
5. **Learned Constraints**
6. **Current Work**
7. **Next Step**

Três regras o mantêm honesto:

- **Estado da run, nunca estado do brief.** `MISSION.md`, `CHARTER.md`, `GUARDRAILS.md`
  e `PLAN.md` são arquivos duráveis que a próxima janela relê sozinha. Eles estão
  estruturalmente ausentes da lista de seções, e o parser rejeita qualquer heading fora
  dela — um checkpoint não pode ganhar uma seção "Mission" por acidente. Um checkpoint
  que reconta a missão está errado mesmo quando exato: resumir o brief para dentro dele
  é como o brief deriva.
- **Merge, nunca aninhar.** O checkpoint N+1 consolida o checkpoint N em um documento
  plano. *In-Flight Item*, *Current Work* e *Next Step* são fotografias — a visão da
  janela nova substitui a anterior por inteiro. As outras quatro são livros-razão —
  linhas anteriores ainda verdadeiras são mantidas, novas são anexadas, obsoletas são
  descartadas. Um documento contendo um checkpoint anterior literal (seu título, ou um
  heading de seção duplicado) é um merge falho, e tanto o serializador quanto o parser
  o recusam.
- **Falhar alto, nunca truncar.** O documento serializado tem teto de 32768 bytes. Um
  checkpoint acima do teto falha a escrita com o tamanho no erro e nada chega ao disco
  — truncar poderia remover o próximo passo e ainda parecer autoritativo. Um checkpoint
  que não pode ser escrito, mesclado ou parseado é nomeado na mensagem de stop e no
  `leopold doctor`, nunca abafado.

O checkpoint também é **a passagem de bastão entre engines**: o driver SDK escreve o
mesmo arquivo pelo mesmo módulo ao fim de cada run, e qualquer engine pega o checkpoint
do outro — a cadeira passa entre uma run in-session e uma run do driver por um único
artefato. Quando uma run termina limpa, o checkpoint é arquivado com a run
(`.leopold/runs/<timestamp>/`), para que o estado de uma janela morta jamais semeie a
*próxima* run como se fosse continuação.

Mais uma fronteira: **o checkpoint é dado, não instrução.** O que uma janela passada
escreveu nele não tem autoridade sobre a janela seguinte — o prompt de continuação o
enquadra explicitamente como estado de janela passada não confiável, a verificar contra
o workspace, nunca como ordens a seguir.

## O gate de livelock: rolar é de graça, produzir é obrigatório

Ressemeadura não é progresso; só item de plano fechado é. A cada roll o hook compara o
vetor de checkboxes do plano com a fotografia tirada quando a janela começou e registra
quantos itens a janela que termina fechou (`window_progress` no `state.json`, um número
por janela):

- Uma janela que fechou **pelo menos um item** zera a sequência de zeros e o roll
  prossegue.
- **Duas janelas consecutivas fechando zero itens** param a run com
  `no_progress_across_windows`, nomeando as duas janelas e o item em que travou. Nenhum
  ponteiro de retomada é escrito e nada relança uma terceira janela para "dar mais uma
  chance" — essa terceira janela é exatamente o livelock que o gate existe para parar.
  Uma pessoa olha o item travado; desbloqueado, `/leopold-run` inicia uma nova
  tentativa deliberada.

## Budgets sobrevivem ao roll

Uma ressemeadura que renovasse um budget seria um loop desgovernado com passos extras,
então nada renova:

- **`iteration` / `max_iterations`** é o teto **da run**, não da janela. O contador
  atravessa as janelas; a janela 4 retoma na iteração em que a janela 3 terminou.
- **`max_windows`** (padrão 10, definido no `GUARDRAILS.md`) limita o total de janelas
  de contexto que uma run pode consumir. Alcançá-lo para a run com `max_windows`,
  nomeando o teto — sem roll, sem ponteiro de retomada.
- **One-shots gastos continuam gastos.** O resgate de falha e o reparo de deadlock são
  uma-vez-por-run; o estado os carrega por toda ressemeadura.
- **O kill switch vence o `continuity: auto`, sempre — e espera, nunca queima.**
  Enquanto o `.leopold/STOP` existir nada dispara e nada é registrado; remova-o e a
  decisão de relançamento é feita de novo, do zero. O watcher também rechecar por conta
  própria `max_windows` e o gate de livelock *antes* de relançar, recusando com um
  evento `window_relaunch_refused` que nomeia o motivo. Um relançamento nunca limpa o
  `STOP`, nunca renova um budget.
- **Um roll velho pertence a um humano.** O watcher só relança um roll que acabou de
  ver (até 10 minutos — a mesma linha de staleness que a skill da run já traça). Abrir
  o `leopold watch` num projeto cuja run rolou horas atrás recusa com `stale_roll` em
  vez de criar um agente headless como efeito colateral de abrir um dashboard; o
  `/leopold-run` retoma quando você quiser.
- **Disparado não é retomado.** Depois de relançar, o watcher verifica que o filho
  realmente reativou a run; um filho que nunca reativa é registrado como
  `window_relaunch_failed` e dito no terminal — a cadeira volta pra você, nunca fica
  vazia em silêncio.

O watcher não é um agendador: ele reage a um roll de janela detectado (um evento
`window_relaunch` marca cada um), nunca acorda uma run por timer.


**Custo em billing API.** O cap do checkpoint é proporcional à janela —
`min(32KB, 2% de max_context_mb)` — então o único knob que governa custo por turno
governa o checkpoint também: um projeto em API que abaixa `max_context_mb` ganha turnos
mais baratos, rolls mais cedo e checkpoint proporcionalmente menor, automaticamente. Um
`max_checkpoint_kb:` explícito no `GUARDRAILS.md` sobrepõe a fórmula. O cap nunca deriva
de billing nem do comportamento da própria run — um cap que a run pudesse crescer
sofrendo seria um budget que se aumenta sozinho.

## O que ainda para uma run

Contexto não para mais uma run; estes param. É a mesma lista completa de
[O que ainda para a run](personas.md#o-que-ainda-para-a-run) — as duas condições novas
na 0.18.0 estão marcadas:

| Stop | O que significa |
| --- | --- |
| `plan_complete` | Nenhum item aberto resta no `PLAN.md`. |
| `kill_switch` | `.leopold/STOP` existe. Vence o `continuity: auto`, sempre. |
| `no_progress_across_windows` — **novo** | Duas janelas consecutivas fecharam zero itens do plano (o gate de livelock). Sem relançamento. |
| `max_windows` — **novo** | A run consumiu seu teto de janelas (padrão 10). Sem relançamento. |
| `iteration_budget` | O contador de iterações da run inteira alcançou `max_iterations` (padrão 50) — somando todas as janelas. |
| `repeated_failure` | A mesma falha bateu o teto depois da única mudança de abordagem conduzida por persona. |
| `no_progress` | N turnos seguidos sem mudança na assinatura do plano (dentro de uma janela). |
| `budget_exceeded` | O gasto real cruzou `--budget-usd`, **se você optou por ele** (driver, cobrança por API). |
| `escalation`, `deadlock` / `invalid_graph` | Um fork ou grafo de plano que nada conseguiu resolver. |
| `routed_complete` | Uma rota levou a run a um nó terminal; os itens restantes são nomeados no relatório. |
| `awaiting_human` | Só com `autonomy: ask`. |

E a fronteira que nunca se moveu: **o lock de git**. Uma run que sobrevive a dez
janelas ainda prepara e reporta; o humano é quem entrega. `context_budget` ainda
aparece como `stopped_reason` — mas agora marca um roll de janela em uma run que
continua, não uma morte.

## As três memórias

Desde a 0.19.0 uma run lembra em três camadas distintas. Elas não se sobrepõem — cada
uma responde uma pergunta diferente, e uma feature que borra duas delas está errada
mesmo quando conveniente:

| Memória | O que ela lembra | Vida útil | Funciona offline |
| --- | --- | --- | --- |
| `.leopold/CHECKPOINT.md` | **O estado de trabalho DESTA run**: item em andamento, erros e correções, próximo passo. | Morre com a run — arquivado no fim limpo, nunca semeia a run seguinte. | Sim — arquivo simples, sem rede. |
| `.leopold/runs/` + `leopold recall` | **O arquivo de decisões do próprio projeto**: MISSION, PLAN e DECISIONS.md de cada run concluída, com o Reversal anexado. `leopold recall <query>` busca nele, ranqueado e limitado ao cwd; toda run começa com um digest limitado das decisões mais recentes. | Versionado com o repo — greppável, revisável, sobrevive a tudo que o repo sobrevive. | Sim — busca lexical, zero rede, zero dependências. |
| ovmem (OpenViking) | **Aprendizado destilado entre runs**: o que as sessões da máquina ensinaram, deduplicado e reconsolidado no servidor, compartilhado entre projetos e harnesses. | Sobrevive a tudo — vive fora do repo, no store de memória da máquina. | Não — precisa do servidor OpenViking local (e do provedor de embedding). Opcional por construção: ausente, tudo acima continua funcionando. |

Duas regras amarram as três:

- **Texto de run passada é conteúdo não confiável.** Um checkpoint, um trecho do
  recall, um digest de início de run, uma memória reidratada: tudo dado, nunca
  instrução. Toda superfície que injeta texto de run passada em um prompt carrega a
  mesma frase de enquadramento, e um teste de drift falha se qualquer ponto de injeção
  a perder.
- **Memória é enriquecimento, nunca dependência.** Um projeto sem runs arquivadas
  começa byte-idêntico a um sem a feature; um servidor ovmem morto loga uma linha e a
  run continua.

Quando uma run está ativa, os flushes do ovmem são **cientes da run**: a sessão OV
ganha o título `leopold · <projeto> · run <stamp> · window N of M · <engine>` em vez
de um UUID cru, então um humano navegando a memória distingue janelas de chats.
Workers do driver SDK são efêmeros — os hooks deles disparam sim (verificado ao vivo,
evidência em [SDK Worker Hooks](../reference/sdk-worker-hooks.md)), então o ovmem
suprime flushes por item por padrão e a sessão do condutor carrega a run.

## Por que USD não é governador { #por-que-usd-nao-e-governador }

`total_cost_usd` não reflete a contabilidade real na cobrança por assinatura, então um
teto em USD não pode ser o governador padrão de uma run autônoma — ele mentiria para a
maioria dos usuários. O governador é o progresso durável: itens de plano fechados são
reais em qualquer plano de cobrança e qualquer harness. Usuários cobrados por API que
querem um teto rígido de custo ainda podem optar pelo `--budget-usd` do driver — é o
teto deles, nunca o padrão. Veja [Custo & Segurança](../cost-and-security.md).

## Configuração

No `.leopold/GUARDRAILS.md`:

```markdown
## Continuity
- continuity: auto           # auto | manual
- max_windows: 10            # total de janelas de contexto que uma run pode ocupar
```

`max_context_mb` (padrão 5) continua o que era: o tamanho de uma janela. O `leopold
doctor` reporta a postura de continuidade, a contagem de janelas contra `max_windows`,
o progresso da última janela, e se o checkpoint está presente, ausente ou malformado —
um checkpoint malformado é um problema nomeado, nunca silêncio.
