# Controle de custo & segurança de secrets/extensões

Três ports nativos de coisas que o paperclip faz bem para dentro do harness do
Leopold: um hard-stop de budget em USD, um vault de secrets que mantém secrets fora
do prompt e gating de capabilities para extensões. Sem Postgres, sem daemon — estado
em `.leopold/`, secrets criptografados em disco, consentimento na CLI.

## 1. Hard-stop de budget em USD (driver SDK)

A CLI do Claude Code já reporta `total_cost_usd` por sessão, então não existe mapa de
preços de modelo: o driver acumula o custo real por item e para a run quando ele cruza
o teto. Esse é o teto de dólares confiável para uma run autônoma.

- `leopold-driver run --budget-usd 5` (ou `LEOPOLD_BUDGET_USD=5`) define um teto de $5.
- `worker.ts` lê `total_cost_usd` do evento `result`; `loop.ts` acumula em
  `state.spent_usd` e loga um evento `cost` por item.
- Aplicado no topo do loop (antes de cada item): quando `spent_usd >= budget_usd`, a
  run para com `budget_exceeded`, notifica e deixa o trabalho em stage.
- Funções de decisão puras (`parseBudgetUsd`, `overBudget`) em `budget.ts` têm testes unitários.

## 2. Secrets fora do prompt (vault criptografado)

Hoje o worker é uma sessão crua do Claude Code, então qualquer secret que o trabalho
precisa tende a ser digitado no prompt/transcript. Isto injeta secrets como **variáveis
de ambiente**: elas chegam à tool Bash do worker como `$NAME`, mas nunca entram no prompt.

- `leopold-driver secrets set NAME` (valor lido do **stdin**, então nunca cai no
  histórico do shell) criptografa em `.leopold/secrets.env`; `secrets list` mostra só os nomes.
- Em repouso: **AES-256-GCM**. A master key de 32 bytes fica em
  `~/.claude/leopold/secrets.key` (modo `0600`, gerada sob demanda); o vault é o blob
  criptografado. Chave errada/rotacionada → fail-closed (sem secrets).
- `worker.ts` descriptografa o vault e coloca os valores em `process.env` para o item
  (e os passa como `options.env`), restaurando o ambiente depois. O worker é instruído
  a usar `$NAME` e nunca ecoar um valor.
- A proteção é **criptografia em repouso**, não um guard de leitura: o vault é um blob
  AES-256-GCM e a master key é `0600` fora do projeto, então ler `secrets.env` rende
  ciphertext sem chave. O worker nunca precisa do arquivo — ele recebe os valores como `$NAME`.

## 3. Gating de capabilities para extensões

Uma extensão declara de antemão o que faz, e o menu do toolchain exige consentimento
antes de conceder no install/update.

- `extension.json` ganha um array `capabilities`, ex. ovmem:
  `["network", "settings.write", "filesystem.home", "package.install", "process.spawn"]`.
- `leopold-menu.sh` mostra as capabilities declaradas na visão do componente, e
  `Install` / `Update` agora passam por `ext_consent` — ele imprime as capabilities e
  exige um `y` antes de rodar `manage.sh install`/`update`. Sem declaração → nada a
  liberar. As cinco extensões incluídas (leopold, serena, gstack, ovmem, enhance) declaram as suas.

## Arquivos

| Área | Arquivos |
|---|---|
| Budget | `packages/driver/src/{budget,config,loop,worker,types,index}.ts`, `test/budget.test.ts` |
| Secrets | `packages/driver/src/{secrets,worker,guard,index}.ts`, `hooks/guard-irreversible.sh`, `test/secrets.test.ts` |
| Capabilities | `extensions/*/extension.json`, `scripts/leopold-menu.sh` |

## Verificação

- `make driver-test` (unitário): decisões de budget; round-trip de secret +
  criptografia em disco (sem plaintext) + chave `0600` + apply/restore de env; a suíte
  do guard (só o lock de git commit/push).
- Smoke de CLI: `secrets set` via stdin criptografa (sem plaintext no vault), `secrets list`,
  a chave é `0600`, nomes inválidos são rejeitados. `leopold menu` mostra as capabilities
  e condiciona install/update ao consentimento.
- `tsc --noEmit` e `make hooks-check` verdes.

Nota: budget e injeção de secrets miram o driver SDK (Path A), onde o driver controla
o worker. O guard de bash continua protegendo os arquivos de secrets no caminho in-session.
