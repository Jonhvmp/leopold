# Teste com personas — clientes sintéticos que percorrem o seu produto

Cliente real encontra o que quem constrói não consegue: bug no caminho infeliz, tela
que confunde, texto que não explica, fluxo que perde gente em silêncio. Esperar
usuários reais baterem nessas paredes é o loop de feedback mais lento e caro que
existe.

O módulo de persona coloca um **cliente sintético** na frente do seu produto: um
arquétipo fundamentado em evidência que percorre um fluxo declarado com seus próprios
objetivos, paciência, vocabulário e limites — percebendo a interface real, reagindo
em personagem, registrando cada passo no diário — e termina o run com um relatório
estruturado do que quebrou, do que confundiu e de onde ele desistiu.

!!! note "Módulo diferente de [Personas](personas.md)"
    [Personas](personas.md) são os *decisores* que o Leopold sintetiza quando um run
    encontra um nó `@human`. Esta página é sobre *simulação de cliente* — personas
    que testam o produto. Compartilham uma filosofia (limitado, honesto, registrado),
    não código.

## As três peças

Duas skills portáveis são donas da semântica de persona, vendorizadas byte a byte e
instaladas nos dois harnesses:

- **`persona-contract-builder`** compila um `persona-contract/1.0`: um arquétipo
  fundamentado em evidência com catálogo de claims, ledger de fontes, fronteiras
  epistêmicas (o que essa persona sabe, meio-sabe, não pode saber), modelos de
  comportamento e comunicação, e um gate de validação explícito. Sem estereótipos,
  sem citação inventada — dimensão sem suporte fica registrada como desconhecida.
- **`persona-contract-runtime`** executa um contrato um turno limitado por vez:
  `contrato + estado anterior + estímulo visível + tarefa → reação + ação observável
  + delta de estado`. O protocolo de sinceridade é o produto: confusão continua
  confusão, desconfiança continua desconfiança, e abandono é respeitado — nunca
  amaciado em elogio.

A terceira peça é do Leopold: **`/leopold-persona`** (Claude Code) /
**`$leopold-persona`** (Codex CLI) conduz o run — workspace, loop, diário,
continuidade, evidência, relatório.

## A estrutura (nada solto)

```
.leopold/persona/
  personas/<id>/contract.yaml     # o elenco, construído de evidência
  flows/<flow>.md                 # entrada, objetivo, sucesso, allowlist, limites
  runs/<UTCstamp>-<flow>/         # uma árvore de entregáveis por run
    <persona-id>/
      JOURNEY.jsonl               # um turno executado por linha, com deltas de estado
      evidence/                   # screenshots e gravações
      FINDINGS.md                 # tipado: bug | ux | a11y | copy | perf + severidade
    REPORT.md                     # síntese entre personas, versão do app pinada
```

## Como um run funciona

1. **Preflight, barulhento:** o arquivo de fluxo precisa declarar entrada, objetivo,
   critério de sucesso e allowlist de domínios; todo contrato passa pelo gate de
   auditoria do runtime; a sessão precisa conseguir de fato perceber a superfície
   (ferramentas de browser pra web, shell pra CLI). Sem browser → o run diz isso e
   para. **Uma persona que nunca viu a tela não tem nada verdadeiro a dizer.**
2. **O loop:** captura o que a persona vê → executa um turno instrumentado → anexa o
   resultado completo ao `JOURNEY.jsonl` → executa a ação pretendida da persona →
   repete, encadeando o `state_delta` de cada turno no estado anterior do próximo.
3. **O diário é a memória.** Se a sessão bate na janela de contexto, a
   [continuidade](continuity.md) do Leopold rola a janela — e a janela seguinte
   retoma do rabo do diário, re-percebe a tela e continua do mesmo turno. Um fluxo
   longo nunca perde um passo, e tudo que é relido do diário é enquadrado como dado
   de run passado, nunca como instrução.
4. **O relatório:** achados destilados só do diário (sem turno no diário, sem
   achado), ranqueados por severidade e por quantas personas bateram na mesma parede
   — *"3 de 4 personas travaram no mesmo passo do checkout"* vale mais que qualquer
   observação solitária. Abandono é dado: onde a persona desistiu costuma ser a
   linha mais valiosa do relatório.

## Limites que não se movem

- **A allowlist é fronteira dura** — a persona nunca navega fora dos domínios que o
  fluxo declara. Aponte fluxos pra staging. O ciclo de run do `/leopold-persona`
  arma essa fronteira no preflight e desarma no fim do run, então com um run ativo
  ela também é imposta *antes da chamada da ferramenta*: um hook `PreToolUse` nega
  navegação MCP fora da allowlist em toda sessão que inicia sob o run ativo, nos
  dois harnesses, verificado ao vivo — a checagem do próprio condutor no loop vale
  sempre. [Hooks do Persona Guard](../reference/persona-guard-hooks.md).
- **Ação irreversível nunca é executada.** Pagamento, deleção, submit destrutivo: o
  condutor registra a intenção como achado em vez de agir — a mesma filosofia do
  [lock de git](../guardrails.md). O run observa e prepara; um humano executa efeitos
  colaterais.
- **Nenhum segredo em diário ou relatório.** Credencial de teste vem do ambiente
  (o vault de secrets); texto gravado e reportado passa pela máscara de credencial.

## O segundo motor: o driver

`/leopold-persona` é uma skill dizendo a uma sessão o que fazer. `leopold persona
run` é um harness fazendo: o [driver SDK](../architecture/driver.md) conduz os
mesmos artefatos de `.leopold/persona/` de forma headless, com a profundidade do
motor de run. É o mesmo [padrão de duas fases](two-phases.md) de `/leopold-run`
vs `leopold run` — um layout de artefato, dois motores sobre ele, e um teste
garante a paridade: um run iniciado na sessão e um run headless escrevem o mesmo
cabeçalho de diário e a mesma árvore de run, então quem lê o relatório nunca sabe
qual motor percorreu o fluxo.

O que o driver acrescenta é que tudo que a skill *pede*, o driver *faz*:

- **O loop de condução, do driver.** Uma sessão worker supervisionada por
  persona. O worker percebe a tela, executa o turno pela skill de runtime
  vendorizada e devolve o turno `persona-runtime-result/1.0` num bloco cercado —
  mas **quem escreve o diário é o driver**, não o worker. Todo turno é validado
  antes de ser anexado; turno malformado é rejeitado em voz alta e re-pedido com
  a razão nomeada. Não existe reparo silencioso: uma linha de diário é válida ou
  não existe.
- **Supervisão, não esperança.** Uma sessão que termina sem turno válido nem
  desfecho declarado é continuidade de janela ou um travamento — o condutor
  decide, registra o travamento com razão nomeada e limita os relançamentos,
  então uma persona travada termina como uma linha honesta de `stall` em vez de
  loop infinito.
- **Continuidade com prova.** O diário é o único estado: o driver encadeia o
  `state_delta` de cada turno no estado anterior do próximo e reconstrói um bloco
  de re-seed do rabo do diário a qualquer momento. O teste de regressão mata a
  janela depois do turno N e relança — a próxima linha do diário é o turno N+1,
  nenhum passo perdido, nenhum repetido.
- **Limites impostos em código.** O condutor checa toda ação registrada no diário
  contra a allowlist de domínios do fluxo e a regra de irreversibilidade *antes*
  da ação executar. Violação anexa uma linha de parada nomeada e encerra o run
  daquela persona — o prompt reafirma os limites, o código os impõe. Os
  [hooks do persona guard](../reference/persona-guard-hooks.md) somam o mesmo
  limite antes da chamada da ferramenta, com a evidência ao vivo por harness
  naquela página.
- **Fan-out.** `--persona all --parallel N` roda o elenco em paralelo, cada
  persona no seu próprio subdiretório de run — sem worktree, personas escrevem
  artefatos, não código.
- **Relatório determinístico.** O `REPORT.md` é sintetizado só dos diários, byte
  a byte estável: achados ranqueados por severidade × quantas personas bateram na
  mesma parede, versão do app pinada, evidência linkada, resumo de jornada por
  persona. `leopold persona report <run-dir>` re-sintetiza os mesmos bytes dos
  mesmos diários, a qualquer hora.

## Qual motor quando

| | `/leopold-persona` (na sessão) | `leopold persona run` (driver) |
| --- | --- | --- |
| Onde roda | dentro da sua sessão Claude Code / Codex | headless, de qualquer terminal |
| Melhor pra | construir elenco e fluxos, ver uma persona ao vivo, iterar num contrato | runs do elenco inteiro, fluxos longos, runs de prova perto de CI |
| Contrato do diário | a skill segue | o driver valida e escreve |
| Travamento e janela | a continuidade da própria sessão | supervisionado: detecção de travamento, relançamentos limitados, retomada provada pelo diário |
| Limites | armados pelos guard hooks, reafirmados em prosa | impostos em código em toda ação registrada, além dos guard hooks |
| Fan-out | uma persona por vez | `--persona all --parallel N` |
| Saída | a mesma árvore `.leopold/persona/runs/` | a mesma árvore, mais o `REPORT.md` determinístico entre personas |

Regra de bolso: construa e depure na sessão; meça com o driver.

## Os dois harnesses, com honestidade

As três skills instalam idênticas no Claude Code e no Codex CLI pelo mesmo
instalador. O que difere são as ferramentas de percepção da sessão: um fluxo web
precisa de controle de browser na sessão que o executa. Quando essa capacidade não
existe, o run reporta e para — um run de persona que "imaginasse" a interface em
silêncio seria pior que nenhum run.

`leopold doctor` reporta o módulo de persona por harness — skills presentes,
contratos encontrados, guard hook instalado, capacidade de browser dita com
honestidade — então uma capacidade ausente é uma linha nomeada, nunca um zero que
parece sucesso. Flags do driver e ambiente vivem em
[Configuração do Driver](../reference/driver-config.md#persona-runs-leopold-persona).

Sob demanda hoje — na sessão (`/leopold-persona run <flow>`) ou headless
(`leopold persona run <flow>`, que escreve a mesma árvore de run e re-sintetiza o
relatório de qualquer run com `leopold persona report <run-dir>`); cadência
agendada vem numa release futura, depois de verificar ao vivo os schedulers dos
dois harnesses.

---

*Inspirado no trabalho de personas do [Daniel Mendes](https://github.com/DanielMendesSensei).*
