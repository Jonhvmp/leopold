---
name: leopold-update
version: 0.1.0
description: "Update the whole Leopold toolchain to the latest release: pulls the source, re-runs the installer, and brings the npm driver to the same version."
allowed-tools:
  - Bash
triggers:
  - leopold update
  - update leopold
---

# /leopold-update

Update the installed Leopold engine to the latest version.

Run:

```bash
LEO="$(leopold home 2>/dev/null || echo "${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}" || echo "${CODEX_HOME:-$HOME/.codex}")/leopold}")"
bash "$LEO/scripts/leopold-update.sh"
```

This pulls the latest source (`~/.local/share/leopold`), re-runs `install.sh`
(idempotent, backs up settings), and then brings the npm driver to the same version.
Both surfaces move, or the output names the half it could not move — the toolchain has
two of them (the assets carrying `VERSION`, and the `leopold-driver` binary on PATH),
and updating one while calling the toolchain current is how a machine ends up minors
apart from itself with everything reading "up to date".

For the Claude Code plugin install, use `claude plugin update leopold` instead.

Report the result as it comes out. Three lines matter and none of them is a
formality:

- **`toolchain SPLIT`** or a `WARNING` about npm — the assets moved and the driver did
  not. Every driver-side feature of the release is missing locally while everything
  looks updated. The output names the exact command to finish the job.
- **`PATH still resolves <older version>`** — npm installed the new driver into its
  prefix, but an older install earlier in PATH keeps winning. This one hides itself:
  the update reports success, and `leopold-driver update` cannot escape it either,
  because the stale binary is what executes that command. The output lists every
  install, winner first; the stale one has to be removed by hand.
- **`current on both surfaces`** — the only line that means done.

To opt into automatic updates (the brief checks and updates on its own):
`touch ~/.leopold/auto-update`. Remove the file to go back to notify-only.
