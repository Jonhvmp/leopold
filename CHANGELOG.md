# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-17

### Added
- `leopold doctor` (`make doctor`, `/leopold-doctor`): diagnoses the install — skills, hooks and their wiring, gstack, the driver toolchain, and update status.

### Changed
- Auto-release CI: npm publish is now idempotent (skips a version already on npm).

## [0.1.0] - 2026-06-17

Initial public release.

### Added
- In-session engine: `/leopold-brief`, `/leopold-run`, `/leopold-status`, `/leopold-stop`.
- Stop hook (autonomous continuity) and PreToolUse hook (git lock), with behavior tests.
- Brief artifacts (MISSION, CHARTER, GUARDRAILS, PLAN, DECISIONS) and the decision protocol.
- SDK driver (`packages/driver/`, npm `leopold-driver`): persistent conductor + fresh workers per item, conductor/worker status protocol, charter-grounded decisions, git-locked `canUseTool`, notifications. Uses your Claude Code auth (no API key).
- Optional gstack integration (detect + offer; never bundled) with planning hooks in `/leopold-brief`.
- Run hygiene: clears `STOP` + git opt-in tokens on stop; `on_finish: keep | archive`; single-run-per-checkout guard with worktree guidance for parallelism.
- Install paths: one-command `curl | bash`, `install.sh`, `make`, and a Claude Code plugin (`.claude-plugin/`).
- Docs site (MkDocs Material + Mermaid) and CI.
