# Guardrails

Autonomia é segura quando a única ação que você nunca quer que aconteça por
acidente — código saindo da máquina ou entrando no histórico sem você — não pode
acontecer sozinha. Esse é todo o trabalho do lock do Leopold: **uma run pode fazer
qualquer coisa, exceto `git commit` e `git push`.** Ela deixa o trabalho em stage;
o commit e o push são seus.

Os guardrails são aplicados de duas formas:
- **Por hook** (impossível de contornar com racionalização): o gate `PreToolUse`
  (`guard-irreversible.sh`) nega `git commit` / `git push` na camada de chamada de tool.
- **Por protocolo** (a disciplina do próprio agente): o protocolo de decisão e as
  condições de parada mantêm a run concluindo trabalho em vez de empacar.

O hook é o lock de verdade. O protocolo é a direção.

O match de git é blindado contra evasão — opções globais (`git -c x=y commit`),
paths absolutos (`/usr/bin/git`), `env git` e truques de espaço/tab, tudo resolve
para o subcomando real — e é coberto por uma suíte de red team (`make test-guard`).

---

```mermaid
flowchart TD
    Cmd["chamada de tool durante uma run ativa"] --> Type{git commit / push?}
    Type -- "não" --> Allow([permite])
    Type -- "commit / push" --> Token{token de opt-in?}
    Token -- "sim" --> Allow
    Token -- "não" --> Deny["nega · loga guard_block"]
    Type -- "force-push" --> Deny
    classDef deny fill:#e63946,stroke:#9d0208,color:#fff;
    class Deny deny;
```

## Classes de ação

### Autônomas (decide e faz)

Tudo que não é uma operação de git com gate. A run tem autoridade total sobre o trabalho:

- Ler, buscar, analisar, criar, editar e deletar arquivos.
- Rodar builds, linters, type checkers, formatadores e suítes de teste.
- Rodar qualquer skill do gstack que não faça commit ou push por conta própria.
- Rodar comandos de shell, inclusive destrutivos (`rm -rf`, `reset --hard`) — a
  decisão é da run. Isole com `--worktree` se quiser uma fronteira de filesystem.
- Colocar mudanças em stage (`git add`).
- Criar subagents conforme o trabalho pedir.

### Com gate (exigem um token de opt-in explícito por run)

Só duas, bloqueadas pelo hook a menos que o token correspondente (que só o humano
cria) esteja presente:

- `git commit` — desbloqueia com `.leopold/ALLOW_GIT`
- `git push` — desbloqueia com `.leopold/ALLOW_PUSH`

Force-push (`--force` / `--force-with-lease` / `-f`) é negado mesmo com
`ALLOW_PUSH`. A regra permanente do usuário — *nunca fazer commit ou push sem
confirmação explícita* — está codificada aqui e é aplicada até em modo totalmente
autônomo. Nada mais tem gate: criar PR, publicar e fazer deploy são decisões da
própria run.

---

## Custo — o eixo caro

O custo em uma run autônoma longa explode porque a sessão principal cresce a cada
turno: em um modelo de contexto grande ela nunca auto-compacta, então cada turno
recobra o transcript inteiro acumulado. As defesas que importam:

- **Hard-stop de budget em USD.** Passe `--budget <usd>` para o driver; a run para
  no momento em que o gasto acumulado (do `total_cost_usd` real da CLI) cruza o
  valor, com o trabalho em stage para revisão. Esse é o teto confiável.
- **Runs limitadas e retomáveis.** Uma run termina em `max_iterations` (padrão 50),
  então não gira para sempre; o brief persiste, então um `/leopold-run` novo retoma
  do `PLAN.md` com contexto limpo. Limitada + retomável ganha de uma sessão gigante.
- **Orquestrador enxuto.** O protocolo delega trabalho de saída volumosa (redigir
  conteúdo, gerar arquivos) a um subagent que **escreve em arquivo**, então a saída
  nunca se acumula no contexto do orquestrador.

Cinto e suspensório: configure um **spending cap da Anthropic** na sua conta antes
de runs autônomas longas em projetos grandes.

### Acompanhando uma run (dashboard ao vivo)

`/leopold-watch` (ou `make watch`, ou `leopold watch` da CLI npm) sobe um dashboard **local**
em `http://127.0.0.1:4179` que atualiza ao vivo via SSE. O destaque é o **gasto estimado
real**, extraído do transcript da sessão do Claude Code: dólares, o breakdown de tokens
(input / output / cache-write / cache-read), % de cache hit, por modelo e principal vs
subagent. Abaixo: o feed de eventos ao vivo (turnos, bloqueios do guard, paradas), o log de
decisões e um botão **Stop** que usa o kill switch. O número de custo é uma estimativa a
partir de um mapa de preços embutido, **configurável** via a env var `LEOPOLD_PRICES` (um
arquivo JSON) ou um `.leopold/prices.json` no projeto — sobrescreva qualquer modelo ou
família, ex.: `{"opus": {"in": 15, "out": 75, "cache_write": 18.75, "cache_read": 1.5}}`
(as taxas de cache têm padrão 1.25× / 0.1× do input). É zero-dependência (stdlib do
Python), somente leitura exceto por aquele botão, e faz bind no loopback — nada sai da
máquina.

---

## Condições de parada

A run termina, e o Stop hook permite que a sessão pare, quando qualquer uma destas
é verdadeira:

1. **Plano completo** — nenhum item desmarcado resta no `PLAN.md`.
2. **Kill switch** — `.leopold/STOP` existe (`/leopold-stop` ou `touch`).
3. **Falha repetida** — o mesmo tipo de falha por N turnos consecutivos (padrão 3),
   *depois* da única mudança de abordagem conduzida por uma persona que a run ganha ao
   bater no teto pela primeira vez. O teto em si nunca se move.
4. **Budget de iterações** — o contador de iterações atingiu `max_iterations` (padrão 50).
5. **Budget em USD** — o gasto acumulado cruzou `--budget`, se definido.
6. **Escalação** — uma bifurcação que nem um papel sintetizado conseguiu resolver (uma
   resposta inutilizável, um erro do harness). Uma bifurcação que ele *consegue* resolver
   é decidida e registrada, não escalada.

Toda parada escreve um resumo final na saída da run e um evento `stop` em
`events.jsonl`, dizendo qual condição disparou. A lista completa — incluindo
`context_budget`, `no_progress` e `routed_complete`, e se um papel sintetizado pode afetar
cada uma — está em
[O que ainda para a run](concepts/personas.md#o-que-ainda-para-a-run).

**`awaiting_human` não está nessa lista sob a postura padrão.** Um nó `@human` é decidido
por um papel que o Leopold sintetiza para ele, nos dois engines; configure
[`autonomy: ask`](reference/plan-grammar.pt-BR.md#autonomy) no `GUARDRAILS.md` (ou
`LEOPOLD_AUTONOMY=ask`, ou a flag `--ask` do driver) para que ele pare e espere por você.
Uma persona decide; ela nunca publica — o git continua travado nas duas posturas, e
nenhuma persona pode aumentar um budget, limpar o kill switch ou editar o `GUARDRAILS.md`.

---

## O kill switch

Duas formas de parar uma run na próxima fronteira de turno:

- `/leopold-stop` — o jeito limpo; vira o `state.json` para inativo e escreve um
  resumo.
- `touch .leopold/STOP` — o jeito bruto; o Stop hook vê o arquivo e para.

Nenhuma das duas interrompe o trabalho no meio do turno; ambas fazem efeito quando
o turno atual termina, então nada fica pela metade.

---

## Optando por liberar o git (quando você realmente quer commits)

Se você quer que uma run faça commit ou push sozinha, o opt-in é explícito e por run:

```bash
touch .leopold/ALLOW_GIT      # allow commit
touch .leopold/ALLOW_PUSH     # allow push (force-push stays denied)
```

A postura padrão, e a recomendada, é: o Leopold deixa em stage e reporta, você faz
commit e push.

---

## Padrões

| Configuração                | Padrão     | Onde mudar                 |
|-----------------------------|------------|----------------------------|
| Commit                      | travado    | `touch .leopold/ALLOW_GIT` |
| Push                        | travado    | `touch .leopold/ALLOW_PUSH` |
| Force-push                  | nunca      | não configurável           |
| Autonomy                    | `full`     | `GUARDRAILS.md` (`autonomy: ask`) |
| Máx. de falhas consecutivas | 3          | `GUARDRAILS.md`            |
| Máx. de iterações           | 50         | `GUARDRAILS.md`            |
| Budget em USD               | nenhum     | `--budget` no driver       |

## Higiene de run e runs paralelas

### O que é limpo quando uma run para

Em toda parada, o Leopold limpa o kill switch (`STOP`) e os tokens de opt-in de git
(`ALLOW_GIT` / `ALLOW_PUSH`). Isso é uma propriedade de segurança: a próxima run
começa com o git **travado de novo** e não é interrompida por um `STOP` velho. O
registro durável (o brief, `DECISIONS.md`, `events.jsonl`) nunca é deletado.

### on_finish: keep ou archive

Definido em `GUARDRAILS.md`:

- **`keep`** (padrão) — o brief, as decisões e os eventos ficam em `.leopold/`.
- **`archive`** — em um término limpo (plano completo), `DECISIONS.md` e
  `events.jsonl` vão para `.leopold/runs/<timestamp>/`, então a próxima run começa
  com log limpo enquanto o histórico completo fica preservado.

Auto-delete nunca é padrão; se você quer começar do zero, remova `.leopold/` você
mesmo.

### Uma run por checkout

Um projeto suporta **uma run ativa do Leopold por vez**. Runs paralelas no mesmo
checkout compartilham `.leopold/` (um `state.json`, um `PLAN.md`) e a mesma working
tree, então uma sobrescreveria o estado e o código da outra. `/leopold-run` se
recusa a iniciar uma segunda run enquanto outra está ativa (uma run ociosa por 10+
minutos é tratada como abandonada e pode ser assumida).

### Rodando em paralelo — use worktrees

Paralelismo de verdade vem de isolamento, não de threads: dois agentes editando os
mesmos arquivos conflitam por mais concorrente que o orquestrador seja. Para rodar
o Leopold em paralelo, dê a cada run seu próprio worktree do git:

```bash
git worktree add ../proj-leopold-2 && cd ../proj-leopold-2
# now /leopold-brief + /leopold-run here, fully isolated from the first run
```

Cada worktree tem seu próprio checkout e seu próprio `.leopold/`, então N runs
avançam concorrentemente sem colisão.
