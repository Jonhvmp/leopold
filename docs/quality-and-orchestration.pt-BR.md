# Qualidade e orquestração

O Leopold não se limita a manter o Claude Code rodando — ele faz cada item sair com
qualidade maior, roda trabalho independente em paralelo e ajusta o quanto o modelo pensa
em cada item. São essas as alavancas que transformam "um agente que não para" em "um agente
que merece a cadeira". Todas se apoiam em capacidades nativas do Claude Code.

## O gate de review — um painel de céticos

O worker reportar `done` depois de build/lint/test não basta — ninguém *revisou*
a mudança. E um revisor único compartilha um modo de falha com o worker: ele pode estar
plausível-e-errado na mesma direção. Então, antes de um item poder fechar, um **painel de
céticos independentes** (cada um em sua própria sessão do Claude Code, podendo assim invocar
as skills nativas `/code-review` e `/security-review`) lê o diff não commitado do item — cada
um através de uma **lente distinta**:

| Item | Painel |
| --- | --- |
| comum | corretude |
| diff sensível (`auth\|secret\|billing\|payment\|.env\|…`) | corretude + segurança |
| crítico (billing, auth, migrações, …) | corretude + segurança + funciona-de-verdade |

Diversidade ganha de redundância: três revisores idênticos reencontram os mesmos bugs; três
lentes diferentes pegam modos de falha que as outras estruturalmente não veem. Os veredictos são
**unidos** (deduplicados por arquivo+problema):

- **Painel limpo** → o item fecha.
- **Achados bloqueantes** → voltam direto para o worker corrigir, e o item passa por novo review. Até
  `--max-review-rounds` (padrão 2) antes de o item ser liberado mesmo assim (para um painel
  teimoso não travar a run).

Um veredicto não parseável **falha fechado** — ele nunca passa pelo gate silenciosamente. O gate vem
ligado por padrão; `--no-review` / `LEOPOLD_REVIEW=0` / `review: off` no GUARDRAILS desliga.

> Dica para o worker: faça self-review com `/code-review` *antes* de reportar done, para o gate
> passar de primeira. A skill `/leopold-run` diz exatamente isso a ele.

## Conformidade — verificando contra os seus cenários de aceite

Uma linha "done when" diz o que é sucesso em prosa; um **cenário** diz isso em casos que o diff
precisa de fato satisfazer. Um item do plano pode carregar linhas de aceite
`@scenario <given → when → then>` logo abaixo do seu checkbox, e uma lente de review dedicada de
**conformidade** então confere o diff não commitado contra *cada* cenário antes de o item fechar —
um cenário não atendido volta para o worker como a correção concreta, não como um vago "não
funciona":

```markdown
- [ ] Register the `--json` flag — done when: `mycli --json` emits valid JSON
      @scenario no flag → the table prints unchanged
      @scenario `--json` set → stdout is valid JSON with the table's exact fields
```

A lente fica **ativa apenas quando o item declara linhas `@scenario`**, então planos sem cenário
se comportam exatamente como antes — totalmente retrocompatível. Vem ligada por padrão;
`--no-conformance` / `LEOPOLD_CONFORMANCE=0` / `conformance: off` no GUARDRAILS desliga.

## Effort por item — palavras-chave ou pesquisa

Todo item é classificado por risco com uma passada barata e determinística de palavras-chave sobre o
texto do item e o charter (sem chamada extra de LLM). A classe define o **reasoning effort** nativo
do SDK para o worker:

| O item parece | Effort | Extra |
| --- | --- | --- |
| typo, rename, docs, formatação | `low` | — |
| trabalho comum de feature | `medium` | — |
| billing, auth, secrets, permissões, deploy | `high` | **crítico** |
| migrações, schema, pagamento, criptografia (pontas afiadas) | `max` | **crítico** |
| (qualquer item, se o charter declara o projeto como de alto risco) | `high` | — |

Itens **críticos** encaram o painel de review completo de três lentes — os itens baratos continuam
baratos, os perigosos ganham escrutínio.

Palavras-chave só enxergam a *redação* do item. Ative o **roteamento inteligente** (`--smart-routing` ou
`smart_routing: on` no GUARDRAILS) e uma sessão curta somente leitura pesquisa o raio de impacto *real*
do item — quais arquivos, quantos chamadores — antes de rotear. Ele sempre cai de volta para o
classificador determinístico em qualquer falha, e nunca pode rebaixar um item crítico-por-palavra-chave
para abaixo de crítico (um piso de segurança: dinheiro/auth/migrações continuam guardados mesmo se o
roteador relaxar).

## Contexto escopado por fatia — aponte o worker para os arquivos certos

O roteamento inteligente já pesquisa quais arquivos um item toca. Ative o **slice scope**
(`--slice-scope` ou `slice_scope: on` no GUARDRAILS — precisa do `smart_routing` ligado) e esse
conjunto de arquivos é entregue ao worker como uma nota de escopo explícita "comece por estes
arquivos", em vez de apontá-lo para o repositório inteiro. Desligado, ou quando o roteamento não
achou nenhum conjunto de arquivos, o worker recebe o repositório como sempre — nada muda.
Desligado por padrão.

## O painel de causa raiz — sem insistir no erro

Quando o mesmo item falha repetidamente, um contexto único tende a insistir na própria teoria
(viés autopreferencial). Em uma nova tentativa, o Leopold convoca, em vez disso, um **painel de
causa raiz**: três investigadores formam hipóteses sobre **evidências disjuntas** — o diff em si, a
saída da verificação lida ao pé da letra, e as premissas do item conferidas contra a codebase — e
então um refutador tenta matar cada uma (refutações não parseáveis falham fechado). A hipótese
sobrevivente mais forte é entregue à próxima tentativa como uma **pista concreta**, com instrução
explícita de verificar a teoria rapidamente e abandoná-la se estiver errada. Vem ligado por padrão;
`--no-hypotheses` / `hypotheses: off` desliga.

## Reset literal — um recomeço limpo, não um remendo sobre a falha

Uma nova tentativa que se apoia no diff que falhou herda o beco sem saída dele. Quando um item
falha em uma run **isolada em worktree**, o **reset literal** restaura a árvore para um snapshot
tirado antes da primeira tentativa do item — descartando o diff que falhou por inteiro, mas
mantendo o trabalho staged dos itens anteriores — para que a nova tentativa comece limpa. Em uma
run **não isolada** ele nunca faz hard-reset: cai de volta para reenquadrar a nova tentativa
("trate a abordagem que falhou como beco sem saída, pegue outra"). Ele nunca mexe no seu repo vivo
de forma destrutiva. Vem ligado por padrão; `--no-literal-reset` / `LEOPOLD_LITERAL_RESET=0` /
`literal_reset: off` desliga.

## Best-of-k — um torneio no item que precisa dar certo

Alguns itens valem mais que uma tentativa. Defina `--best-of-k N` (ou `best_of_k: N` no
GUARDRAILS) acima de 1 e — quando o item é crítico / de effort máximo **e** a run está isolada em
worktree — o item é resolvido por um **torneio de K tentativas independentes**. Cada uma roda na
própria worktree descartável derivada do `HEAD`, semeada com o estado atual, um painel as julga, e
o diff da vencedora é aplicado. K é limitado a 2..6. Se nenhuma tentativa vence, ou a vencedora
não consegue ser aplicada, cai de volta para uma tentativa única. Desligado por padrão (`1`) —
opt-in, porque custa K× uma tentativa normal.

## O charter que aprende você

Seu comportamento registrado vale mais que a sua autodescrição. Com `--learn-on-finish` (ou
`learn_on_finish: on` no GUARDRAILS), um fim limpo minera a run — o log de decisões que ela acabou
de escrever, runs arquivadas e o histórico git do repositório — em busca de decisões de julgamento
recorrentes, coloca um cético com viés de matar em cima de cada candidato e escreve os sobreviventes em
`.leopold/CHARTER-amendments.md` como **proposta**. Ele nunca edita o `CHARTER.md`: você revisa e
incorpora o que soa como você. A skill `/leopold-learn` é a versão mais rica, movida a workflow
(ela também minera as transcrições das suas sessões). Cada passada compõe — um charter mais afiado
significa menos escalações na próxima run.

## Execução paralela

Itens independentes do plano não precisam esperar na fila. Declare a ordem no `PLAN.md` com um
marcador `(after: N)` (posição do item, começando em 1); itens sem marcador são independentes:

```markdown
- [ ] Add the API layer
- [ ] (after: 1) Wire the UI to the API
- [ ] (after: 1) Add API metrics
- [ ] Refresh the docs
```

Com `leopold-driver run --parallel 3`, um agendador ciente de dependências despacha até 3 itens
prontos de uma vez, **cada um em seu próprio git worktree** derivado da árvore principal. Quando um
item termina (e passa no gate de review), o driver **reaplica o diff dele na árvore principal como um
patch staged** — serializado, para a árvore compartilhada ficar consistente, e **nunca commitado**,
então a garantia de que "o humano é dono do git" vale exatamente como no modo serial. Dois itens que
tocaram as mesmas linhas produzem um conflito: o worktree daquele item é **preservado para merge
manual** em vez de perder o trabalho.

O padrão é serial (`--parallel 1`). Divida o trabalho para que mais itens sejam independentes, e só
adicione `(after: …)` para dependências reais — itens que editam todos os mesmos arquivos devem
depender uns dos outros (ou virar um item só) para evitar conflitos.

## Setup em um comando — `leopold up`

A maioria das pessoas usa uma fração do Claude Code. O `leopold up` (CLI) mais o `/leopold-up`
(in-session) fecham essa lacuna de uma vez:

- **`leopold up`** (shell): instala o harness e semeia uma allowlist de permissões por projeto
  sensata, para que o trabalho rotineiro de dev pare de inundar você de prompts.
- **`/leopold-up`** (skill, Fase 0): gera a memória do projeto com `/init`, ensina o Claude a
  buildar e rodar o app com `/run-skill-generator` (o que torna o `/verify` de runtime real),
  verifica MCP/extensões (Serena, ovmem, gstack), sugere um `/effort` padrão e então passa o
  bastão para o `/leopold-brief`.

## Insights

Depois de uma run, o `leopold-driver insights` transforma o `events.jsonl` em um relatório: itens
concluídos vs. incompletos vs. em conflito, o mix de effort, a taxa de aprovação do painel de review
(e quantos itens eram sensíveis a segurança ou encararam um painel multi-lente), painéis de causa
raiz executados e pistas produzidas, emendas de charter propostas, decisões registradas, escalações,
bloqueios de guarda e o gasto real. `--json` para saída de máquina. São os mesmos dados que o
dashboard de watch transmite ao vivo — releia-os para escrever briefs mais afiados da próxima vez.
