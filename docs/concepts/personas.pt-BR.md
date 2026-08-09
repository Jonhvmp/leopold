# Personas — nada trava, e o git continua bloqueado

O Leopold tinha um beco sem saída dentro dele. Um nó `@human` estacionava a run. Uma
escalação encerrava a run. Uma rota com um erro de digitação se recusava a começar. Três
falhas do mesmo tipo desistiam. Cada uma dessas situações é o harness dizendo *"uma
pessoa deveria decidir isso"* — e, para quem adota um harness autônomo, "esperar por uma
pessoa" significa "ficar parado até segunda". Ninguém comprou uma lista de tarefas.

Então o Leopold faz o que uma pessoa faria: descobre **quem** a decisão exige, assume esse
papel, decide, faz o trabalho e registra o que decidiu e como você desfaz.

Isso é uma persona.

!!! warning "A semântica do `@human` mudou nesta release"
    Um nó `@human` **não trava mais a run** por padrão. Ele é decidido por um papel que o
    Leopold sintetiza e registrado no `DECISIONS.md`. Isso é deliberado e é justamente o
    ponto da funcionalidade — mas se o seu plano dependia do `@human` parar e esperar por
    você, defina [`autonomy: ask`](#autonomy-escolhendo-a-postura) no `GUARDRAILS.md` e o
    comportamento antigo volta nos dois engines, sem alteração.

---

## O que é uma persona

Uma persona é um **papel sintetizado para uma decisão**, a partir de três entradas que o
Leopold já tem:

- **o item** — o que o trabalho de fato é,
- **`MISSION.md`** — para que a run existe,
- **`CHARTER.md`** — o seu gosto, as suas prioridades, as suas regras duras.

Ela carrega um nome, um título de papel específico, a expertise que o item realmente
exige, o que esse papel otimiza e as regras do charter que a vinculam.

```
Persona:     Rui Salgado — Release Engineer
Fork:        @human node, item 7: "Approve the production cutover"
Charter:     "TRUST BEFORE REACH. The git lock is the boundary this product rests on."
Decision:    Approve the cutover behind a flag; the change is staged, not shipped.
Reversal:    Flip cutover_enabled back to false in config/flags.yml.
```

### O plano nunca nomeia a persona

Esta é a parte que vale internalizar. **Você não escreve personas.** Não existe
`PERSONAS.md`, não existe marcador `@persona`, não existe elenco para manter. O plano diz
*o que* precisa ser feito; o Leopold deriva *quem* deve fazer. Um plano que tivesse que
nomear os próprios especialistas seria só uma segunda lista de tarefas — o mesmo trabalho
de autoria, com um nível de indireção a mais.

### "Um agente" não é uma persona

Um papel sem nome e sem especialidade é uma fantasia: você recebe a mesma resposta
genérica de chapéu novo e paga uma chamada de modelo pelo chapéu. Por isso papéis
genéricos (`assistant`, `agent`, `engineer`, `expert`, …) são **recusados**, e o item roda
sob o prompt de worker comum. O encaixe é a funcionalidade inteira.

### As restrições não são sintetizadas — são levantadas

O *encaixe* do papel vem de uma chamada de modelo. As suas *regras vinculantes* não: o
Leopold levanta as linhas duras do `CHARTER.md` **literalmente**, e são elas as restrições
da persona. Um modelo que esqueceu as suas regras não consegue produzir uma persona sem
elas; um modelo que parafraseou uma delas não consegue suavizá-la. Mesmo item + mesmo
charter → regras vinculantes byte a byte idênticas, sempre.

### Falhar na síntese não é fatal

Uma resposta impossível de parsear, um papel genérico, uma resposta vazia, um erro do
harness — todos significam "sem persona", e o item roda sob o prompt de worker padrão. Uma
run nunca morre porque não conseguiu decidir quem ela era.

---

## Os quatro forks que uma persona assume

| Fork | O que acontecia antes | O que acontece agora |
| --- | --- | --- |
| **Nó `@human`** | a run parava com `awaiting_human` | um papel sintetizado decide o item e faz o trabalho |
| **Escalação** | a run terminava; o item ficava com uma pergunta pendurada | um papel resolve o fork contra o charter, devolve a resolução ao worker e o item termina |
| **Grafo quebrado / deadlock** | o pre-flight se recusava a começar | um plan engineer propõe o reparo mais estreito possível, dentro dos limites que as emendas de `@feedback` já obedecem |
| **Falha repetida** | a terceira falha do mesmo tipo encerrava a run | uma **mudança de abordagem** conduzida por persona, e então o teto vale |

Dois deles merecem ter os limites exatos escritos, porque "limitado" está fazendo trabalho
de verdade naquela tabela.

### O reparo de grafo é limitado pelas regras que já existiam

Um reparo pode fazer apenas duas coisas: **apontar uma rota que o plano já declara para um
item que existe** e **acrescentar um item de trabalho comum**. No máximo **3 mudanças**,
nunca uma remoção, nunca em um item já marcado como feito, nunca um toque no
`GUARDRAILS.md`. Esses são os limites do
[`amend.ts`](../reference/plan-grammar.md#nos-de-feedback-e-emendas) — o mesmo escritor
único pelo qual um nó `@feedback` passa. Não existe um segundo caminho mais frouxo: um
reparo que quiser uma quarta mudança recebe a mesma recusa, registrada com o limite que a
recusou.

E é tudo ou nada. O plano reparado é validado **em memória**; o `PLAN.md` só é aberto para
escrita depois que ele valida. Um reparo que não conserta o grafo deixa o arquivo byte a
byte idêntico, a run continua se recusando a começar, e a recusa imprime tanto os
diagnósticos originais *quanto* o que o reparo tentou. E não custa nada em um plano
válido — sem persona, sem chamada de modelo, a menos que o validador já tenha produzido um
diagnóstico.

### O resgate de falha repetida é uma tentativa, não um aumento de budget

Na **última falha permitida**, o Leopold sintetiza o papel que aquela falha exige, entrega
a ele as evidências e pede uma abordagem genuinamente diferente. A próxima tentativa roda
sob ela.

`max_failures` nunca é escrito. `max_iterations` nunca é escrito. O kill switch nunca é
tocado. O resgate é gasto **uma vez por run** (fica persistido, então uma run retomada
herda que ele já foi gasto) e a tentativa que ele compra é cobrada como uma iteração como
qualquer outra. Se essa tentativa também falhar, a run para com `repeated_failure`
exatamente como para hoje. E ele só é concedido quando um papel realmente decidiu alguma
coisa — uma síntese que não produziu abordagem nenhuma significa que a run para e o log
diz que o resgate não produziu nada. Uma tentativa extra silenciosa e sem ideia nova é só
uma quarta tentativa.

---

## A persona decide. Ela nunca publica.

Esta é a costura que torna "nada trava" seguro em vez de irresponsável, e **esta
funcionalidade não a toca**.

O bloqueio do git é sobre **ações**, não sobre decisões. Uma persona pode concluir "liberar
o cutover" e registrar essa conclusão com a sua linha de Reversal — e o
`hooks/guard-irreversible.sh` continua negando o `git commit` e o `git push` que a
executariam. Autonomia total de julgamento; a fronteira de confiança exatamente onde
estava.

**Uma persona nunca pode:**

- `git commit`, `git push`, force-push, `git tag`, publicar um pacote ou abrir um PR externo
- aumentar `max_iterations`, `max_failures` ou o budget em USD
- limpar o kill switch
- editar o `GUARDRAILS.md`

Duas dessas são garantidas por máquina: o escopo do guard é `git commit` e `git push`
(force-push sempre). O resto são regras duras que o papel é instruído, no prompt, a
respeitar — e o prompt diz isso com todas as letras em vez de prometer um hook que não
existe. Se uma decisão não pode ser executada porque o git está bloqueado, isso é o design
funcionando, não um bug para contornar.

---

## Toda decisão de persona deixa rastro

Autonomia sem registro é uma máquina não auditada, então o registro não é opcional.

Toda decisão de persona é acrescentada ao
[`DECISIONS.md`](../decision-protocol.md#o-formato-do-log-de-decisoes) nomeando a **persona**, o
**fork** de onde veio, a **base no charter** e uma linha de **Reversal**. Quando nenhum
papel pôde ser sintetizado, a linha `Persona:` continua aparecendo, dizendo isso — uma
decisão autônoma sem registro de quem a tomou não é auditável.

Os dois engines escrevem pelo **mesmo escritor único**, o que também fecha uma lacuna
real: uma run de `/leopold-workflow` não escrevia **decisão nenhuma**, porque o log vivia
no loop do driver.

E a run não espera você abrir o arquivo. Toda run termina com **"What I decided for you"**
— as decisões tomadas em seu nome, da mais arriscada para a menos, no relatório final, no
terminal e no corpo do webhook. Veja
[o protocolo de decisão](../decision-protocol.md#o-que-eu-decidi-por-voce) para entender como
essa ordenação funciona.

---

## Autonomy: escolhendo a postura

`GUARDRAILS.md`:

```markdown
## Judgment posture
- autonomy: full             # full | ask
```

| Valor | Comportamento |
| --- | --- |
| `full` *(padrão)* | Nada trava por uma decisão de julgamento. Um nó `@human` é decidido por um papel sintetizado; escalações, grafos quebrados e falhas repetidas ganham o seu caminho de persona. |
| `ask` | Um nó `@human` para os dois engines com `awaiting_human`, nomeia o item e deixa tudo staged. Responda, marque o item `[x]` e rode de novo para retomar. |

Sobrescreva por run com `LEOPOLD_AUTONOMY=ask` ou com o `--ask` / `--autonomy ask` do
driver. `ask`, `halt` e `human` escrevem a mesma postura estrita. A precedência é a de
sempre: **flag de CLI / env var → `GUARDRAILS.md` → `full`**.

Um valor não reconhecido é *ignorado*, não tratado como estrito — um erro de digitação não
pode mudar a postura silenciosamente em nenhuma das direções.

Os dois engines resolvem isso de forma idêntica. O `/leopold-run` (o Stop hook), o
`/leopold-workflow` (o script compilado) e o driver SDK leem a mesma chave, as mesmas três
grafias, o mesmo padrão. Um nó que resolve em um engine e trava no outro ensina uma mentira
para você.

---

## O que ainda para a run

Esta é a lista completa. Nada aqui é uma decisão de julgamento, e é exatamente por isso que
uma persona não pode encostar em nada disso.

| Motivo de parada | O que significa | Uma persona afeta? |
| --- | --- | --- |
| `plan_complete` | Não sobrou item desmarcado no `PLAN.md`. | — é o objetivo |
| `routed_complete` | Uma rota levou a run a um nó terminal; os itens restantes são nomeados no relatório. | — |
| `kill_switch` | O `.leopold/STOP` existe (`/leopold-stop`, ou `touch`). | **Nunca.** Ela não pode limpá-lo. |
| `iteration_budget` | O contador alcançou o `max_iterations` (padrão 50). | **Nunca.** Ela não pode aumentá-lo. |
| `budget_exceeded` | O gasto real acumulado cruzou o `--budget-usd`. | **Nunca.** |
| `context_budget` | O teto de contexto do engine in-session (padrão 5 MB). | **Nunca.** |
| `no_progress` | N turnos seguidos sem mudança na assinatura do plano (padrão 6). | **Nunca.** |
| `repeated_failure` | O mesmo tipo de falha bateu no teto **e** a única mudança de abordagem conduzida por persona já tinha sido gasta, ou não produziu nada. | Compra **uma** tentativa, uma vez por run. Nunca eleva o teto. |
| `escalation` | Um fork que nem um papel sintetizado conseguiu resolver — uma resposta inutilizável, ou um erro do harness. | Resolve o que dá; um fork insolúvel ainda para a run. |
| `deadlock` / `invalid_graph` | O grafo do plano é inconsistente e o reparo limitado não o consertou. | Repara dentro dos limites do `amend.ts`; um reparo que falha ainda para a run. |
| `awaiting_human` | **Só sob `autonomy: ask`.** Inalcançável em uma run padrão. | É a postura que decide, não a persona. |

Budgets e o kill switch são **tetos de custo e segurança**, não decisões. "Estava quase
pronto" é exatamente o raciocínio que um loop descontrolado produz, então não é um
raciocínio que uma persona tenha permissão de fazer.

Toda parada escreve um resumo final na saída da run e um evento `stop` no `events.jsonl`,
nomeando qual condição disparou.

---

## Compatibilidade retroativa

Um plano sem nó `@human` e sem escalação roda **byte a byte como rodava antes**. Nenhuma
persona é sintetizada, nenhuma chamada de modelo extra é feita, nada é escrito que já não
fosse escrito. Os caminhos de persona não custam nada até a run chegar em um trabalho que
antes esperava por uma pessoa.

A única mudança deliberada de comportamento é o `@human`, e o `autonomy: ask` a restaura.

---

## Veja também

- [Gramática do plano → `@human` e autonomy](../reference/plan-grammar.md#autonomy)
- [Protocolo de decisão](../decision-protocol.md) — o formato do log e o "What I decided for you"
- [Guardrails](../guardrails.md) — as condições de parada e o bloqueio do git
- [Config do driver](../reference/driver-config.md) — as flags e as env vars
