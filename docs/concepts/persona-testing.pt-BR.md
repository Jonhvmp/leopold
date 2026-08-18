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
  fluxo declara. Aponte fluxos pra staging.
- **Ação irreversível nunca é executada.** Pagamento, deleção, submit destrutivo: o
  condutor registra a intenção como achado em vez de agir — a mesma filosofia do
  [lock de git](../guardrails.md). O run observa e prepara; um humano executa efeitos
  colaterais.
- **Nenhum segredo em diário ou relatório.** Credencial de teste vem do ambiente
  (o vault de secrets); texto gravado e reportado passa pela máscara de credencial.

## Os dois harnesses, com honestidade

As três skills instalam idênticas no Claude Code e no Codex CLI pelo mesmo
instalador. O que difere são as ferramentas de percepção da sessão: um fluxo web
precisa de controle de browser na sessão que o executa. Quando essa capacidade não
existe, o run reporta e para — um run de persona que "imaginasse" a interface em
silêncio seria pior que nenhum run.

Sob demanda hoje (`/leopold-persona run <flow>`); cadência agendada vem numa release
futura, depois de verificar ao vivo os schedulers dos dois harnesses.
