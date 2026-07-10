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
leopold insights                     # summarize the run's events.jsonl
```

## Autenticação

Usa o seu login existente do Claude Code para o worker, o maestro e cada agente de
painel. **Nenhuma API key é necessária.** `ANTHROPIC_API_KEY` só entra em um
ambiente headless sem autenticação do Claude Code.

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
| `ANTHROPIC_API_KEY` | nenhum | só para ambientes headless sem autenticação do Claude Code |

## Toggles no brief (GUARDRAILS.md)

A postura de orquestração pode viver junto com o brief em vez da linha de comando.
O `GUARDRAILS.md` pode definir qualquer um destes como `key: on|off`:

```markdown
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

## Condições de parada

Vêm do `.leopold/GUARDRAILS.md`, as mesmas do engine in-session: plano completo,
kill switch (`touch .leopold/STOP`), falhas repetidas e o budget de iterações.

## Notificações

Ao concluir ou escalar, o driver escreve no terminal e no `events.jsonl`,
e faz POST de JSON para `LEOPOLD_WEBHOOK` se estiver definido:

```json
{ "title": "Leopold finished", "body": "Plan complete; everything staged.", "source": "leopold" }
```

Quando `learn_on_finish` está ligado, o aviso de conclusão também lista as emendas
propostas ao charter (escritas em `.leopold/CHARTER-amendments.md`; o charter
em si nunca é editado).
