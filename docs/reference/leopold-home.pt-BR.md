# O asset home do Leopold

O Leopold instala em dois lugares. O **harness home** (`~/.claude` ou `~/.codex`)
recebe o que cada agente carrega sozinho — skills, settings, wiring dos hooks. O
**asset home** recebe a metade neutra de harness: `hooks/`, `templates/`, `docs/`,
`scripts/`, `extensions/`. Tudo que precisa apontar para um arquivo do Leopold —
uma skill, o instalador de uma extensão, a linha de comando de um hook — aponta
para o asset home.

Nem sempre é `~/.claude/leopold`. Numa máquina só com Codex não existe
`~/.claude`, e `LEOPOLD_HOME` relocaliza o diretório para onde você quiser. Por
isso nada no produto hardcoda caminho: tudo resolve o home em tempo de execução.

## `leopold home`

```console
$ leopold home
/home/voce/.claude/leopold
```

Um caminho absoluto, uma linha, exit 0. Nunca falha e não pergunta nada ao
harness — é resolução pura de caminho, segura de chamar de dentro de um hook.

O caminho **não** tem garantia de existir. `leopold home` responde "onde os
assets do Leopold estariam", que é exatamente o que um instalador precisa; quem
depende dos assets checa o arquivo que quer e avisa se faltar. Quem verifica a
instalação é o `leopold doctor`.

## Precedência

Idêntica no `install.sh`, no `scripts/leopold-doctor.sh` e no driver
(`leopoldHome()` em `packages/driver/src/provider.ts`):

1. **`LEOPOLD_HOME`** — ganha de tudo, independente do que exista na máquina.
2. **`$CLAUDE_HOME/leopold`** se existir (`CLAUDE_HOME` cai em `~/.claude`). Onde
   o Claude Code está em jogo, ele segue sendo o asset home — instalação antiga
   nunca precisa de migração.
3. **`$CODEX_HOME/leopold`** se existir (`CODEX_HOME` cai em `~/.codex`).
4. Nada instalado ainda — prevê onde o `install.sh` colocaria: o caminho do
   Claude, a menos que o Codex seja o único harness da máquina, espelhando a
   detecção do `--harness auto`.

| Máquina | `leopold home` |
| --- | --- |
| `LEOPOLD_HOME=/opt/leo` | `/opt/leo` |
| Claude Code instalado | `~/.claude/leopold` |
| Claude Code + Codex | `~/.claude/leopold` |
| Só Codex | `~/.codex/leopold` |
| Nenhum | `~/.claude/leopold` |

## O fallback sem CLI

Skills e hooks rodam em shells que podem não ter o `leopold` no `PATH` — um clone
do repo com `make install` e sem npm global, por exemplo. Use o CLI quando ele
estiver lá e caia para o shell quando não estiver:

```sh
LEO_HOME="$(leopold home 2>/dev/null || leopold_home)"
```

```sh
# Resolve exatamente como o `leopold home`. POSIX sh, sem dependência.
leopold_home() {
  _c="${CLAUDE_HOME:-$HOME/.claude}"; _x="${CODEX_HOME:-$HOME/.codex}"
  if [ -n "${LEOPOLD_HOME:-}" ]; then
    case "$LEOPOLD_HOME" in /*) printf '%s\n' "$LEOPOLD_HOME";; *) printf '%s\n' "$PWD/$LEOPOLD_HOME";; esac
  elif [ -d "$_c/leopold" ]; then printf '%s\n' "$_c/leopold"
  elif [ -d "$_x/leopold" ]; then printf '%s\n' "$_x/leopold"
  elif command -v claude >/dev/null 2>&1 || [ -d "$_c" ] || ! { command -v codex >/dev/null 2>&1 || [ -d "$_x" ]; }; then
    printf '%s\n' "$_c/leopold"
  else printf '%s\n' "$_x/leopold"
  fi
}
```

Esse bloco não é enfeite: o `packages/driver/test/provider.test.ts` extrai o
bloco equivalente da versão em inglês, roda nos mesmos ambientes que o
`leopoldHome()` e compara as saídas. Se os dois divergirem, o `make test` fica
vermelho.

Quando a skill só precisa do home *depois* que o Leopold já está instalado, a
forma curta basta — o diretório que ela nomeia com certeza existe:

```sh
LEO_HOME="${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}/leopold" || echo "${CODEX_HOME:-$HOME/.codex}/leopold")}"
```

Uma ressalva sobre `LEOPOLD_HOME`: o driver normaliza o valor (`path.resolve`),
então `/opt/leo/` e `/opt/../opt/leo` voltam como `/opt/leo`; o fallback em shell
só torna absoluto um valor relativo. Aponte para um caminho absoluto simples e os
dois batem exatamente.
