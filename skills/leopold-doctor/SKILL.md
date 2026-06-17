---
name: leopold-doctor
version: 0.1.1
description: "Diagnose the Leopold install: checks skills, hooks and their wiring, gstack, the driver toolchain, and whether an update is available."
allowed-tools:
  - Bash
triggers:
  - leopold doctor
  - check leopold install
---

# /leopold-doctor

Verify that Leopold is installed correctly. Read-only.

Run:

```bash
bash ~/.claude/leopold/scripts/leopold-doctor.sh
```

Report the summary. If any `[FAIL]` lines appear, tell the user the exact fix
(usually re-running `./install.sh`, installing `jq`, or installing the plugin).
