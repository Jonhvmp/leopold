# Workflows Dinâmicos

O Leopold roda em cima dos [workflows dinâmicos](https://code.claude.com/docs/en/workflows) do Claude Code.
Um workflow dinâmico é um script JavaScript que orquestra subagentes em escala: o
plano vive em **código**, não em uma janela de contexto que só cresce, então uma run longa
não deriva para os modos de falha aos quais um contexto único está sujeito — preguiça
agêntica (parar no item 35 de 50), viés autopreferencial (avaliar o próprio trabalho) e
deriva de objetivo (perder o charter ao longo das compactações). O Leopold continua sendo a
camada de autonomia governada — um brief durável, um charter que decide, um git
travado — e usa workflows como substrato de execução.

Existem três formas de rodar um brief do Leopold como workflow, todas compartilhando o mesmo formato compilado.

## O brief, compilado

O `PLAN.md` vira **ondas de dependência**: a onda 1 é todo item sem dependência pendente,
a onda 2 é todo item cujas dependências `(after: N)` estão todas na onda 1, e assim por diante. Cada
item é classificado por risco com as mesmas regras de palavra-chave que o driver usa em todo lugar —
`effort` (`low` para um typo, `max` para uma migração), `critical` (billing/auth/migrações,
que ganham um painel de review mais amplo) e `sensitive` (diffs que tocam segurança). O resultado
são os `args` que o script canônico de workflow consome:

```json
{
  "mission": "…", "charter": "…", "maxReviewRounds": 2,
  "waves": [
    [{ "id": "i1", "text": "Add a health endpoint", "effort": "medium", "critical": false, "sensitive": false }],
    [{ "id": "i2", "text": "Migrate the payments table", "effort": "max", "critical": true, "sensitive": true }]
  ]
}
```

O script canônico roda cada item em **implementa → verificação adversarial com lentes
diversas → corrige**, em loop até `maxReviewRounds`, com os itens de uma onda rodando em série
(seguro em uma única working tree) e o fan-out de review de cada item rodando em paralelo
(somente leitura). O git fica travado de graça — um workflow não consegue commitar; ele deixa
staged, você commita.

## Três formas de rodar

| Caminho | Quem roda | Quando |
| --- | --- | --- |
| **`/leopold-workflow`** (skill) | O runtime nativo, de dentro de uma sessão do Claude Code | Interativo; você acompanha em `/workflows` |
| **`leopold-driver workflow`** | Emite `.claude/workflows/leopold-run.js` + `.leopold/workflow-args.json`, deterministicamente | CI/scripts que compilam agora e rodam depois |
| **`leopold-driver workflow --run`** | O runtime experimental dentro do driver, headless | Cron/CI, sem sessão interativa (alfa) |

A skill `/leopold-workflow` compila o brief e o lança no runtime nativo.
O `leopold-driver workflow` faz a **mesma compilação como código testado** (não guiada pelo modelo)
e emite o script + args, de forma que a compilação é reproduzível e verificável em CI. A
flag `--run` executa o script emitido através de um runtime experimental do lado do SDK que
implementa os mesmos globais `agent`/`pipeline`/`parallel`/`phase`/`log`/`budget` com um
teto real de concorrência — o engine de orquestração tem testes unitários; a chamada de agente é
um shim fino apoiado em query.

!!! note "Status"
    O `--run` é experimental, consistente com a postura alfa do driver do SDK: a
    orquestração tem testes unitários, mas o agente apoiado em query ainda não foi exercitado
    de ponta a ponta. O caminho de compilar/emitir é determinístico e totalmente testado.

## Acompanhando uma run

O [dashboard de watch](../getting-started/first-run.md) descobre os arquivos de run do próprio
runtime nativo e renderiza uma **árvore de fases** ao vivo: cada run com seu status, contagem de
agentes e totais de tokens/ferramentas; cada fase com suas contagens de concluídos/rodando; cada
agente com um ponto de status (pulsa enquanto roda), rótulo, tokens, chamadas de ferramenta e sua
última ferramenta. Quando o projeto não tem runs de workflow, o painel se esconde sozinho.

## Padrões relacionados como skills

O Leopold traz outros harnesses de workflow dinâmico além do engine de run:

- **`/leopold-learn`** — minera as decisões de uma run, as transcrições de sessão e o histórico
  git em busca de decisões de julgamento recorrentes; um cético mata os candidatos fracos; os
  sobreviventes viram propostas de emenda ao charter. O driver do SDK pode rodar isso
  automaticamente em um fim limpo (`learn_on_finish`).
- **`/leopold-triage`** — faz a triagem de um backlog com o padrão de *quarentena*: agentes que
  leem conteúdo não confiável não têm acesso ao repositório e só emitem campos estruturados.
- **Plano por torneio** no `/leopold-brief` — três redatores, dois juízes, um sintetizador.

Veja [Skills](../reference/skills.md) para cada um.
