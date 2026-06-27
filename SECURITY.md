# Security Policy

Leopold runs autonomous coding sessions, so its security posture is the product,
not an afterthought.

## The guarantee

While a run is active, Leopold blocks exactly two actions at the tool-call layer
(a hook in-session, a `canUseTool` gate in the driver): `git commit` and `git push`
(force-push always). These are unlocked only by explicit per-run opt-in tokens that
the human creates (`.leopold/ALLOW_GIT`, `.leopold/ALLOW_PUSH`); force-push stays
denied regardless. The run stages its work and the human owns the commit/push.
A change that lets a run commit or push without the opt-in token is a security bug.

Everything else — including `rm -rf`, `reset --hard`, and package publishing — is
intentionally the run's own call. Isolate a run with `--worktree` if you want a
filesystem boundary around it.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Instead, use
GitHub's private vulnerability reporting (Security tab → "Report a vulnerability")
on this repository, or contact the maintainer directly.

Include: what the guard fails to block, a minimal reproduction, and the impact.
We aim to acknowledge reports within a few days.

## Scope

In scope: any path that lets an autonomous run `git commit` or `git push`
without the documented opt-in token, or that lands a force-push at all. Out of
scope: every other action (the run is meant to perform those autonomously),
actions a user explicitly opted into via a token, and Claude Code's own
permission system.
