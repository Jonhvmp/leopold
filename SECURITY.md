# Security Policy

Leopold runs autonomous coding sessions, so its security posture is the product,
not an afterthought.

## The guarantee

While a run is active, Leopold blocks `git commit`, `git push`, force-push,
`reset --hard`, `rm -rf`, PR/release creation, and package publishing at the
tool-call layer (a hook in-session, a `canUseTool` gate in the driver). These are
unlocked only by explicit per-session opt-in tokens that the human creates. A
change that weakens this without an explicit opt-in is a security bug.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Instead, use
GitHub's private vulnerability reporting (Security tab → "Report a vulnerability")
on this repository, or contact the maintainer directly.

Include: what the guard fails to block, a minimal reproduction, and the impact.
We aim to acknowledge reports within a few days.

## Scope

In scope: any path that lets an autonomous run perform a gated or forbidden
action (commit, push, destructive command, outbound publish) without the
documented opt-in. Out of scope: actions a user explicitly opted into via a
token, and Claude Code's own permission system.
