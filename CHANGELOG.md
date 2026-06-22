# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-06-22

### Added
- **USD budget hard-stop** (SDK driver). `leopold-driver run --budget-usd N` (or
  `LEOPOLD_BUDGET_USD`) stops the run once accumulated real spend crosses the cap. The CLI
  already reports `total_cost_usd` per session, so there's no price map: the driver
  accumulates it into `state.spent_usd`, logs a `cost` event per item, and stops with
  `budget_exceeded` before the next item — the dollar ceiling a count cap can't give you.
- **Encrypted secret vault — secrets out of the prompt.** `leopold-driver secrets set NAME`
  (value via stdin, so it never hits shell history) encrypts into `.leopold/secrets.env`
  with AES-256-GCM; the 32-byte master key lives at `~/.claude/leopold/secrets.key`
  (mode 0600, generated on demand). During a run the worker gets the secrets as `$NAME`
  environment variables — never in the prompt/transcript — restored after each item.
  `secrets list` shows names only. The guard forbids the worker from reading or editing the
  vault and key (driver `guard.ts` + bash hook).
- **Capability-gating for extensions.** `extension.json` gains a `capabilities` array
  (declared for leopold, serena, gstack, ovmem); the toolchain menu shows them and requires
  consent before `Install`/`Update` grants them.

## [0.6.0] - 2026-06-22

### Added
- **Run isolation in a git worktree + an orphan reaper** (SDK driver). A native port of two
  things paperclip does well, no Postgres or daemon — state stays in `.leopold/`, the
  orchestrator runs git itself, signals go to process groups.
  - `leopold-driver run --worktree` (or `LEOPOLD_WORKTREE=1`) provisions a dedicated worktree
    on a throwaway branch `leopold/run-<id>` and points the worker's cwd at it, so a run (and
    its subagents, which inherit the cwd) is isolated from your working tree and from other
    runs. The driver runs git directly, so the worker's git lock is unaffected. Falls back to
    the repo root when the project isn't a git repo.
  - On startup the driver reaps a prior run that crashed leaving `state.active: true` — if its
    `orchestrator_pid` is dead (`process.kill(pid, 0)` → ESRCH) it flips the run inactive,
    logs `run_reaped`, and prunes the leftover worktree. It never touches a live run, nor a
    pid-less in-session run.
  - Cleanup is non-destructive: git is locked so a run *stages* but never *commits*, so a
    worktree with uncommitted work is **preserved** (logged `worktree_preserved`) for review;
    only a clean worktree is removed.
- **State write hardening.** `writeState` is now read-merge-write, so the TS driver and the
  bash skill/Stop-hook (two writers, different schemas) stop clobbering each other's fields.

### Changed
- The guard explicitly allows `git worktree`, and `git branch -D` gains a narrow exception for
  the harness's own throwaway `leopold/run-*` branches (every other forced delete stays denied).

## [0.5.0] - 2026-06-22

### Added
- **Extension dashboards in `leopold watch` — a tab per extension.** The run dashboard is
  no longer a single page: it now has a tab bar (`Run` + one tab per extension that ships a
  dashboard). An extension opts in by adding a `dashboard` block to its `extension.json`
  (`label`, `module`, `view`, optional `search`); the watch discovers every installed
  extension with one, imports its module, and renders the declarative card/widget view it
  returns (`{"cards":[...]}`) in Leopold's own design system. It's fail-open — a missing or
  broken module just drops the tab and the run view is untouched. `Run` keeps its live SSE;
  extension tabs poll their own `/api/ext/<name>/stats` (and `/api/ext/<name>/search`) only
  while active.
- **ovmem ships the first dashboard: a `Memory` tab.** OpenViking server health, recall
  hotness, server-side usage (requests / latency / tokens / errors), tracked sessions, a
  live memory search, and the hook log — all read-only. The same panel runs standalone via
  `make ovmem-watch`, `leopold menu → ovmem → w) Watch`, or `manage.sh watch`
  (http://127.0.0.1:1934). The dashboard now ships in the extension payload and is vendored
  into `~/.claude/ovmem/` on install.

## [0.4.6] - 2026-06-19

### Added
- **Uninstall in the toolchain menu (`u`), granular and data-safe.** A new `Uninstall`
  option asks **exactly what to remove** and confirms each pick: Leopold core (skills +
  hooks + `~/.claude/leopold`), the `leopold` npm CLI, serena (MCP + hooks), gstack, and
  ovmem's engine — all of which **keep your data**. Deleting the OpenViking long-term
  memory (`~/.openviking`) + server is a separate item that requires typing `DELETE`. So
  nothing precious goes away by accident. (`leopold menu` → `u`.)

## [0.4.5] - 2026-06-19

### Changed
- **The `leopold-driver` npm version now tracks the repo version.** It had its own
  `0.1.x` line (0.1.3 on npm) while the repo was at `0.4.x`, which was confusing now that
  the npm package *is* Leopold (it bundles the whole harness). The release workflow now sets
  the published version from `VERSION` (single source of truth), so npm and the repo move in
  lockstep. `leopold-driver` jumps `0.1.3 → 0.4.5` to match.

## [0.4.4] - 2026-06-19

### Changed
- **The installer now bundles the `leopold` CLI too, and verifies the install.** After
  copying skills + hooks, `install.sh` runs `npm i -g leopold-driver` (unless `leopold` is
  already on PATH, e.g. you came via `leopold install`), so the `curl … | bash` path also
  gives you the `leopold menu / watch / doctor` commands — not just the npm path. It then
  prints a **verify** summary (skills, hooks, `leopold` CLI, serena) so you can see at a
  glance that everything landed. (Fixes: after merging/installing, `leopold` was "command
  not found" because the harness and the CLI were separate installs.) Driver 0.1.3.

## [0.4.3] - 2026-06-19

### Added
- **Leopold from npm — the `leopold` CLI.** `leopold-driver` now bundles the whole harness
  (installer, skills, hooks, templates, extensions) and ships a CLI as both `leopold` and
  `leopold-driver`: `install`, `menu`, `watch`, `serena`/`gstack`/`ovmem`, `doctor`,
  `update`, and `run`. So `npm i -g leopold-driver && leopold install` sets everything up
  and manages it **without cloning the repo or running `make`** — the realistic path for
  most users. Build vendors the harness into `assets/`; `npm pack` ships it. (Driver 0.1.2.)
- **`/leopold-watch` — local live dashboard with real cost.** A zero-dependency (Python
  stdlib) web dashboard at `http://127.0.0.1:4179`, updating live over SSE. Its headline is
  **real spend** parsed from the Claude Code session transcript — estimated **$**, token
  breakdown (input / output / cache-write / cache-read), **cache-hit %**, per-model, main vs
  subagent, turns and duration (the transcript is found via the run's `transcript_path` or
  the cwd's project slug; cost is cached by file mtime so it's parsed at most once per turn).
  Prices are an estimate from a built-in per-model map, **configurable** via `$LEOPOLD_PRICES`
  or `.leopold/prices.json` (override any model/family; cache rates default to 1.25× / 0.1× in).
  Below it: the budget meters (context MB / subagents / forks / iterations / failures vs
  their budgets), the event feed (turns, guard blocks, `subagent_spawn` with size + fork
  flag, stops), the decisions log, and a **Stop** button (the kill switch). Read-only
  otherwise, loopback-only — nothing leaves the machine.
  Launch with `/leopold-watch`, `make watch`, or `leopold watch` (npm CLI above). The Stop
  hook now also records `context_mb` so the meter is live. Styled to a warm-cream / near-black
  design system (Geist type stack with system fallback — no web fonts, fully offline) with a
  light/dark toggle.

## [0.4.2] - 2026-06-19

### Security
- **Cost guardrails — caps the #1 autonomous-run blowup, on both axes.** Nothing limited
  cost growth: a run could spawn the `Task` tool in bursts of 10+, each carrying a
  multi-MB context, while the main session ballooned every turn (one report: 82 subagents
  and a 5.9MB session over 681 turns). New caps, all in `state.json` / `GUARDRAILS.md` and
  enforced by the hooks:
  - **`max_context_mb`** (default 5) — the Stop hook ends the run when the transcript
    passes this; the brief persists, so a fresh `/leopold-run` resumes from `PLAN.md` with
    clean context. (A long run re-bills its whole growing context every turn — the biggest
    money pit.)
  - **`max_subagents`** (default 8) — total `Task`/subagent spawns per run; denied past it,
    the run continues **serially**.
  - **`max_forks`** (default **0 — forks forbidden**) — a fork clones the *entire* session
    context into the spawn (the literal "each subagent got the 5.8MB parent" leak). A fresh
    subagent does the same work clean. Raise only for a sub-task that needs the full convo.
  - **Oversized subagent prompts** (>~256KB) are denied — that means context is being
    pasted into the spawn; point subagents at file paths instead.
  - **Spawn audit log** — every subagent spawn writes a `subagent_spawn` line to
    `events.jsonl` (size + fork flag) so a run's cost is inspectable.
- **Optimization — the lean orchestrator.** The biggest cost lever isn't the subagents, it's
  the **orchestrator session** re-billing its whole growing context every turn. The
  `/leopold-run` protocol now mandates context discipline: the brief is the memory (not the
  transcript); bulk-output work (authoring content, generating files) is delegated to a
  subagent that **writes to a file**, and the orchestrator verifies the file instead of
  reading the output back — so its context stays flat. Tested in `make hooks-test`. Docs
  recommend an Anthropic spending cap for large runs.

### Added
- **Serena — mandatory LSP code intelligence (MCP).** Leopold's installer now sets up
  [Serena](https://github.com/oraios/serena) automatically (installs `serena-agent` via uv
  if absent, registers the MCP server for all projects via `claude mcp add --scope user …
  --context=claude-code --project-from-cwd`, and wires its recommended hooks). It gives the
  agent symbol-level tools (`find_symbol` / `find_referencing_symbols` / `replace_symbol_body`)
  instead of grep + whole-file reads — sharper edits **and** far fewer tokens, which is the
  same context-lean discipline the cost guards enforce. New `extensions/serena/` (manage via
  `make serena-install` / `make serena-doctor` / `make menu`); `/leopold-run` prefers Serena's
  tools. Setup uses the official path, not the MCP marketplace (which ships stale commands).

### Fixed
- **Live progress on long, silent installer steps** so they never look frozen: a spinner
  with elapsed seconds wraps the OpenViking download (~140 packages on first install), the
  server health-wait, the embedding reindex (up to ~10 min), and the verify/extract
  (up to ~2 min) — on failure the captured output is shown. git clones (Leopold + gstack)
  now run with `--progress`. (Reported: a fresh Bedrock install looked stuck at
  "ensuring OpenViking + boto3".)

## [0.4.1] - 2026-06-19

### Added
- **ovmem provider switching** — re-running the ovmem installer detects the current setup,
  offers to reuse the existing credential, and safely **rebuilds the vector index when the
  embedding model changes** (OpenAI ⇄ Bedrock): memory content is preserved, the old index
  is backed up and restored if the rebuild fails. Server restarts are data-dir-lock-aware.
  CI now syntax-checks `extensions/*/*.sh`.

### Fixed
- README guard count corrected to **59** red-team cases (was a stale 49); ovmem `manage.sh`
  header no longer describes `install`/`update` as stubs (they run the full installer).

## [0.4.0] - 2026-06-19

### Added
- **`examples/`** — a reproducible run (`add-json-output`): the full brief plus the
  `DECISIONS.md` an autonomous run produced from it. Proves the loop and teaches the format.
- **Demo cast** (`assets/demo.cast` + `assets/demo.svg`) at the top of the README, with
  `scripts/record-demo.sh` to regenerate it.
- **Loop detection** (`max_no_progress`, default 6): if the open `PLAN.md` set is unchanged
  for N turns, the run stops with `no_progress` instead of thrashing. Tested in `make hooks-test`.

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
