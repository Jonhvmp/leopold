# Isolamento de run & coleta de runs órfãs

Port nativo de duas coisas que o paperclip faz bem — um worktree do git por run e um
reaper baseado em liveness de pid — para dentro do harness do Leopold. Sem Postgres,
sem daemon; o estado fica em `.leopold/`, o git roda a partir do orquestrador (Node),
sinais vão para grupos de processo.

## Por quê

O driver SDK (`leopold-driver run`, "Path A") roda cada item do plano com um worker
novo do Claude Code via o `query()` do Agent SDK, **in-process**, com `cwd: brief.root`
(`packages/driver/src/worker.ts`). Os subagents que o worker cria herdam esse cwd. Duas lacunas:

1. **Sem isolamento.** Uma run muta a working tree do usuário diretamente; duas runs no
   mesmo checkout colidem. A doc já manda o usuário rodar `git worktree add` na mão
   (`docs/guardrails.md`) — isto automatiza esse passo.
2. **Sem coleta.** Se uma run crasha, o `state.json` mantém `active:true` para sempre, e
   qualquer worktree que ela criou fica órfão. Nada detecta nem limpa.

O "Path B" (`/leopold-run`, a skill in-session) conduz a própria sessão ao vivo, então
não consegue trocar o próprio cwd — a automação de worktree é só do Path A. Os dois paths compartilham `.leopold/`.

## O quê

1. **Worktree por run — opt-in, Path A.** `leopold-driver run --worktree` (ou
   `LEOPOLD_WORKTREE=1`) provisiona um worktree dedicado em uma branch descartável
   `leopold/run-<id>` e aponta o `cwd` do worker para ele. A run e seus subagents ficam
   isolados da tree do usuário e das outras runs. O driver roda git **diretamente via
   Node**, então o lock de git do worker não é afetado — o lock restringe o worker, não o
   orquestrador. Cai para `brief.root` se o projeto não for um repositório git.
2. **Reaper de órfãs — ambos os paths.** O driver persiste `orchestrator_pid` no `state.json`.
   Um preflight no startup coleta uma run órfã anterior: `active:true` mas o pid está morto
   (`process.kill(pid, 0)` lança `ESRCH`) → vira `active:false`, loga `run_reaped`, limpa o
   worktree dela, remove tokens de run velhos. O Path B mantém sua checagem existente de
   inatividade de ~10 min.
3. **Endurecimento da escrita de estado.** `writeState` vira **read-merge-write**: o driver TS e
   a skill bash/Stop-hook são dois escritores com schemas diferentes, e o overwrite completo
   antigo derrubava os campos um do outro (`session_id`, `max_subagents`, `worktree_path`, …).
   O merge preserva chaves desconhecidas, então os campos novos sobrevivem aos dois escritores.
4. **A limpeza nunca é destrutiva.** O git está travado, então uma run faz *stage* mas nunca
   *commit*. Um worktree com trabalho não commitado é **preservado** e logado
   (`worktree_preserved`) para o usuário revisar/mergear. Só um worktree limpo é removido
   (`worktree remove --force` + `branch -D leopold/run-<id>`).
5. **Guard.** `git worktree` passa a ser explicitamente permitido no `guard-irreversible.sh`, e o
   bloqueio de `git branch -D` ganha uma exceção estreita para as branches descartáveis
   `leopold/run-*` do próprio harness (deletar qualquer outra branch continua proibido).

## Arquivos

| Arquivo | Mudança |
|---|---|
| `packages/driver/src/types.ts` | `RunState += worktree_path?/worktree_branch?/orchestrator_pid?`; `Brief += worktreeRoot?`; `DriverConfig += worktree` |
| `packages/driver/src/config.ts` | `loadConfig` lê `--worktree`/`LEOPOLD_WORKTREE`; `writeState` read-merge-write; `initState` escreve `orchestrator_pid` |
| `packages/driver/src/worktree.ts` *(novo)* | `createWorktree`, `cleanupWorktree` (preserva se estiver sujo), `isGitRepo`, `isDirty` |
| `packages/driver/src/reaper.ts` *(novo)* | `reapOrphan` (ativa + pid morto), `isProcessAlive` |
| `packages/driver/src/loop.ts` | preflight do reaper; provisiona o worktree; persiste `worktree_path`; limpeza no `stop()` |
| `packages/driver/src/worker.ts` | `cwd: brief.worktreeRoot ?? brief.root` |
| `hooks/guard-irreversible.sh` | permite `git worktree`; exceção de `branch -D` para `leopold/run-*` |
| `skills/leopold-run/SKILL.md` | anota `--worktree`; coleta um worktree órfão na checagem de inatividade |
| `packages/driver/test/worktree.test.ts`, `reaper.test.ts` *(novos)* | testes unitários contra um repositório git temporário |

## Verificação

- `make driver-check` (typecheck) + `make driver-test` (vitest) verdes.
- Repositório git temporário: `leopold-driver run --worktree` provisiona `leopold/run-<id>`,
  o cwd do worker é o worktree, uma run limpa o remove, uma run suja o preserva (com log).
- Reaper: um `state.json` com `active:true` + pid morto vira `active:false` e seu
  worktree é removido no próximo startup; um pid vivo fica intocado.
- Merge do `writeState`: um campo escrito pelo bash (`max_subagents`) sobrevive a uma
  escrita posterior do driver, e vice-versa.
- Guard: `git worktree add/remove`, `git branch -D` e `git reset --hard` são todos
  permitidos — só `git commit` e `git push` são travados, então a limpeza de worktree
  não passa pelo guard.
