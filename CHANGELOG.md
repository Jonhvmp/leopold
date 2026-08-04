# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.0] - 2026-08-03

### Added
- **Leopold runs on Codex CLI, not just Claude Code.** The whole point of the brief was
  always that it is harness-neutral markdown, and it turns out the hooks are too: Codex
  reimplemented Claude Code's hook contract nearly field for field. `PreToolUse` arrives
  with the same keys (its shell tool is reported as `Bash`, with `tool_input.command`,
  `cwd`, `transcript_path`) and honors the same
  `{"hookSpecificOutput":{"permissionDecision":"deny",…}}` reply; `Stop` arrives with
  `cwd`, `transcript_path` and `stop_hook_active` and honors
  `{"decision":"block","reason":…}`. So **both Leopold hooks — the git lock and the
  autonomous continuity engine — run on Codex as the same unmodified scripts**. Verified
  end to end against Codex CLI 0.146.0: the guard blocked a `git commit` (no commit was
  created, `guard_block` logged), and a two-item plan ran to `plan_complete` driven by
  `stop-continuity.sh`, with iteration, progress signature and the context budget all
  tracked off Codex's own transcript.
- **`install.sh --harness auto|claude|codex|all`.** The installer detects what you have and
  wires each one: skills into that harness's skills dir, hooks into `settings.json` (JSON)
  or `config.toml` (TOML). The Codex block is marker-delimited so a re-install replaces it
  and nothing else, the config is backed up first, and the merged file is validated — a
  result that would not parse is rolled back and printed for you to paste instead.
  Harness-neutral assets live in one shared home (`~/.claude/leopold` when Claude Code is
  present, so existing installs need no migration; `LEOPOLD_HOME` overrides).
- **`leopold harness`** — what each harness on this machine can do, and which one a run
  would be conducted on. `leopold doctor` now checks every harness present, including
  whether the Codex hooks have been trusted.
- **`leopold run --provider claude|codex`** (also `LEOPOLD_PROVIDER`). The driver's single
  model seam (`sdk.ts`) now selects a backend: the Agent SDK, or `codex exec --json` with
  `codex exec resume` for multi-turn items. Same message contract, so no call site changed.
  Headless Codex workers arm their own git lock, because Codex keeps a config-declared hook
  inert until it has been trusted once and a headless run has nobody to approve it.
- **`.codex-plugin/plugin.json`** — Leopold installs as a Codex plugin too, which arms both
  hooks without the separate trust step.
- **The serena extension installs on every harness you have.** `extensions/serena/manage.sh`
  now registers the MCP server and wires Serena's four hooks once per harness: `claude mcp
  add --scope user` + `~/.claude/settings.json` for Claude Code, `codex mcp add` +
  `~/.codex/config.toml` for Codex CLI, with `--context=codex` (a built-in Serena context)
  and `serena-hooks --client=codex`. `install`, `status`, `remove` and `doctor` all report
  **per harness** — a two-harness box never sees one harness's state passed off as both, and
  doctor names Codex's hook-trust gate instead of showing a green that isn't live yet. Both
  config formats are written by the one shared helper (`extensions/lib/harness.sh`), which
  gains the matching `leo_unwire_hooks_json` / `leo_unwire_hooks_toml` and the `leo_mcp_*`
  wrappers so no extension hand-rolls a second copy. `install.sh` now exports its resolved
  `--harness` choice, so `--harness codex` on a machine that merely *has* a `~/.claude` no
  longer wires an extension into Claude Code. Covered by `make serena-test` (hermetic: temp
  `HOME`/`CLAUDE_HOME`/`CODEX_HOME`, stubbed CLIs, no network, no package install).

- **The ovmem extension runs on every harness you have.** Its four hooks
  (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `SessionEnd`) are declared once per
  harness through the same shared writer as everything else — `~/.claude/settings.json` in
  JSON, `~/.codex/config.toml` in TOML — and the engine, its per-session commit offsets and
  the access log live in ONE directory for the machine, so a decision recorded in a Codex
  session comes back in a Claude Code one. Three Codex specifics, each measured against
  codex-cli 0.146.0 rather than assumed, are handled instead of papered over: its hook
  stdout is validated as strict JSON, so the recall block is wrapped in
  `hookSpecificOutput.additionalContext` there (the plain-text form Claude Code needs logs
  `hook: SessionStart Failed` and never reaches the model); its transcript is a **rollout**
  (`session_meta` / `event_msg` / `response_item`), so the flush reads the conversation from
  `event_msg` payloads of type `user_message` / `agent_message` and skips the replayed
  developer preamble; and it **hard-caps a `SessionEnd` hook at 3 seconds**, so that hook is
  declared as 3 and hands the flush to a detached child, which is the difference between a
  session being distilled into memory and being cut in half. Claude Code's path — plain-text
  injection, in-process 25s flush, `~/.claude/ovmem` — is byte-for-byte unchanged. `status`,
  `doctor` and `remove` all report and act **per harness**, and `leopold doctor` gained an
  ovmem line that names any harness still missing its wiring. Covered by `make ovmem-test`
  (hermetic: temp homes, a stdlib stub for the OpenViking API, no network, no server).

- **The gstack extension installs into every harness you have.**
  `extensions/gstack/manage.sh` used to clone into `~/.claude/skills/gstack` and look
  nowhere else, so a Codex-only machine got a Claude directory it would never read. It now
  drives gstack's own installer once per harness Leopold resolves (`./setup --host claude`,
  `./setup --host codex`) and `detect`, `status`, `remove` and `doctor` all report **per
  harness**, counting the skills actually visible in each skills root — never one harness's
  state passed off as the machine's. On a Codex-only box the checkout goes to
  `~/.gstack/repos/gstack` (gstack's own out-of-skills home — it refuses a checkout inside
  the Codex skills dir, to avoid duplicate skill discovery) and the skills land under
  `~/.codex/skills`, with nothing under `~/.claude`. gstack builds both skills roots from
  `$HOME`, so when `CLAUDE_HOME`/`CODEX_HOME` are overridden the extension mirrors what
  setup produced into the resolved root and says so, instead of silently installing where
  nobody is looking. The skills-root path itself comes from one shared helper
  (`leo_skills_dir` in `extensions/lib/harness.sh`). `install.sh --with-gstack` and `make
  gstack-install` now go through the extension rather than hand-rolling a second clone, and
  `leopold doctor` names any harness still missing it. Covered by `make gstack-test`
  (hermetic: temp `HOME`/`CLAUDE_HOME`/`CODEX_HOME`, a stubbed `git`, no network, no Bun),
  including three installs leaving exactly one checkout and one set of skills.

- **`leopold home`, and no skill hardcodes a harness path any more.** The
  harness-neutral half of the install (hooks, templates, docs, scripts, extensions)
  lives in an **asset home**, and every consumer now resolves it at run time with the
  same precedence — `LEOPOLD_HOME`, then `$CLAUDE_HOME/leopold`, then
  `$CODEX_HOME/leopold`, then where `install.sh --harness auto` would put it. The new
  `leopold home` prints that one path (pure resolution, never fails, safe to call from
  a hook), and skills use it with a POSIX-sh fallback for shells with no `leopold` on
  `PATH`. Every `SKILL.md` also names the tool on both harnesses instead of only
  Claude's, so the sentence is actionable from either seat. `make skills-test` fails
  the build if a skill hardcodes `~/.claude`, and
  `packages/driver/test/provider.test.ts` extracts the documented fallback snippet
  from `docs/reference/leopold-home.md` and asserts it agrees with the driver's
  `leopoldHome()` under every environment — so the doc cannot drift from the code.

- **`leopold watch` reads a Codex run: real tokens, real cost, real context.** The
  dashboard used to parse only Claude Code transcripts, so a Codex run showed a blank
  panel. It now finds the newest Codex rollout whose `session_meta.cwd` is this project
  (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), sniffs which harness wrote the
  transcript, and reads usage from `event_msg` lines with `payload.type ==
  "token_count"` (`info.total_token_usage`, cached and reasoning tokens included).
  Codex reports tokens and never dollars, so cost comes from a built-in per-model
  table with cached input at 0.1x; an unrecognized model falls back to a **non-zero**
  default, and a live session that has not reported usage yet says "waiting for
  session data…" instead of quoting `$0.00` — a run priced at zero would silently
  disable `--budget-usd`. Covered by `make watch-test`.

- **Extension dashboard tabs resolve their payload instead of hardcoding it.** An
  `extension.json` `dashboard.module` may now be a path relative to the harness data home
  (`ovmem/dashboard.py`), which `leopold watch` resolves Claude-first exactly like the
  installers do; absolute and `~`-rooted values still work. Without it the Memory tab
  silently vanished on a machine with no `~/.claude`.

- **`make codex-install-test` — the whole Codex install, end to end, hermetically.** The
  other suites test the pieces; `scripts/test-codex-install.sh` tests the product a
  Codex-only user actually gets: it runs the real `./install.sh --harness codex` on a
  simulated machine with no `~/.claude` and neither `claude` nor `codex` on `PATH`, then
  asserts every skill installed, both hooks wired **and executed from the installed copy**
  with the payloads codex-cli 0.146.0 sends (the git lock denies `commit`/`push` and passes
  `git add`; the continuity hook blocks the stop while the plan has work and lets it go
  when it doesn't), all four extensions present and reporting per harness with no Claude
  path anywhere, three installs leaving one of everything and a byte-identical
  `config.toml`, a corrupted target config refused rather than clobbered, a write that
  lands broken restored from its backup, and `LEOPOLD_HOME` moving the asset home with the
  wiring following it. Hermetic and it proves it: every command runs under `env -i` with a
  rebuilt `PATH` of stubs and temp `HOME`/`CLAUDE_HOME`/`CODEX_HOME`, no network and no
  package install, and the last section re-checks the developer's real homes — entry names
  plus the mtime and size of the real `~/.codex/config.toml`, the one file this installer
  edits — so an escaped write fails the suite instead of going unnoticed. Wired into `make
  test` and into the `hooks` CI job.

### Fixed
- **`install.sh --harness codex` installed half a product.** The Codex path printed its
  next steps and exited right after the skills and the two hooks, silently skipping the
  prompt enhancer, Serena, the `leopold` CLI and the whole verification pass — everything
  a Claude Code install gets. It now runs the same tail as every other harness; only the
  `settings.json` merge is Claude-specific, and the verification reports per harness. A
  Claude-only install is byte-for-byte what it was.
- **`config.toml` grew on every re-install.** Lifting a managed block out of the middle
  of the file left its leading blank line behind while the fresh copy brought a new one,
  so each run added an empty line, forever. The removal now takes the block's own
  separator with it; blank lines anywhere else, including inside multi-line TOML strings,
  are preserved exactly. Three installs now leave a byte-identical file.
- **A finished item never reported its cost, so `--budget-usd` never accumulated.** The
  worker loop closed the input channel and broke out the moment the conductor ended an
  item — before consuming the `result` message, the only one carrying `total_cost_usd`.
  Any worker that finished cleanly on its first turn reported nothing, and the budget sat
  at zero for the whole run. Found by the first live `leopold run --provider codex`
  (`spent_usd: 0`, no `cost` event) and confirmed pre-existing on Claude Code by checking
  an archived run's event log — it bit both harnesses. The loop now drains to `result`
  before ending, and a live Codex run records `spent_usd: 0.0626` with its `cost` event.
- **A dead implement agent closed its plan item as done.** `/leopold-workflow`'s script
  handed the item straight to review without checking the implement agent's return value.
  When that agent dies (a terminal API error after retries, or a skip) it returns `null`,
  leaving an empty diff — which reviews clean, so the item closed as DONE on work that
  never happened. It now charges the round and retries, and reports the item incomplete
  if the budget runs out. Found when a real run lost two implementers to a dropped
  connection and still reported 13/13 done.
- **A stringified `args` payload made a workflow report a clean zero-item run.** The
  script read `args.waves` off a JSON string, got nothing, and returned
  `{total: 0, done: 0}` having spawned no agents — indistinguishable from a finished
  plan. It now parses a string payload, and an empty plan throws instead of reporting
  success.

### Changed
- **Docs and metadata describe the universal install.** `docs/concepts/harnesses.md`
  (and its pt-BR twin) gained the per-harness extension matrix and the dashboard
  section; `docs/getting-started/install.md`, `docs/reference/hooks.md` and the README
  no longer read as Claude-only — harness selection, the TOML wiring, the Codex
  hook-trust step and the shared asset home are all documented, in both languages.

### Notes
- Codex reports token usage, never a dollar figure, so `--budget-usd` prices a Codex run
  from a built-in per-model table. An unrecognized model falls back to a default rate rather
  than zero: pricing a run at zero would silently disable the budget.

## [0.13.0] - 2026-07-10

### Added
- **Leopold Canvas — a live, zero-dependency DAG of the run.** `leopold-watch` gains a
  **Canvas** tab (loopback, `http://127.0.0.1:4179`) that reads `.leopold/` and every
  dynamic-workflow record and lays them out as a directed graph with a hand-rolled
  layered layout — no framework, no bundler, no web fonts, fully offline. Plan items are
  nodes with `(after: N)` edges; workflow phases/agents render as `seq`/`contains`/`verifies`
  edges (precise where scripts label agents `impl:<id>` / `verify:<id>:<lens>`); forks,
  reviews, and root-cause hypotheses hang off the item that spawned them; tasks are
  first-class nodes. Pan/zoom/drag with persisted positions and Fit; a node inspector shows
  model, tokens, per-node cost, tool calls, prompt/result previews, and a plan item's
  `DECISIONS.md` rationale.
- **Steer a live run from the Canvas — git stays locked.** A command channel (`commands.ts`)
  lets the dashboard nudge a running `/leopold-run` between turns: `approve`, `redirect`,
  `inject`, `kill-item`, `rerun-item`, drained at the same turn boundary as `STOP`, logged to
  `DECISIONS.md` + `events.jsonl`. A **security invariant** (red-team proven) holds: a command
  can only steer the plan — it can never write `ALLOW_GIT`/`ALLOW_PUSH`, touch `STOP`, or shell
  out; unknown/hostile commands are dropped. A non-preemptible workflow node's steer becomes an
  honest directive for the next resume.
- **Behavior-spec verification (`conformance`, on).** A plan item can carry `@scenario
  given → when → then` acceptance lines under its checkbox; `plan.ts` parses them into
  `PlanItem.scenarios` (backward compatible — an item with none is byte-for-byte unchanged).
  A new **conformance** review lens verifies the uncommitted diff satisfies EVERY scenario
  before the item closes, and an unmet scenario comes back to the worker as the concrete fix.
  Active only when the item declares scenarios. `leopold-brief` and `templates/PLAN.md` teach
  the grammar.
- **Best-of-k tournaments (`best_of_k`, off by default).** With `--best-of-k N`, a
  critical/max-effort item in a worktree-isolated run is settled by N independent attempts —
  each in its own throwaway worktree off HEAD, seeded with the current state — judged by a
  panel, winner's diff applied. Bounded 2..6; falls back to a single attempt when nothing wins.
- **Slice-scoped context (`slice_scope`, off).** When smart routing researches an item's
  files, that set is handed to the worker as an explicit "start with these files" scope note
  instead of the whole repo. Needs `smart_routing`.
- **A single SDK seam (`src/sdk.ts`).** Every model call in the driver now goes through one
  point. Production is unchanged — the real Agent SDK on the user's OWN Claude Code auth (their
  subscription; no external API key, no separate billing). Tests inject a deterministic fake via
  `setQuery`, so the whole conductor ↔ worker ↔ review ↔ retry loop runs end-to-end with **zero
  model calls and zero spend** — which is how the new integration tests exercise the four levers
  above for real.

### Changed
- **Literal fresh restart on a failed retry (`literal_reset`, on).** On a retry in a
  worktree-isolated run, the tree is restored to a snapshot taken before the item's first
  attempt — the failed diff is discarded, prior items' staged work kept — so the fresh attempt
  starts clean instead of building on a dead end. A live repo is never hard-reset: the
  non-isolated path falls back to reframing the retry. `git.ts` gains fail-safe
  `snapshotTree`/`restoreTree` (a corrupt patch never loses work).
- **Worker doctrine, from first principles.** The autonomous worker is now told to: frame the
  item as observable acceptance behavior first; test behavior not implementation and never mock
  the unit under test (reward-hacked tests are flagged blocking by the review gate); prefer
  widely-used libraries and web-research current APIs (its knowledge is frozen); and simplify
  before closing (fewer lines, abstract only on real duplication).
- **161 driver tests** (up from 113), including real-git integration for the tournament
  orchestration and full-loop integration for conformance + literal reset. A latent bug was
  fixed along the way: the tournament captured the winner's diff with `git diff HEAD`, which
  drops untracked new files — now captured via `snapshotTree`.

## [0.12.0] - 2026-07-06

### Changed
- **enhance: `/skill` briefs are gated on the ARGUMENT instead of being swallowed as
  commands.** `"/leopold-brief add microinteractions, tasteful, nothing aggressive"`
  now scores the brief itself — the command prefix is stripped so it never counts as
  an anchor, and a weak brief gets the Haiku interpretation. Built-ins with short args
  (`/model opus`), `!`/`#` prompts, and the enhancer's own control verbs
  (`status`/`on`/`off`/`preview`/`learn`) stay skipped. The ledger gains `skill_brief`
  so the learn loop can tell the two apart; `preview` announces when it gates an
  argument; the `/leopold-enhance` skill now treats a non-verb argument as a task
  brief instead of undefined control-plane input. 7 new asserts in the hermetic
  suite (50 total).

## [0.11.0] - 2026-07-06

### Added
- **`enhance` — a global prompt enhancer, wired for everyone and OFF by default.** One
  `UserPromptSubmit` hook scores every prompt; genuinely weak ones ("fix login") get a
  structured interpretation (Objective / Context / Constraints / Done when / Assumptions)
  from Haiku **on your own connected account**, injected next to the raw prompt — which
  always wins on conflict and is never modified. Charter-aware (reads `.leopold/CHARTER.md`
  when the project has a brief), conversation-aware (transcript tail, so "do the same for
  logout" resolves), and fail-open everywhere: any failure means the prompt passes through
  untouched. An anchor (path / `symbol` / identifier) vetoes enhancement — strong prompts
  never pay the latency. Control: `leopold menu` → enhance (new `t) Toggle` action, plus a
  full-destroy entry in the uninstall screen) or the new `/leopold-enhance` skill
  (`status` / `on` / `off` / `preview` / `learn`).
- **`/leopold-enhance learn` — the self-improving prompt profile.** Every enhancement is
  ledgered locally; the learn loop (same trust structure as `/leopold-learn`: disjoint
  miners → cluster → kill-biased skeptic per candidate → proposal-only distill) joins the
  ledger to your session transcripts, finds enhanced prompts you corrected right after and
  statistical gate misfires, and proposes rules into `~/.claude/enhance/PROFILE-amendments.md`.
  It never edits `PROMPT-PROFILE.md` itself — you review and apply.
- **`leopold enhance` CLI verb** (routes to the extension manager) and an enhance check in
  `leopold doctor` / `scripts/leopold-doctor.sh`.
- **`make enhance-test` + CI step**: hermetic behavior suite for the hook (stubbed `claude`,
  no network) covering the recursion guard, every gate skip, the false-positive regression,
  cooldown, fail-open error paths, charter injection, and the toggle/preview control plane.

### Fixed
- **The installer now upgrades an existing CLI instead of leaving it stale.** Re-running
  `install.sh` (or the one-line `curl` installer) used to print "leopold CLI already
  installed" and stop, so anyone with an older `leopold` on PATH kept the old binary —
  including the one without `leopold --version`. It now always runs
  `npm i -g leopold-driver@latest` and reports the resulting version (and the
  before→after when it changed).

## [0.10.1] - 2026-07-03

### Fixed
- **`leopold --version` now works.** It printed "Missing MISSION.md" — the dispatcher
  sent any leading-dash argument straight to conducting a run, so version/help-style
  flags tried to start one. Added `version` / `--version` / `-v` (printing the driver's
  own package.json version), handled before the fall-through so they can't leak into a
  run; bare invocation and `run`-with-flags still conduct as before. Covered by the CLI
  smoke test.

### Added
- **Hardcore CI.** (1) A **CLI smoke test** (`scripts/test-cli-smoke.sh`, also
  `make driver-smoke`) exercises the *built* binary end to end against a fixture brief —
  help, unknown-command exit code, `run --dry-run`, `workflow --print` (waves +
  classification + guardrails verified), the emit path (files written, script parses,
  args valid JSON), and `insights` — closing the gap where unit tests covered modules
  but nothing executed the dist entry. Wired into `make test` and CI. (2) **Shellcheck**
  (warning level) now gates every shell entrypoint — the two `ls | grep` findings it
  surfaced in `install.sh` and the gstack extension were fixed with proper globs.
  (3) The driver job runs on a **macOS + Ubuntu matrix**. (4) npm publish now ships
  **`--provenance`** (supply-chain attestation). (5) **Dependabot** keeps npm, pip, and
  Actions pins fresh weekly. (6) A **CodeQL node** scans JS/TS, Python, and the Actions
  themselves inside the single reactive `ci` pipeline — one workflow, parallel
  validation nodes (hooks / driver-matrix / docs / codeql), and delivery
  (docs-deploy / release) that only fires on main after every node is green.
  Autonomous scheduled work is deliberately separate: `security-sweep.yml` runs the
  weekly CodeQL sweep (plus on-demand via workflow_dispatch).
- **A new demo that shows the workflow engine.** `scripts/record-demo.sh` now
  *synthesizes* the asciinema cast deterministically (v2 is just JSONL — no recorder
  needed, byte-stable reruns) and renders it with agg / svg-term / `npx svg-term-cli`.
  The walkthrough covers the current story: the brief, `leopold workflow` compiling it
  into waves, the adversarial verify panel catching a blocking finding on a critical
  item, the root-cause panel, and learn-on-finish proposing charter amendments. Still
  honest by design — a scripted walkthrough, never a faked model session.
- **Docs polish.** Cost & Security and Run Isolation joined the mkdocs nav (they were
  orphaned); the Quickstart points large plans at `/leopold-workflow`; the README
  quickstart block lists `leopold workflow`.
- **`leopold-driver workflow` — the brief→workflow compiler as tested code.** The
  compilation the `/leopold-workflow` skill described in prose is now deterministic TS
  (`compile.ts`): parse `PLAN.md` into dependency waves, risk-classify each item, and emit
  the exact `args` the canonical workflow script consumes. `leopold-driver workflow` writes
  `.claude/workflows/leopold-run.js` + `.leopold/workflow-args.json` (reproducible,
  CI-checkable); `--print` dumps the compiled args; `--run` executes headlessly through an
  **experimental** in-driver runtime (`runtime.ts`) that implements the workflow globals —
  `agent`/`pipeline`/`parallel`/`phase`/`log`/`budget` — with a real concurrency cap and an
  injected, query-backed agent (git stays locked via the worker guard). The orchestration
  engine is unit-tested (concurrency cap, budget stop, error-to-null); the query-backed
  agent is a thin shim, not exercised end-to-end (alpha, like the rest of the SDK driver).
  New docs: a Dynamic Workflows concept page. Driver suite: 103 → 113 tests.
- **Dynamic-workflow phase tree in `leopold-watch`.** The dashboard now discovers the
  native dynamic-workflow runs for the project (`~/.claude/projects/<slug>/<session>/
  workflows/wf_*.json`) and renders a live phase tree: each run with its status, agent
  count, token and tool totals, and duration; each phase with its done/running counts
  and token sum; each agent with a status dot (running pulses), label, tokens, tool
  calls, and its last tool summary. Read-only, cached by mtime, best-effort (a missing
  or malformed run is skipped), and the card hides itself when there are no workflow
  runs — so a plain `/leopold-run` dashboard is unchanged.
- **Learn-on-finish closes the loop.** The SDK driver can now mine a run the moment it
  finishes cleanly and propose charter amendments — `learnFromRun` reads the just-written
  `DECISIONS.md` (plus archived runs) and the repo's git history, runs two miners, a
  cluster pass, and one kill-biased skeptic per candidate, then writes
  `.leopold/CHARTER-amendments.md`. It never edits `CHARTER.md`. Opt-in via
  `--learn-on-finish` / `LEOPOLD_LEARN_ON_FINISH=1` / `learn_on_finish: on` in GUARDRAILS.
  The completion notice and `leopold insights` report the proposed count; the dashboard
  renders the `learn` event.
- **GUARDRAILS.md drives the orchestration toggles.** `review`, `hypotheses`,
  `smart_routing`, and `learn_on_finish` can be set in the brief's GUARDRAILS.md
  (`key: on|off`), so the posture lives with the brief. Precedence is explicit CLI flag /
  env var > GUARDRAILS > built-in default (`boolFrom` + `resolveBool`, unit-tested).

## [0.10.0] - 2026-07-03

### Added
- **Mock-runtime test harness for the workflow scripts.** The four reference
  `*.workflow.js` scripts (leopold-run, leopold-learn, leopold-triage,
  plan-tournament) are now executed against deterministic `agent`/`pipeline`/
  `parallel` stubs that record every call, so their real control flow is asserted —
  dependency-wave order and lens escalation (leopold-run), disjoint-source miner
  fan-out and the kill-biased skeptic (leopold-learn), the quarantine boundary
  (leopold-triage: an injection marker reaches the classifier but never the
  repo-capable fix planner), and tournament scoring/synthesis. A static validator
  additionally asserts every script has a pure-literal `meta` and no filesystem/shell/
  module access. Driver suite: 63 → 93 tests.
- **Diverse-lens review panel (driver).** The per-item review gate is now a panel of
  independent skeptics with distinct lenses instead of 1–2 identical reviewers:
  correctness always; +security on sensitive diffs; +does-it-actually-work on critical
  items. Blocking findings are unioned (deduped, `unionReviews`) and handed back to the
  worker; unparseable verdicts still fail closed. `lensesFor` is pure and unit-tested.
- **Root-cause hypothesis panel (driver).** When a plan item is retried after a failure,
  three investigators form independent hypotheses over *disjoint* evidence (the diff /
  the verification output / the item's assumptions vs the codebase), a refuter tries to
  kill each one (fail-closed parsing, confidence 0–10), and the strongest survivor is
  injected into the next worker attempt as a concrete lead instead of "try again". Wired
  into both the serial loop and the parallel scheduler; logged as `hypothesis` events.
  On by default; `--no-hypotheses` / `LEOPOLD_HYPOTHESES=0` turns it off.
- **Smart routing (driver, opt-in).** `--smart-routing` / `LEOPOLD_SMART_ROUTING=1`
  replaces keyword classification with a short read-only session that researches the
  item's real blast radius (callers, touched modules) before setting effort/criticality.
  Any failure falls back to the deterministic classifier, and the router can never lower
  a keyword-critical item below critical (safety floor).
- **`/leopold-learn` — the self-improving charter.** A workflow that mines the decision
  log (`DECISIONS.md` + archived runs), this project's session transcripts, and git
  history with three miners over disjoint sources, clusters the recurring signals
  (cross-source repeats are the strongest), puts one kill-biased skeptic on every
  candidate, and distills the survivors into `.leopold/CHARTER-amendments.md`. It never
  edits `CHARTER.md` itself — the human reviews and applies.
- **`/leopold-triage` — backlog triage with quarantine.** Classifies a queue (GitHub
  issues via `gh`, files, pasted content) with quarantined readers — agents that read
  untrusted item bodies have no repo access and only emit structured fields; the agents
  that touch the repo (fix planners, `mode: 'fix'`) see only those fields. Dedupes
  against tracked work, ranks by severity, drafts grounded fix plans for quick wins.
  Pairs with `/loop` for continuous triage.
- **Plan by tournament (`/leopold-brief`).** For substantial missions, the brief can now
  draft `PLAN.md` by tournament: three drafters plan from deliberate stances (MVP-first,
  risk-first, user-journey-first) grounded in the real repo, two judges score all drafts
  comparatively, and a synthesizer builds the final plan from the winner grafted with the
  runners-up's best ideas (`reference/plan-tournament.workflow.js`).
- **Dashboard: the new events render.** `leopold-watch` now shows `review` (clean/blocking
  + panel composition), `hypothesis` (surviving theory + confidence), `item_start/done/
  incomplete`, `merge_conflict`, and `cost` with real detail lines and severities.

### Changed
- **`leopold insights` tracks the panel, not the old second-opinion flag.** The review
  summary now counts multi-lens panels (`lenses>=2`, with the archived `second_opinion`
  flag still honored) and adds a root-cause panel line (runs / leads produced).
- **`/leopold-workflow` — the brief, compiled into a dynamic workflow.** A new Phase-2
  engine that turns the durable brief into a [dynamic workflow](https://code.claude.com/docs/en/workflows):
  a JavaScript harness Claude Code's runtime executes in the background. `PLAN.md` is
  parsed into dependency-ordered waves (from the existing `(after: N)` markers), each item
  is risk-classified with the same keyword rules the driver uses (effort + `critical` +
  `sensitive`), and the compiled `args` drive a canonical, versioned workflow script
  (`skills/leopold-workflow/reference/leopold-run.workflow.js`). Every item runs
  implement → **independent adversarial verify** (a diverse-lens panel — correctness /
  security / does-it-actually-work — on critical items) → fix, looping up to
  `max_review_rounds`. Because the plan lives in code and each agent gets a clean context,
  a long run doesn't drift into agentic laziness, self-preferential bias, or goal drift.
  The run is resumable, streams a live phase tree into `/workflows`, and **git stays locked
  for free** — a workflow can't commit; it stages, the human commits. Saving the compiled
  script to `.claude/workflows/leopold-run.js` makes the brief a re-runnable, readable,
  diffable harness. `/leopold-run` stays the engine for short or interactive plans;
  `/leopold-workflow` is for large or parallelizable ones. Both read the same `.leopold/`
  brief.

## [0.9.0] - 2026-06-27

### Added
- **Review gate per item.** Before an item can close, an independent reviewer (its own
  Claude Code session, so it can invoke `/code-review` and `/security-review`) passes over
  the item's uncommitted diff. Blocking findings are handed back to the worker to fix, up to
  `--max-review-rounds` (2); sensitive diffs (auth/billing/secrets/.env) get security rigor;
  unparseable verdicts fail closed. On by default (`--no-review` / `LEOPOLD_REVIEW=0` off).
- **Per-item reasoning effort + advisor analog.** A deterministic keyword pass over the item
  and charter sets the worker's native SDK `effort` — `low` for cosmetic work, `high`/`max`
  for money/identity/data-integrity/migrations. Critical items also get a second independent
  reviewer (the advisor analog; the SDK has no advisor).
- **Parallel scheduler (`--parallel N`).** Independent plan items run concurrently, each in
  its own worktree; each finished item's diff is replayed onto the main tree as a staged
  patch (serialized, never committed). Declare order in `PLAN.md` with `- [ ] (after: 2) …`;
  conflicting patches preserve the worktree for manual merge. Default stays serial.
- **`leopold up`** — one-command setup: installs the harness and seeds a per-project
  permissions allowlist; pairs with the new **`/leopold-up`** skill (Phase 0) that runs
  `/init`, `/run-skill-generator`, and MCP/effort checks, then hands off to `/leopold-brief`.
- **`leopold insights`** — summarize a run from `events.jsonl`: items done/incomplete/
  conflicted, effort mix, review pass-rate, decisions, escalations, guard blocks, spend
  (`--json` for machine output).

### Changed
- `/leopold-brief` now writes parallel-ready plans (documents the `(after: N)` dependency
  marker) and points fresh projects at `/leopold-up`. `/leopold-run` documents the review
  gate and tells the worker to self-`/code-review` and `/verify` against the app run-skill.

## [0.8.0] - 2026-06-27

### Changed
- **Guard scope narrowed to git commit/push only.** The autonomous guard (both the
  in-session `PreToolUse` hook and the driver's `canUseTool` gate) now locks exactly two
  actions: `git commit` (token `ALLOW_GIT`) and `git push` (token `ALLOW_PUSH`); force-push
  is always denied. Everything else the run used to block — `rm -rf`, `find -delete`,
  `git reset --hard`, `git clean -f`, `git branch -D`, `gh pr create/merge`, package
  publish, secret-file reads, and edits to guardrails/settings/hooks/state — is now the
  run's own call. Isolate a run with `--worktree` for a filesystem boundary. The git match
  stays hardened against evasion (global options, abs paths, `env git`, whitespace/tabs)
  and red-teamed (`make test-guard`). **Rationale:** the broad denylist blocked work without
  improving the autonomy guarantee that actually matters — code never leaves the machine or
  lands in history without you — which is fully covered by the commit/push lock.
- **Conductor and worker biased hard toward finishing.** The conductor now defaults to
  "answer/keep going", treats `escalate` as a rare last resort (genuinely irreversible AND
  unsettleable forks only), and never tells the worker to stop and ask. The worker prompt
  pushes complete, verified work — no placeholders, no early stops — and reserves
  `needs-decision` for true blockers. Subagent/fork/context-size caps were removed from the
  guard; spawn freely, just keep prompts lean. Fixes runs that stalled, over-escalated, or
  left items half-done.

### Removed
- Guard enforcement of `max_subagents` / `max_forks` / `max_context_mb` and the
  `LEOPOLD_PARANOID` allowlist mode. Cost is bounded by the `--budget` USD hard-stop and
  `max_iterations` instead. The `ALLOW_PUBLISH` token is gone (publishing is no longer gated).

## [0.7.1] - 2026-06-22

### Fixed
- **`leopold watch` extension tabs: bar widget overflow.** In an extension dashboard tab
  (e.g. ovmem's `Memory`), long bar labels (memory URIs) overran their value and bled into
  the next column. The `.meter` row is now responsive — the label flexes and truncates with
  an ellipsis (full text on hover via `title`), the value never shrinks, and a gap separates
  them. Affects the rendered `bars` widget only; the run's own budgets render identically.

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
