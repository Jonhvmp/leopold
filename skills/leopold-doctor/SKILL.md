---
name: leopold-doctor
version: 0.1.3
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

Run it from the project directory when a run's continuity is the question: with a
`.leopold/` brief present, doctor also reports whether the run will survive a full
context window — checkpoint present / absent / malformed (naming the section that
failed parsing), the `continuity` setting (auto relaunches; manual names
`/leopold-run` as the resume), windows used vs `max_windows`, the last window's
closed-item count, and the kill switch.

Report the summary. If any `[FAIL]` lines appear, tell the user the exact fix
(usually re-running `./install.sh`, installing `jq`, or installing the plugin).

Two of those failures are about the toolchain having **two version surfaces** — the
assets carrying `VERSION`, and the `leopold-driver` binary on PATH — which are updated
by different mechanisms and therefore drift:

- **`toolchain SPLIT: driver X · assets Y`** — one update moved only half of it, so
  every driver-side feature of release Y is missing locally while the install looks
  current. Doctor names the command that closes the gap.
- **`multiple leopold-driver installs on PATH with different versions`** — a newer
  driver was installed into one npm prefix while an older install earlier in PATH keeps
  winning. Doctor lists every install, the one PATH runs first. Tell the user to remove
  the stale one; `leopold-driver update` cannot fix this, because the stale binary is
  what executes that command.

A `toolchain: driver X · assets X — both surfaces agree` line is the healthy case.

One Codex-specific warning is expected until the user acts on it: Codex keeps a
hook declared in `config.toml` inert until it has been trusted once. The fix is to
open Codex once and approve the Leopold hooks, or to install Leopold as a Codex
plugin. Headless runs (`leopold run --provider codex`) are unaffected.
