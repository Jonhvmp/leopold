# Leopold extension registry

The toolchain manager (`scripts/leopold-menu.sh`, or `make menu`) is data-driven: it
discovers everything under this directory and drives each one through a uniform contract.
This is the generalization of the one-off gstack prompt that used to live in `install.sh`.

## Layout

```
extensions/
  <name>/
    extension.json   # metadata the menu renders
    manage.sh        # the actions the menu calls
    README.md        # optional, per-extension docs
```

## extension.json

```json
{
  "name": "gstack",
  "title": "gstack",
  "summary": "One-line description shown in the menu.",
  "homepage": "https://...",
  "license": "MIT",
  "order": 20
}
```

`order` controls position in the menu (lower first). Convention: Leopold core 10,
the toolchain it conducts 20, companion capabilities 30+.

## manage.sh contract

`manage.sh <action>` where action is one of:

| action  | must do | exit code |
|---------|---------|-----------|
| `detect`  | nothing visible; just probe | `0` if installed, non-zero if not |
| `status`  | print one short line (e.g. version/health) | `0` |
| `install` | install the component | `0` on success |
| `update`  | update to latest | `0` on success |
| `remove`  | uninstall (be reversible / safe where possible) | `0` on success |
| `doctor`  | print diagnostics (what's wired, what's missing) | `0` |

Rules:
- Keep it idempotent. `install` run twice must not break anything.
- Never touch the user's git. Never print secrets.
- `detect` is the single source of truth for "installed?" — keep it cheap (no network).
- Resolve the Claude home as `${CLAUDE_HOME:-$HOME/.claude}`.

Adding a component is just dropping a new folder here with these two files.
