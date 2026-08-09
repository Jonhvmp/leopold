# O Canvas

O plano do Leopold não é uma thread de chat — é um **grafo**. O Canvas torna esse grafo
visível e dirigível: um DAG da run ao vivo, zero-dependência, servido no loopback pelo
`leopold-watch`. É a resposta aberta e com git travado a um workspace de agente linear.

Abra com `/leopold-watch` (ou `make watch` / `npx leopold-driver watch`) e vá para a aba
**Canvas** em `http://127.0.0.1:4179`.

## O que ele renderiza

O Canvas lê os arquivos da própria run (`.leopold/`) e cada registro de dynamic workflow
que o runtime grava, e dispõe tudo como um grafo dirigido com um layout em camadas feito à
mão (sem framework, sem bundler, sem web fonts — funciona 100% offline):

- **Itens do plano** como nós, com dependências `(after: N)` como arestas.
- **Os tipos de nó que você escreveu.** Um item que declara um — `@gate`, `@human`,
  `@tool`, `@verify` — exibe o tipo no nó, junto do rótulo (`@gate security` aparece como
  `GATE · SECURITY`). Um item que não declara nada é um nó de trabalho comum, igual antes.
- **Arestas condicionais.** Uma rota `@on <condição> -> <item>` é desenhada como uma
  aresta arqueada e tracejada, em cor própria, carregando a condição **como foi escrita**
  (`migrated=false`) — assim um desvio nunca se confunde com uma dependência. O inspector
  lista as rotas do item, os sinais que ele emite (`@emit`) e os que exige (`@needs`).
- **Um nó `@human` esperando por você — quando ele realmente está.** Sob a postura padrão
  (`autonomy: full`), nenhum dos engines espera num nó `@human`: ele registra um evento
  `persona`, que a timeline mostra com o papel que a run sintetizou para decidir. Sob
  [`autonomy: ask`](reference/plan-grammar.pt-BR.md#autonomy), o engine registra
  `awaiting_human` e o nó entra num estado `awaiting` distinto — âmbar, pulsando, escrito
  *needs you*. Nada é inferido: o nó só espera quando a run diz que espera.
- Fases e agents de **dynamic workflow**: fase→fase (`seq`), fase→agent (`contains`), e
  cada agent de verificação adversarial ligado ao nó exato que ele revisa (`verifies`).
  A aresta é precisa onde os próprios scripts do Leopold rotulam os agents como
  `impl:<id>` / `verify:<id>:<lens>`; workflows genéricos caem no inferer por fase.
- **Forks**, **reviews** e **hipóteses de causa-raiz** como nós pendurados no item que os
  gerou.
- **Tasks** como nós autônomos de primeira classe (veja abaixo).

Pan (arrasta o fundo), zoom (roda), arrasta um nó pra fixar (as posições persistem) e
**Fit** pra reenquadrar. Clique num nó pra abrir o **inspector**: modelo, tokens, uma
estimativa de custo por nó, tool calls, prévias de prompt/resultado e — para um item do
plano — a justificativa correspondente do `DECISIONS.md`.

## Steering pelo Canvas

O inspector transforma um nó em controle. Você pode **redirect**, **inject** (uma nota),
**kill** ou **re-run** um item. O que acontece depende de como a run está executando:

- Um loop **`/leopold-run`** vivo drena esses comandos de `.leopold/commands.jsonl` no
  mesmo boundary de turno em que checa o kill switch, e aplica: redirect/inject antecedem
  orientação ao próximo item, kill o encerra, re-run o reabre.
- Um nó de **dynamic workflow** não pode ser preemptado de fora — o runtime é dono dele —
  então o steer vira uma **diretiva para o próximo resume/re-run**, gravada em
  `.leopold/workflow-directives.json` e rotulada como tal. O Leopold não finge matar um
  agent de workflow no meio do caminho.

De qualquer forma, o **git continua travado.** Um comando de steer só pode logar uma nota,
antecipar orientação ou virar um checkbox do `PLAN.md` — nunca destravar
`ALLOW_GIT`/`ALLOW_PUSH` nem commitar. Essa invariante é provada por um teste red-team no
dashboard e no driver.

## O que o Canvas não é

O Leopold Canvas é deliberadamente estreito. Ele **não** é um assistente genérico de
trabalho: sem geração de deck/planilha/documento, sem marketplace de connectors, sem SIEM
enterprise, sem colaboração multiusuário em tempo real, sem board de tarefas, sem app
mobile. É uma superfície grafo-nativa, open-source e self-hostable pra ver-e-dirigir uma run
autônoma de código — e nada que ele mostra é uma afirmação que os testes não sustentam.
