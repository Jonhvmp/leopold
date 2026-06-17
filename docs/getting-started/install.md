# Install

Leopold has two tiers. The **in-session engine** (skills + hooks) is all you need
to start and runs in plain Claude Code. The **SDK driver** is optional and adds
unattended, background runs.

## Prerequisites

- [Claude Code](https://claude.com/claude-code), logged in.
- `jq` on your `PATH` (the hooks use it to parse state safely).
- For the SDK driver only: Node.js 18+ .
- Optional but recommended: [gstack](https://github.com/garrytan/gstack), so
  Leopold can conduct the full skill toolchain.

## Install the in-session engine

```bash
curl -fsSL https://raw.githubusercontent.com/Jonhvmp/leopold/main/install.sh | bash
```

Or clone it (more transparent):

```bash
git clone https://github.com/Jonhvmp/leopold.git && cd leopold && ./install.sh
```

What the installer does:

```mermaid
flowchart LR
    Run["./install.sh"] --> S["copy skills →<br/>~/.claude/skills/"]
    Run --> H["copy hooks/templates/docs →<br/>~/.claude/leopold/"]
    Run --> M["merge hooks into<br/>~/.claude/settings.json"]
    M --> Idem{{"idempotent +<br/>backup"}}
```

The two hooks are wired into your settings, but they are **inert unless a Leopold
run is active**, so they never interfere with normal sessions.

!!! tip "It is safe to re-run"
    `install.sh` is idempotent. It backs up `settings.json` to
    `settings.json.leopold.bak` and never duplicates hook entries.

## Install the SDK driver (optional)

```bash
cd packages/driver
npm install
npm run build
```

The driver uses your existing Claude Code login for both the worker and the
conductor, so there is **no separate API key**. See
[Driver Config](../reference/driver-config.md).

## Verify

```bash
# in any project, after writing a brief:
/leopold-status
```

If Leopold is installed, this reports "No Leopold run in this project." (which is
the correct answer before you start one).

## Install as a Claude Code plugin (one command, auto-wires hooks)

Once published, the plugin is the most native install — it wires the skills and
hooks automatically, no `settings.json` merge:

```bash
claude plugin marketplace add Jonhvmp/leopold
claude plugin install leopold@leopold
```

Use the plugin **or** `install.sh`, not both, to avoid double-wired hooks.

## The SDK driver from npm

For the background-driver tier:

```bash
npm i -g leopold-driver
# then, in a project that has a .leopold/ brief:
leopold-driver
```
