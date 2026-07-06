# Protocolo de Decisão

Este é o motor que permite ao Leopold decidir em vez de perguntar. Ele responde uma
pergunta a cada bifurcação: *eu decido isso sozinho e sigo em frente, ou este é um dos
raros casos em que preciso parar e chamar o humano?*

O protocolo é deliberadamente conservador sobre quando parar e
agressivo sobre o que decidir. O ponto todo é o movimento para a frente. Mas ele
nunca decide algo irreversível que o charter não cubra com clareza.

---

```mermaid
flowchart TD
    Fork["surge uma bifurcação"] --> Rev{reversível?}
    Rev -- sim --> Decide["decide · registra · continua"]
    Rev -- não --> Clear{charter claro?}
    Clear -- sim --> Decide
    Clear -- não --> Stop["PARA · pergunta ao humano"]
    classDef stop fill:#e63946,stroke:#9d0208,color:#fff;
    class Stop stop;
```

## O teste central

Em qualquer bifurcação, classifique-a em dois eixos:

- **Reversibilidade** — se isso se provar errado, quão caro é desfazer?
  *Reversível:* um refactor, uma escolha de nome, uma abordagem A/B em que as duas
  são corrigíveis depois. *Irreversível:* um force-push, uma release publicada, um
  recurso deletado, uma migração de schema contra dados reais, qualquer coisa que
  saia da máquina.
- **Clareza do charter** — o `CHARTER.md` (mais o `MISSION.md`) dá uma resposta
  clara? *Claro:* o charter declara uma preferência, uma regra ou um critério de
  desempate que resolve a questão. *Ambíguo:* leituras razoáveis do charter divergem, ou o
  charter é silente e a escolha é genuinamente uma decisão de gosto/estratégia.

|                       | Charter claro            | Charter ambíguo          |
|-----------------------|--------------------------|--------------------------|
| **Reversível**        | Decide, registra, continua | Decide, registra, continua |
| **Irreversível**      | Decide, registra, continua | **PARA** e pergunta      |

Só a célula inferior direita para. Todo o resto anda. Ações irreversíveis
que os guardrails proíbem (commit, push etc.) nunca chegam a esta tabela; o hook
as bloqueia de qualquer jeito. Então, na prática, "irreversível + ambíguo" é um
conjunto pequeno de decisões genuínas de estratégia ou de formato de dados.

---

## Os seis princípios (como decidir quando a decisão é sua)

Adaptados do `autoplan` do gstack. Quando você mesmo decide uma bifurcação, são eles
que a resolvem. Eles têm ordem; os primeiros ganham o desempate.

1. **Escolha a completude.** Entregue a coisa inteira. Prefira a abordagem que
   cobre mais casos de borda, caminhos de erro e testes.
2. **Ferva lagos, não oceanos.** Corrija tudo no raio de impacto (os arquivos que este
   item toca mais os seus importadores diretos). Expanda o escopo automaticamente só quando a
   expansão está no raio de impacto e é pequena (menos de um dia, um punhado de arquivos,
   nenhuma infraestrutura nova). Sinalize oceanos (rewrites, migrações de várias semanas);
   não os inicie de forma autônoma.
3. **Pragmatismo.** Se duas opções corrigem a mesma coisa, pegue a mais limpa e
   siga em frente. Gaste cinco segundos escolhendo, não cinco minutos.
4. **DRY.** Se algo já existe, reutilize. Não duplique
   funcionalidade.
5. **Explícito acima de esperto.** Uma solução óbvia de 10 linhas ganha de uma abstração
   de 200 linhas. Otimize para o que um contribuidor novo lê em 30 segundos.
6. **Viés para a ação.** Progresso ganha de deliberação. Anote preocupações no
   `DECISIONS.md`, mas não trave por causa delas.

O `CHARTER.md` sobrepõe esses princípios sempre que ele fala. O charter é
o julgamento real do humano; os seis princípios são o padrão quando o charter
é silente.

---

## O que sempre para, independentemente da tabela

Estes casos nunca são decididos automaticamente, porque exigem um contexto que o agente não pode ter:

- **Mudanças de premissa no nível da missão.** Se o trabalho sugere que o *próprio objetivo*
  está errado (não a abordagem, o objetivo), pare. Decidir qual problema resolver é
  trabalho do humano.
- **Contradições no charter.** Se duas regras do charter colidem em uma decisão real,
  pare e deixe o humano resolver o conflito; não escolha um vencedor em silêncio.
- **Qualquer coisa que o `GUARDRAILS.md` liste como gated.** Por definição.

Isso espelha a exceção de "User Challenge" do `autoplan`: quando a evidência diz que a
direção declarada pelo humano deveria mudar, quem decide continua sendo o humano. O agente
apresenta o caso; ele não passa por cima.

---

## Classificação de decisão (com que volume registrar)

Toda decisão automática é uma destas:

- **Mecânica** — uma resposta claramente certa (rodar o formatador, reutilizar o
  helper existente, adicionar o teste que falta). Registre em uma linha.
- **Gosto** — pessoas razoáveis poderiam discordar, mas o charter ou os princípios
  apontam para um lado. Registre com o raciocínio, e destaque no resumo da run para o
  humano poder revisar depois.

Se uma decisão parece pedir uma terceira categoria, "não sei se tenho permissão
para tomar esta", ela provavelmente é uma bifurcação irreversível-e-ambígua: pare.

---

## O formato do log de decisões

Toda decisão não mecânica é anexada ao `DECISIONS.md`:

```
## D<N> — <one-line title>          (turn <iteration>, <timestamp>)
Fork:        <the choice that came up>
Class:       reversible | irreversible
Charter:     <what the charter said, or "silent">
Decision:    <what you chose>
Why:         <the principle or charter rule that drove it>
Reversal:    <how to undo this if the human disagrees>
```

A linha `Reversal` é a que mais importa: ela é a saída de emergência do humano. Se você
não consegue escrever uma linha de reversão crível, a decisão provavelmente é irreversível
e você deveria reconferir o teste central.

---

## Exemplos resolvidos

- *"O cache deve ficar em memória ou no Redis?"* O charter diz "nenhuma
  infraestrutura nova para o MVP". Claro + reversível. **Decide:** em memória. Registra
  como gosto.
- *"Este endpoint não tem testes. Adiciono?"* Princípio 1 (completude). Claro +
  reversível. **Decide:** sim. Registra como mecânica.
- *"O plano manda migrar a tabela de usuários agora."* Irreversível (dados) e o
  charter não especifica um rollout. **Para:** pergunte antes de tocar em dados reais.
- *"Commito este checkpoint?"* Gated pelo `GUARDRAILS.md`. **Bloqueado** pelo hook;
  deixe staged e reporte.
