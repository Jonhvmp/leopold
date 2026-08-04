# The Leopold asset home

Leopold installs into two places. The **harness home** (`~/.claude` or `~/.codex`)
gets the parts each agent loads itself — skills, settings, hooks wiring. The
**asset home** gets the harness-neutral half: `hooks/`, `templates/`, `docs/`,
`scripts/`, `extensions/`. Everything that has to point at a Leopold file — a
skill, an extension installer, a hook command line — points at the asset home.

It is not always `~/.claude/leopold`. On a Codex-only machine there is no
`~/.claude`, and `LEOPOLD_HOME` relocates it anywhere. So nothing in the product
hardcodes a path: it resolves the home at run time.

## `leopold home`

```console
$ leopold home
/home/you/.claude/leopold
```

One absolute path, one line, exit 0. It never fails and never asks the harness
anything — it is pure path resolution, safe to call from a hook.

The path is **not** guaranteed to exist. `leopold home` answers "where would
Leopold's assets be", which is exactly what an installer needs; a consumer that
requires the assets checks for the file it wants and says so if it is missing.
`leopold doctor` is the command that verifies the install.

## Precedence

Identical in `install.sh`, `scripts/leopold-doctor.sh`, and the driver
(`leopoldHome()` in `packages/driver/src/provider.ts`):

1. **`LEOPOLD_HOME`** — wins outright, whatever else is on the machine.
2. **`$CLAUDE_HOME/leopold`** if it exists (`CLAUDE_HOME` defaults to
   `~/.claude`). Claude Code stays the asset home wherever it is in play, so
   existing installs never need a migration.
3. **`$CODEX_HOME/leopold`** if it exists (`CODEX_HOME` defaults to `~/.codex`).
4. Nothing installed yet — predict where `install.sh` would put it: the Claude
   path, unless Codex is the only harness on the machine, which mirrors the
   installer's `--harness auto` detection.

| Machine | `leopold home` |
| --- | --- |
| `LEOPOLD_HOME=/opt/leo` | `/opt/leo` |
| Claude Code installed | `~/.claude/leopold` |
| Claude Code + Codex | `~/.claude/leopold` |
| Codex only | `~/.codex/leopold` |
| Neither | `~/.claude/leopold` |

## The no-CLI fallback

Skills and hooks run in shells that may not have `leopold` on `PATH` — a repo
clone with `make install` and no npm global, for instance. Use the CLI when it is
there and fall back to shell when it is not:

```sh
LEO_HOME="$(leopold home 2>/dev/null || leopold_home)"
```

<!-- leopold-home:fallback -->
```sh
# Resolves exactly like `leopold home`. POSIX sh, no dependencies.
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

That block is not decorative documentation: `packages/driver/test/provider.test.ts`
extracts it from this file, runs it under the same environments as `leopoldHome()`,
and asserts both print the same path. If the two ever drift, `make test` goes red.

When a skill only needs the home *after* Leopold is installed, the short form is
enough — the directory it names is guaranteed to be there:

```sh
LEO_HOME="${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}/leopold" || echo "${CODEX_HOME:-$HOME/.codex}/leopold")}"
```

One caveat on `LEOPOLD_HOME`: the driver normalizes it (`path.resolve`), so
`/opt/leo/` and `/opt/../opt/leo` both come back as `/opt/leo`; the shell fallback
only makes a relative value absolute. Set it to a plain absolute path and the two
agree exactly.
