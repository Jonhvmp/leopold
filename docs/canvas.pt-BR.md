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
