# Cost control & secret/extension security

Three native ports of things paperclip does well, into the Leopold harness: a USD
budget hard-stop, a secret vault that keeps secrets out of the prompt, and
capability-gating for extensions. No Postgres, no daemon — state in `.leopold/`,
secrets encrypted on disk, consent at the CLI.

## 1. USD budget hard-stop (SDK driver)

The Claude Code CLI already reports `total_cost_usd` per session, so there is no model
price map: the driver accumulates the real cost per item and stops the run when it
crosses the cap. A count cap (`max_subagents`) says nothing about dollars — this is the
dollar ceiling.

- `leopold-driver run --budget-usd 5` (or `LEOPOLD_BUDGET_USD=5`) sets a $5 cap.
- `worker.ts` reads `total_cost_usd` from the `result` event; `loop.ts` accumulates it
  into `state.spent_usd` and logs a `cost` event per item.
- Enforced at the top of the loop (before each item): once `spent_usd >= budget_usd` the
  run stops with `budget_exceeded`, notifies, and leaves the work staged.
- Pure decision functions (`parseBudgetUsd`, `overBudget`) in `budget.ts` are unit-tested.

## 2. Secrets out of the prompt (encrypted vault)

Today the worker is a raw Claude Code session, so any secret the work needs tends to get
typed into the prompt/transcript. This injects secrets as **environment variables**
instead: they reach the worker's Bash tool as `$NAME` but never enter the prompt.

- `leopold-driver secrets set NAME` (value read from **stdin**, so it never lands in shell
  history) encrypts into `.leopold/secrets.env`; `secrets list` shows names only.
- At rest: **AES-256-GCM**. The 32-byte master key lives at
  `~/.claude/leopold/secrets.key` (mode `0600`, generated on demand); the vault is the
  encrypted blob. Wrong/rotated key → fail closed (no secrets).
- `worker.ts` decrypts the vault and sets the values into `process.env` for the item
  (and passes them as `options.env`), restoring the environment afterward. The worker is
  told to use `$NAME` and never echo a value.
- The guard protects the vault and key: the worker may not `Read`, `Bash`-`cat`, or
  `Edit` either file (driver `guard.ts` + bash `guard-irreversible.sh`).

## 3. Capability-gating for extensions

An extension declares what it does up front, and the toolchain menu requires consent
before granting it on install/update.

- `extension.json` gains a `capabilities` array, e.g. ovmem:
  `["network", "settings.write", "filesystem.home", "package.install", "process.spawn"]`.
- `leopold-menu.sh` shows the declared capabilities in the component view, and
  `Install` / `Update` now route through `ext_consent` — it prints the capabilities and
  requires a `y` before running `manage.sh install`/`update`. No declaration → nothing to
  gate. All four bundled extensions (leopold, serena, gstack, ovmem) declare theirs.

## Files

| Area | Files |
|---|---|
| Budget | `packages/driver/src/{budget,config,loop,worker,types,index}.ts`, `test/budget.test.ts` |
| Secrets | `packages/driver/src/{secrets,worker,guard,index}.ts`, `hooks/guard-irreversible.sh`, `test/secrets.test.ts` |
| Capabilities | `extensions/*/extension.json`, `scripts/leopold-menu.sh` |

## Verification

- `make driver-test` (unit): budget decisions; secret round-trip + on-disk encryption (no
  plaintext) + `0600` key + env apply/restore; the guard suite (unchanged behavior + new
  secret-file denials).
- CLI smoke: `secrets set` via stdin encrypts (no plaintext in the vault), `secrets list`,
  key is `0600`, invalid names rejected. `leopold menu` shows capabilities and gates
  install/update on consent.
- `tsc --noEmit` and `make hooks-check` green.

Note: budget and secret injection target the SDK driver (Path A), where the driver
controls the worker. The bash guard still protects the secret files in the in-session path.
