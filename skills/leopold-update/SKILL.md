---
name: leopold-update
version: 0.1.0
description: "Update the Leopold engine (skills + hooks) to the latest release: pulls the source and re-runs the installer."
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

This pulls the latest source (`~/.local/share/leopold`) and re-runs `install.sh`
(idempotent, backs up settings). For the Claude Code plugin install, use
`claude plugin update leopold` instead; for the npm driver, `npm i -g leopold-driver@latest`.

To opt into automatic updates (the brief checks and updates on its own):
`touch ~/.leopold/auto-update`. Remove the file to go back to notify-only.
