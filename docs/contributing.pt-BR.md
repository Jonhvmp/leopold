# Contribuindo

Valeu por querer ajudar a reger a orquestra.

## Regras básicas

- O Leopold rege o Claude Code pelas suas superfícies públicas (skills, hooks,
  ambiente). Ele **não** faz fork do Claude Code nem remenda skills do gstack.
  Mantenha as contribuições dentro dessa fronteira.
- **Guardrails são sagrados.** Qualquer mudança que possa deixar uma run
  autônoma commitar, dar push ou rodar um comando destrutivo sem um opt-in
  explícito é um bug, não uma feature. Mudanças assim precisam de um teste que
  prove que o lock continua valendo.
- Prefira design orientado pelo modelo: o comportamento vive em prompts, no
  charter e em descrições de ferramenta em linguagem natural, não em
  roteadores rígidos em código.

## Trabalhando nos hooks

Os hooks são bash POSIX-ish com uma única dependência (`jq`). Eles precisam:

- falhar **aberto** na continuidade (um Stop hook quebrado nunca pode prender uma sessão), e
- falhar **seguro** na proteção (na dúvida sobre um comando destrutivo, negue).

Valide a sintaxe com `bash -n hooks/*.sh`.

## Trabalhando no driver

```bash
cd packages/driver
npm install
npm run typecheck
npm run build
```

## Trabalhando na documentação

```bash
pip install -r requirements-docs.txt
mkdocs serve         # live preview at http://127.0.0.1:8000
mkdocs build --strict  # what CI runs
```

## Estilo

- Somente inglês em código, comentários, docs e mensagens de commit.
- Comece pelo ponto. Nomeie arquivos e comandos. Sem enrolação.

## Pull requests

Mantenha cada PR focado. Descreva o que mudou, por quê e como você verificou.
Se tocar em guardrails, mostre o teste.
