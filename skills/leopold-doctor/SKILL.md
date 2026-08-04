---
name: leopold-doctor
version: 0.1.2
description: "Diagnose the Leopold install on every harness present (Claude Code, Codex): checks skills, hooks and their wiring, gstack, the driver toolchain, and whether an update is available."
allowed-tools:
  - Bash
triggers:
  - leopold doctor
  - check leopold install
---

# /leopold-doctor

Verify that Leopold is installed correctly. Read-only.

Run (the first line resolves the Leopold asset home: `LEOPOLD_HOME` wins, then the
Claude Code home, then the Codex one — same order as the installer):

```bash
LEO="$(leopold home 2>/dev/null || echo "${LEOPOLD_HOME:-$([ -d "${CLAUDE_HOME:-$HOME/.claude}/leopold" ] && echo "${CLAUDE_HOME:-$HOME/.claude}" || echo "${CODEX_HOME:-$HOME/.codex}")/leopold}")"
bash "$LEO/scripts/leopold-doctor.sh"
```

It checks every harness it finds — Claude Code and Codex — since Leopold's skills
and both hooks run on either.

Report the summary. If any `[FAIL]` lines appear, tell the user the exact fix
(usually re-running `./install.sh`, installing `jq`, or installing the plugin).

One Codex-specific warning is expected until the user acts on it: Codex keeps a
hook declared in `config.toml` inert until it has been trusted once. The fix is to
open Codex once and approve the Leopold hooks, or to install Leopold as a Codex
plugin. Headless runs (`leopold run --provider codex`) are unaffected.
