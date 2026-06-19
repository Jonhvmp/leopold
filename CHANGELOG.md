# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Toolchain manager** (`make menu`, `scripts/leopold-menu.sh`): a data-driven interactive menu over an extension registry (`extensions/`). Each extension declares `extension.json` + `manage.sh` (`detect | status | install | update | remove | doctor`). Generalizes the one-off gstack prompt into install/manage for any companion component.
- **gstack** and **ovmem** registry extensions. `install.sh` now vendors `extensions/` into `~/.claude/leopold/`.
- **ovmem extension** — autonomous RAG long-term memory (OpenViking + 4 hooks). Installer ships the OpenAI profile (validates the key against chat + embeddings, writes `ov.conf`, wires the 4 hooks idempotently, verifies via a round-trip). Linux + macOS; native Windows is gated with a "use WSL" message. Fully-local Ollama/GGUF profiles are still TODO.

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
