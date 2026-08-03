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

Run (the assets live under `~/.claude/leopold` when Claude Code is installed,
otherwise `~/.codex/leopold`):

```bash
bash ~/.claude/leopold/scripts/leopold-doctor.sh 2>/dev/null \
  || bash ~/.codex/leopold/scripts/leopold-doctor.sh
```

It checks every harness it finds — Claude Code and Codex — since Leopold's skills
and both hooks run on either.

Report the summary. If any `[FAIL]` lines appear, tell the user the exact fix
(usually re-running `./install.sh`, installing `jq`, or installing the plugin).

One Codex-specific warning is expected until the user acts on it: Codex keeps a
hook declared in `config.toml` inert until it has been trusted once. The fix is to
open Codex once and approve the Leopold hooks, or to install Leopold as a Codex
plugin. Headless runs (`leopold run --provider codex`) are unaffected.
