# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-06-19

### Added
- **`examples/`** — a reproducible run (`add-json-output`): the full brief plus the
  `DECISIONS.md` an autonomous run produced from it. Proves the loop and teaches the format.
- **Demo cast** (`assets/demo.cast` + `assets/demo.svg`) at the top of the README, with
  `scripts/record-demo.sh` to regenerate it.
- **Loop detection** (`max_no_progress`, default 6): if the open `PLAN.md` set is unchanged
  for N turns, the run stops with `no_progress` instead of thrashing. Tested in `make hooks-test`.
- **ovmem provider switching** — re-running the ovmem installer detects the current setup,
  offers to reuse the existing credential, and safely **rebuilds the vector index when the
  embedding model changes** (OpenAI ⇄ Bedrock): memory content is preserved, the old index
  is backed up and restored if the rebuild fails. Server restarts are data-dir-lock-aware.

### Security
- **Hardened the PreToolUse guard.** Replaced loose regexes with real parsing and closed confirmed bypasses: `git -c user.name=x commit` / `git -C /r commit` / `git --git-dir=… commit` and git by absolute path / `env git` (global options skipped, subcommand resolved by basename), `rm --recursive --force` / `rm -r -f` / `/bin/rm -rf` (recursive+force in any spelling), `find … -delete` / `find … -exec rm`, and whitespace/tab evasion (normalized before matching). The guard **fails closed** on a malformed `state.json`.
- **`LEOPOLD_PARANOID=1`** — opt-in deny-by-default allowlist mode (only read/build/test/lint + `git add`/read-only `git` pass), documented in `docs/guardrails.md`.
- **State validation.** `stop-continuity` fails **safe and loud** (stops the run, logs it) on a malformed `state.json` or a non-numeric budget field, instead of silently skipping the iteration budget.
- **Red-team test suite** (`scripts/test-guard.sh`, `make test-guard`): **59** bypass-attempt cases, run in CI.

### Changed
- README: tighter, Quickstart moved to the top, badges (CI / npm / license / works-with-Claude-Code / stars), and a Safety section documenting the red-teamed guard.
- `stop-continuity` blocks loudly (with a clear reason) on a malformed `state.json` rather than stopping silently.

### Fixed
- The driver's `canUseTool` guard (`guard.ts`) had the **same bypasses** as the bash guard — hardened to match, and given unit tests (`test/guard.test.ts` + `test/protocol.test.ts`, `make driver-test`, in CI on Node 22). The driver's "tested" claim is now backed by real tests instead of being softened.
- `docs/guardrails.md` marks fine-grained loop detection as roadmap (the engine enforces the consecutive-failure and iteration budgets today).

## [0.3.0] - 2026-06-19

### Added
- **ovmem: provider + model picker.** The installer now asks for a provider and a chat/embedding model, showing the price of each (USD per 1M tokens) from `extensions/ovmem/models.json`.
  - **OpenAI** — `gpt-4o-mini` / `gpt-4.1-mini` / `gpt-4o`; embeddings `text-embedding-3-small` / `-large`.
  - **AWS Bedrock** (via OpenViking's LiteLLM backends) — chat `nova-lite` / `claude-3-5-haiku` / `claude-3-5-sonnet` / `claude-sonnet-4-5`; embeddings `titan-embed-v2` / `cohere-embed-v3` / `titan-embed-v1`. Auth is a Bedrock API key (bearer token) + region; the installer adds `boto3` to the OpenViking venv and injects the credentials into the server env. (Beta — not yet run against a live AWS account in CI.)
- Headless install via `OVMEM_PROVIDER` / `OVMEM_CHAT_MODEL` / `OVMEM_EMBED_MODEL` + the provider credential.
- `ovmem doctor` now reports the configured provider, chat and embedding models.

## [0.2.1] - 2026-06-19

### Changed
- `install.sh` now offers to open the toolchain manager at the end of **every** install path — including `curl … | bash`. It reads the prompt from `/dev/tty` (the controlling terminal) instead of stdin, so the menu works even when the script is piped. Headless/CI runs (no terminal) just print the command.

## [0.2.0] - 2026-06-19

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
