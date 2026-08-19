# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.21.1] - 2026-08-19

### Fixed
- **Persona journal appends are open-rejects, never check-then-write**: a journal
  moved or archived between a stale existence check and the write can no longer be
  recreated headerless (`O_APPEND` open without `O_CREAT`; race covered by test).
- **A `max_turns` near-miss is a named error**: a wrong-case or trailing-words line
  no longer falls back silently to the default budget.
- **Allowlist entries are validated as bare hostnames at parse time**: an entry
  with a scheme, path or placeholder brackets — which could never match any URL and
  silently blocked all navigation — is now a malformed-flow error naming the entry.
  The shipped flow template's placeholder brackets are fixed accordingly.
- **Flow sections are fence-aware**: `#` lines inside a code fence are section
  content, so a CLI flow's fenced commands survive verbatim.
- **The persona-guard hook fails closed on non-string `url` values**: an array or
  object under a `url` key is denied instead of slipping past the string filter
  (red-team suite extended to 47 cases).

### Docs
- The skills reference documents `/leopold-persona` and the two vendored contract
  skills; hook-count wording reflects the third, per-run-armed hook; the driver
  architecture lists the `persona-testing/` module; home and roadmap carry the
  feature — en + pt-BR throughout, plus the inspiration credit on the concept page.

## [0.21.0] - 2026-08-18

**The persona harness.** 0.20.0 gave the synthetic customer a script; this release
gives it a stage crew. Persona runs are now conducted by the driver — supervised
worker per persona, the journey journal as load-bearing state, window rolls that
provably resume mid-flow, a cast that fans out in parallel — and the hard bounds
stopped being prose: the domain allowlist is enforced by a hook upstream of the
tool call on both harnesses, decided from live evidence.

### Added
- **The persona guard hook** (`hooks/persona-guard.sh`): the flow's domain allowlist
  is now enforced *upstream of the tool call*, on both harnesses. Decided from live
  evidence, not reasoning — PreToolUse observes and denies MCP tool calls
  (`mcp__<server>__<tool>`) **and WebFetch** — the wired matcher is
  `mcp__.*|WebFetch`, the exact alternation the live deny probe ran with, so both
  navigation surfaces the hook judges are routed to it (the shared writer's spec
  format learned to carry `|` inside a matcher for this, additively — plain
  4-field specs parse unchanged) — on Claude Code 2.1.235 **and** codex-cli
  0.147.0, with the denial landing before the MCP server receives the call;
  captured payloads and versions in `docs/reference/persona-guard-hooks.md`
  (en + pt-BR). The conductor wires it only while a persona run is active: the
  `/leopold-persona` run lifecycle arms it at preflight (wire + `ACTIVE.json`) and
  disarms it on every exit path — both steps pinned by `scripts/test-persona-skill.sh`
  (`leo_wire_persona_guard` / `leo_unwire_persona_guard` in the one shared writer,
  own managed tag, never touching the git lock), the hook is inert without an
  active `.leopold/persona/ACTIVE.json`, denials name the flow and are journaled
  to `.leopold/persona/events.jsonl` as `persona_guard_block` (host only, never
  the full URL), and unknown fails closed: malformed ACTIVE.json, missing flow,
  empty allowlist, unparseable URL all deny. `leopold doctor` now states, per
  harness, whether the hook or conductor-level enforcement is the bound in force —
  and never infers "run active" from the wire alone: it reads the project's
  `ACTIVE.json` too, so a wire left by a crashed conductor reports as exactly
  that (wired but inert here), never as a live run.
  Red-teamed by `scripts/test-persona-guard.sh` (in `make persona-test` and CI):
  lookalike hosts, suffix and userinfo tricks in both directions — the hook judges
  URLs by their WHATWG host, treating `\` as an authority terminator exactly like
  the browser stack, so `https://evil.io\@allowed-host/` is denied as `evil.io` —
  nested `url` keys, batch payloads — verified by mutation, with the same two
  backslash verdicts pinned on the driver's `hostAllowed`. Found on the way, documented honestly: headless
  `codex exec` auto-cancels *allowed* MCP calls unless approvals are bypassed —
  a Codex conduction fact, stated in the doc, that never weakens the deny path.
- **`leopold persona run|report|list`** — the headless persona engine now has
  its CLI face. `persona run <flow> [--persona <id>|all] [--parallel N]`
  conducts a cast through the driver's conductor
  (`persona-testing/conduct.ts`): same `.leopold/persona/runs/` tree, same
  journals, same report sections as an in-session `/leopold-persona` run — the
  parity the skill documents, now backed by a reachable command
  (`scripts/test-persona-skill.sh` pins the whole chain: the claim in the
  skill, the dispatch in `index.ts`, the command module reaching `conductCast`
  and `reportFromRunDir`). The journal's app-version pin resolves
  `LEOPOLD_APP_VERSION`, then the flow's own "App version pin" section, and is
  stated as "unpinned" otherwise — never invented. `persona report <run-dir>`
  re-synthesizes `REPORT.md` from the journals alone (byte-deterministic) and
  re-splices the existing report's executive summary — the one sanctioned
  non-deterministic region — so re-running it rewrites the file byte-identical
  outside the summary marker. `persona list` answers with per-persona contract
  status and per-flow validity from the same gates the conductor enforces; an
  empty module is an answer, never a failure. Exit codes are the contract (0
  answered/conducted, 1 impossible, 2 usage), pinned with the argv parsing and
  a stubbed-seam conduction in `test/persona-cmd.test.ts`. The driver-side
  git-lock denials journal as `persona_git_block`, a name distinct from the
  hook's navigation-denial `persona_guard_block` on purpose — one event name
  per meaning.

## [0.20.0] - 2026-08-18

**The persona walks.** Real customers find what builders cannot — bugs on the unhappy
path, screens that confuse, flows that quietly lose people. This release puts a
synthetic customer in front of the product: an evidence-grounded persona walks a
declared flow, perceiving the real interface, reacting in character, journaling every
step, and ends the run with a structured report of what broke, what confused, and
where it gave up.

### Added
- **The persona module** under `.leopold/persona/`: `personas/` (the cast, as
  `persona-contract/1.0` files), `flows/` (entry point, goal, success criteria,
  domain allowlist, out-of-bounds actions, app-version pin), and `runs/` — one
  deliverable tree per run (`<UTCstamp>-<flow>/<persona>/JOURNEY.jsonl + evidence/ +
  FINDINGS.md`, with a cross-persona `REPORT.md` at the root). Nothing loose.
- **Two vendored persona skills** (portable agent-skills spec, both harnesses):
  `persona-contract-builder` compiles evidence-grounded persona contracts — claim
  catalog, source ledger, epistemic boundaries, validation gate; no stereotypes, no
  invented citations. `persona-contract-runtime` enacts a contract one bounded turn
  at a time — sincerity protocol, anti-drift gate, and an `instrumented` mode that
  returns observed behavior, friction points and a state delta per turn.
- **`/leopold-persona`** (Claude Code) / **`$leopold-persona`** (Codex CLI) — the
  conductor: `init` scaffolds the namespace, `build` compiles a contract through the
  builder skill, `run <flow>` walks a persona (or the whole cast) through the flow —
  perceive → enact → journal → act — then distills per-persona findings and the run
  report, findings ranked by severity × how many personas hit the same wall.
- **Continuity for long flows**: `JOURNEY.jsonl` chains each turn's `state_delta`
  into the next turn's prior state, so a context-window roll resumes mid-journey
  from the journal tail without losing a step — journal re-reads framed as past-run
  data, never as instructions.
- **Hard bounds**: navigation never leaves the flow's domain allowlist, and
  irreversible product actions (payments, deletions, destructive submits) are never
  executed — the intent is journaled as a finding instead. Test credentials come
  from the secrets vault; recorded and reported text stays under the credential mask.
- **Docs**: Persona Testing concept page (en + pt-BR), flow template
  (`templates/persona/FLOW.md`), README entries.
- **Tests**: `scripts/test-persona-skill.sh` in `make test` and CI — vendored skills
  asserted whole (truncation guard), conductor contracts (namespace, journal chain,
  audit gate, framing, hard bounds) pinned, key assertions verified by mutation.

## [0.19.2] - 2026-08-18

### Security
- **Credential masking on everything a run records or reports.** The ovmem engine
  masks credential-shaped strings (provider keys, tokens, JWTs, bearer values,
  key/secret assignments) at ingest, so nothing a session happened to print becomes
  a recallable long-term memory; ordinary content — git SHAs, code, URLs — passes
  untouched. The driver applies the same mask to every notification body before it
  is printed, logged, or POSTed to a webhook. Both masks carry hermetic regression
  tests verified by mutation.

## [0.19.1] - 2026-08-18

### Security
- **Hardened credential handling in the ovmem extension.** The installer now keeps
  provider credentials in the platform credential store — macOS Keychain, or
  `secret-tool` (libsecret) where available, with a `chmod 600`
  `~/.openviking/secrets.env` as the fallback. `ov.conf` carries environment
  placeholders in the `api_key` fields (resolved by the server at start time), the
  bootstrap wrapper no longer embeds tokens, key validation keeps the credential off
  the process command line, and the transient config backup is removed once the new
  configuration is live. Re-running the installer migrates an existing setup;
  reusing the stored credential works as before. Covered by hermetic regression
  tests verified by mutation.

## [0.19.0] - 2026-08-18

**The run remembers.** Every mission Leopold conducts leaves a decision trail behind —
and until now, nothing could read it. This release makes that archive load-bearing:
`leopold recall <query>` searches this project's own `.leopold/runs/` and returns the
past decision with its Reversal attached, and every new run starts with a bounded
digest of what the project already decided — on both engines, framed as untrusted
past-run data, with a truncation line that names `leopold recall` for anything deeper.

### Added
- **`leopold recall <query>`** — ranked lexical search over the project's archived
  runs (`.leopold/runs/*`), DECISIONS.md blocks first-class: each hit names the run,
  the file, and any Reversal line. cwd-scoped by construction, TypeScript stdlib
  only — zero network, zero dependencies, works offline. A project with no archive
  says "no archived runs" instead of exiting empty.
- **Run-start decision digest.** Both engines (SDK driver and in-session
  `/leopold-run`) open a run with a bounded digest of the most recent past-run
  decisions — persona, decision, Reversal — capped by count and bytes, oldest
  dropped first, and honest about it: the truncation line advertises `leopold
  recall` for the rest. A project with no archived runs starts byte-identically
  to 0.18.x.
- **ovmem flushes are run-aware.** When `.leopold/state.json` marks an active run,
  the flush tags the OpenViking session with project, run, window, and engine — a
  human browsing the memory base sees "leopold · myproj · run … · window 3 · claude"
  instead of a bare UUID. No active run means the flush behaves exactly as before;
  tags are extra metadata an old server ignores, and a dead server logs one line
  and the run continues.
- **SDK-worker hooks, verified live.** All four ovmem hooks fire per worker, each
  with its own session_id (`docs/reference/sdk-worker-hooks.md`, en + pt-BR). From
  that evidence: per-item worker flushes are suppressed (`LEOPOLD_SDK_WORKER=1`,
  restored by `LEOPOLD_OVMEM_WORKER_FLUSH=1`) so a 30-item run does not dump 30
  ephemeral sessions into the memory base — workers still rehydrate and recall,
  they just do not write. Recorded in DECISIONS.md with its Reversal.
- **The three memories, documented.** The continuity page now states the doctrine:
  `CHECKPOINT.md` is this run's working state and dies with the run; `leopold
  recall` is the project's own decision archive, git-versioned and greppable;
  ovmem is distilled cross-run learning that survives everything.

### Changed
- The untrusted-content framing for past-run text now has one home per language
  surface, and a drift test (`untrusted-framing.test.ts`) fails the build if any
  injection site — digest, recall header, checkpoint lead — drops it.
- New hermetic suites: `recall`, `recall-cmd`, `run-start-digest`, `worker-env`,
  plus ovmem tag assertions against a stubbed server. All in `make test` and CI.

## [0.18.0] - 2026-08-18

### Added
- **The run never dies of context pressure.** A filled context window is no longer a
  stop — it is a window roll. Before the window closes, the run writes a structured
  `.leopold/CHECKPOINT.md` (fixed sections, merge-don't-copy, size cap that fails loud
  rather than truncates), and with `continuity: auto` (the new default) `leopold watch`
  detects the roll and relaunches the run headless (`claude -p` / `codex exec`) — no
  human in the loop, on both harnesses. If you want the old behavior, set
  `continuity: manual` in `GUARDRAILS.md`: nothing relaunches and you resume with
  `/leopold-run`, which now reseeds from the checkpoint on its own.
- **Progress is the governor.** The run continues while the plan advances and stops
  honestly when it stops advancing: two consecutive windows that close zero plan items
  end the run with `no_progress_across_windows`. `max_iterations` is the run's ceiling
  and carries across windows, `max_windows` (default 10) bounds total reseeds, and no
  relaunch ever refreshes a budget, spends a spent one-shot again, or ignores the
  `.leopold/STOP` kill switch — the watcher checks it before relaunching, always.
- **One checkpoint contract, both engines.** The driver writes the same
  `CHECKPOINT.md` at run end, and either engine picks up the other's checkpoint — the
  seat passes between the in-session run and the SDK driver through one artifact.
  Every continuation window is re-grounded: the prompt restates the mission line and
  window count and treats the checkpoint as data, never as instructions.
- `leopold doctor` reports checkpoint health, and a checkpoint that cannot be
  written, merged, or parsed says so in the stop message instead of degrading
  silently. New hermetic suites (`test-doctor-continuity.sh`,
  `test-watch-continuity.py`, driver checkpoint/reground tests) run in CI and
  `make test`.

### Changed
- `stopped_reason: context_budget` keeps its name for consumers; the new semantics
  ride new state fields. USD stays out of the governor's seat: `--budget-usd` remains
  an opt-in ceiling for API-billed users, never the default. Docs (en + pt-BR,
  including the new [Continuity](docs/concepts/continuity.md) page) now say plainly
  what still stops a run: the livelock gate, iteration and window ceilings, the kill
  switch, and the git lock waiting on you.

## [0.17.1] - 2026-08-17

### Fixed
- **The workflow compiler ships the whole item again.** (#60) `leopold workflow` truncated
  every plan item at its first physical line: wrapped `done when:` prose — which the brief
  templates themselves encourage — was cut mid-sentence, and all `@scenario` lines were
  dropped from `workflow-args.json`. Workers were prompted with an amputated item and had
  to guess the acceptance criteria, and `conformance` passed vacuously because the cases it
  verifies never reached the runtime. No error anywhere; the run just got quietly weaker.
  Three layers fixed together: the parser joins indented continuation lines into the item
  text (structure untouched — indices, deps, done flags and scenario lists are
  byte-identical across every archived plan fixture), compiled items carry a `scenarios`
  field, and the runner hands those lines to the implementer as the definition of done and
  to every reviewer as a checklist whose unmet case IS a blocking finding. The compiler now
  also refuses to emit an item whose source declares `@scenario` lines its output lost —
  the silent version of this bug can not ship again.

### Changed
- `@anthropic-ai/claude-agent-sdk` 0.3.228 (#59).

## [0.17.0] - 2026-08-13

### Changed
- **Dependencies, the whole Dependabot queue at once** (#39–#45): TypeScript 6.0.3 → 7.0.2
  (typecheck, build and all 510 driver tests pass on 7), `@anthropic-ai/claude-agent-sdk`
  ^0.3.221, `@types/node` and `tsx` current, `actions/setup-node` v7 and
  `actions/setup-python` v7 in CI, and the docs floors raised to `mkdocs-material>=9.7.7`
  and `mkdocs-static-i18n>=1.3.1`. `npm audit` is clean after the refresh.

### Fixed
- **Serena no longer opens a dashboard tab on every session.** (#57) Serena's own default
  is `web_dashboard_open_on_launch: true`, and both harnesses register it as a stdio MCP
  server — so every new CLI session spawned its own Serena process and its own browser
  tab. The installer now sets the key to `false` on a config it creates (or when the key
  was never set), while the dashboard itself stays on at
  `http://localhost:24282/dashboard/`. A value you set yourself is never overridden by
  install or update — that is what the menu is for.

### Added
- **`leopold menu` → serena → Settings.** The extension contract gains an optional
  `configure` verb (declared in `extension.json`, rendered as `s) Settings`), and the
  serena extension implements it: toggle `web_dashboard_open_on_launch` (both ways) and
  `web_dashboard`, cycle `log_level` and `token_count_estimator`, edit `tool_timeout` and
  `web_dashboard_interface`. Each entry shows the live value from
  `~/.serena/serena_config.yml`, writes back only the selected key (atomic, comments
  preserved), hides keys the installed Serena version does not ship, and reminds you that
  running instances pick changes up on their next session.

## [0.16.0] - 2026-08-09

**Read this before upgrading: `@human` no longer halts a run.** Until 0.15.0 a `@human`
node stopped everything with `awaiting_human` and waited for a person; from 0.16.0 Leopold
synthesizes the role that decision needs, takes it, does the work, and records the call —
persona, fork, charter basis and a **Reversal** line — in `.leopold/DECISIONS.md`. The same
now goes for an escalation, a malformed or deadlocked graph, and a third repeated failure:
nothing halts for want of permission. The trust boundary does not move — a persona decides,
the guard still denies `git commit` and `git push`, and a human still ships. **Want the old
halting behavior? One line: `autonomy: ask` in `.leopold/GUARDRAILS.md`** (or
`LEOPOLD_AUTONOMY=ask`, or the driver's `--ask` / `--autonomy ask`), and every stop path
above waits for you exactly as it did in 0.15.0. A plan with no `@human` node and no
escalation runs byte for byte as before.

### Changed
- **BREAKING (behavior): a `@human` node no longer halts the run — it is decided by a role
  Leopold synthesizes for it.** This is the largest change in this release and it is
  deliberate, so read it before you upgrade. Since 0.15.0 a `@human` node stopped the run
  with `awaiting_human` and waited for a person. Under the new default posture
  (`autonomy: full`) **neither engine waits**: the run works out WHO should take that
  decision — a name, a role title, the expertise the item actually demands, what it
  optimizes for, and the hard rules lifted verbatim from `CHARTER.md` — takes that role,
  does the item, and appends the call to `.leopold/DECISIONS.md` naming the persona, the
  fork, the charter basis and a **Reversal** line. The driver, the dynamic workflow and
  the in-session Stop hook all resolve the node the same way, on Claude Code and on Codex:
  a plan means one thing everywhere. `hooks/stop-continuity.sh` logs a `persona` event
  (`fork: "human"`, `engine: "hook"`) where it used to log `awaiting_human`, and the
  Canvas's amber *needs you* state now appears only when a run genuinely is waiting.
  **The trust boundary does not move, and Leopold is now precise about where it is.** A
  persona decides; it never ships. `hooks/guard-irreversible.sh` still denies `git commit`
  and `git push` (force-push unconditionally) — that is its entire scope, unchanged by this
  release. Tagging, publishing, opening an external PR, raising a budget and editing
  `GUARDRAILS.md` are forbidden to a persona too, but **no hook enforces them**, so every
  prompt that assumes a role now says exactly that instead of promising a guard that is not
  there: a role told `npm publish` would be blocked has no reason to hold back. See
  [what the guard enforces](docs/reference/hooks.md#what-the-guard-enforces). **Want the old behavior?** It is one line: `autonomy: ask` in
  `.leopold/GUARDRAILS.md` (now a documented key in `templates/GUARDRAILS.md`),
  `LEOPOLD_AUTONOMY=ask`, or the driver's `--ask` / `--autonomy ask`. `ask`, `halt` and
  `human` all spell it, and a value neither engine recognizes is treated as absent rather
  than as `ask`, because an unreadable line must never silently halt a run. A plan with no
  `@human` node is completely unaffected.
- **An escalation no longer ends the run — a synthesized role settles it.** When a worker
  reported `needs-decision` and the conductor could not settle the fork from the charter,
  the run stopped with `escalation` and the item sat there with a question attached until
  a person came back. Now Leopold works out WHO should take that fork, synthesizes the
  role from the item plus MISSION and CHARTER, lets it decide, pushes the decision back to
  the worker as a concrete instruction, and the item finishes. Every settled fork lands in
  `.leopold/DECISIONS.md` naming the persona, the fork, the charter basis and a Reversal
  line. The role is bound by the charter's hard rules lifted verbatim in code, not by a
  prompt that asks nicely. **The trust boundary does not move:** a role may conclude "ship
  it" and record that — the guard still denies the commit and the push that would carry it
  out — and no role may raise a budget, clear the kill switch or edit `GUARDRAILS.md`
  (rules it is told to keep, since no hook enforces those). An item may have
  two escalations settled this way; a third is a fork the run genuinely cannot make
  progress on, and it still stops. A fork that cannot be settled (an unusable answer, a
  harness error) escalates exactly as before, and says so in the event log. Set
  `autonomy: ask` in GUARDRAILS.md (or `--ask`) to keep the old behavior.

### Added
- **Every run now ends with "what I decided for you".** Autonomy that only writes to a
  file you have to remember to open is autonomy you find out about later. The completion
  report and the notification (terminal, and the webhook body if you set one) now end
  with the calls Leopold made on your behalf, **riskiest first**, each on two lines: the
  fork it came up at, the persona that decided it, the `D<n>` to look up — and the
  one-line **Reversal**. The rank is the fork (an escalation reads before a `@human`
  node, then a plan repair, then a repeated-failure rescue), nudged up when no role could
  be synthesized for the call, when the subject is heavy (production, data, anything
  outbound), or when the role stated no reversal of its own. Nothing is suppressed: past
  five calls the rest are counted, and `DECISIONS.md` is one line away. Both engines rank
  it identically — the workflow ranks what it holds, the driver ranks the same entries
  read back off the trail, and a test runs the two side by side over one run's real
  bytes. **A run that decided nothing on your behalf prints nothing**, so a report that
  had no persona decision is byte-for-byte the report it always was.

### Fixed
- **A route on a signal nobody emits is now a pre-flight diagnostic, not silence.**
  Only a key an item declares with `@emit` ever reaches the state channel — every other
  key a worker reports is refused — and a route never matches an absent key in either
  direction. So `@on migrated=false -> 7` with no `@emit migrated` anywhere was an edge
  that could never fire: the routing you wrote simply did not happen, and nothing said
  so. `validateGraph` gains a fifth defect class, `unroutable-signal`, naming the item,
  the key and the target, alongside `cycle`, `dangling-edge`, `unmet-need` and
  `unreachable`. Status routes (`@on fail`) test the node's own outcome and need no
  signal, so they are never diagnosed, and a `@tool` node's implicit `exit` still counts
  as emitted. Both engines pre-flight through the same `leopold graph` gate, so a plan
  is diagnosed identically by `/leopold-run` and `/leopold-workflow`. It catches **both
  spellings** — `@on migrated=false` and the bare `@on migrated` — because a bare word only
  ever matches an outcome the engine records, and the only words it records are `ok` and
  `fail`. And it **warns rather than refuses**: the verdict is new, the plans it judges are
  not, and a 0.15 brief whose dead route simply never fired must not suddenly dispatch
  nothing at all. The four classes that describe a graph which genuinely cannot run stay
  fatal.
- **A bare-word route on an emitted signal now fires whichever way you got there.**
  `settleNode` records a node's `ok`/`fail` before its routes are read, so the signal
  fallback the router documents (`@emit ready=true` then `@on ready -> 3`) was reachable
  only for a node carried over from an earlier session. Same plan, same channel, same
  answer, every time.
- **A last-chance attempt is no longer thrown away by the scheduler that bought it.** On
  `--parallel`, granting the rescue left `consecutive_failures` at the ceiling, so the next
  pass of the loop re-judged it while the rescued attempt was still in flight, found the
  rescue already spent, and stopped the run with `repeated_failure` — discarding the attempt
  it had just paid a persona synthesis and a root-cause panel for. Serially, the rescue lead
  was dropped whenever routing or a `rerun`/`inject` steer dispatched an item other than the
  one that failed, while the rescue stayed spent. In-session, nothing ever reset
  `consecutive_failures`, so a rescued attempt that SUCCEEDED still ended the run on the
  next turn; `/leopold-run` now resets it when an item closes, the way the driver always
  did. And the rescue is spent only once the turn actually happens — a run that hits its
  context budget on the same turn keeps its last chance instead of burning it on an attempt
  that never ran.
- **One-shot repairs are charged honestly.** A graph repair judged its amendments against a
  full `MAX_ADDED_ITEMS` purse and never recorded what it spent, so a deadlock repair then
  got three more and one run could make six plan changes under a contract that says three.
  `deadlock_repair_used` was marked spent before the guard that returns when nothing is
  stranded — burning the run's only repair without a single model call — and was never
  persisted before the call it was supposed to survive. A resumed `/leopold-run` no longer
  hands itself a fresh rescue either: the spent marks now survive the resume.
- **`--autonomy` cannot fail toward the permissive posture.** `--autonomy=ask` was ignored
  rather than read (only the space-separated form was), and an unrecognized value fell
  straight through to the default — which is `full`. An operator switching autonomy off got
  it on, silently. Unknown values now say so and take the strict side, and `--flag=value`
  works for every flag.
- **A wrapped `REVERSAL` is recorded whole.** The decision-block parser ended its lookahead
  on `$` under the multiline flag, where `$` matches every end-of-LINE, so any field a model
  wrapped was cut at the first newline. Half a Reversal reads complete and tells you
  nothing, and it is the one field the whole trail exists to carry.
- **A `@human` node sees the run's work.** It was given a fresh worktree forked off HEAD,
  and since git is locked every prior item's work is uncommitted and therefore invisible in
  it — a persona asked to approve a migration opened a tree with no migration in it. It now
  runs against the main tree, like every other judgement node.
- **Two escalations per item means per ITEM.** The counter lived in `processItem`, which is
  re-entered for every attempt, so an item retried three times could have six forks decided
  for it.
- **A persona is a role, not a costume.** The generic-role guard rejected `an agent` but
  accepted `an assistant`, `An Engineer` and `the assistant` — the exact strings its own
  prompt calls not-a-persona. Charter prose in the past tense ("the first attempt did not
  use a worktree") is no longer lifted into the binding rules, and a charter that states no
  hard rule now says so instead of printing "YOU ARE BOUND BY THESE RULES:" over nothing.
- **The docs no longer promise enforcement that does not exist.** `plan-grammar.md` said
  `git tag`, `publish` and opening an external PR "stay denied by
  `hooks/guard-irreversible.sh`". They do not: the guard's entire scope is `git commit` and
  `git push`. That sentence sat on the page defining `@human` semantics under the new
  default posture — exactly where irreversible calls live, told to a role that had no reason
  to hold back. Both language twins are corrected, and the trust-boundary suite now sweeps
  doc **prose**, not just the guard table, so the claim cannot drift back.

## [0.15.0] - 2026-08-06

### Fixed
- **`workflow --run` started the wrong harness, and the audit trail never said which.**
  The resolver's precedence ended at "both installed → Claude", so `leopold workflow
  --run` launched from a Codex session started the Claude Agent SDK — and nothing in
  `events.jsonl` recorded the provider, so the run could not be diagnosed after the
  fact. Resolution now consults the harness whose session Leopold was launched from
  (Codex exports `CODEX_THREAD_ID`, Claude Code exports `CLAUDECODE` — both verified
  against the live binaries) before falling back to Claude, and `--provider` is
  documented for `workflow --run`, not only for `run`. `run_start`, `wf_phase` and a
  new `wf_agent_start` all carry the provider. Reported as #54.
- **Hybrid runs: a harness per role.** `--provider hybrid` with
  `--executor-provider` / `--review-provider` / `--conductor-provider` (or the
  `LEOPOLD_*_PROVIDER` env vars) lets one run execute on one harness and review on the
  other. A call site tags itself with a role and the seam routes on it; a role left
  unset inherits the resolved default, and a run with no hybrid flags gets no role map
  at all — which is what keeps single-provider runs byte-for-byte unchanged.

### Added
- **`PLAN.md` is a graph you author, not a graph Leopold derives.** The Canvas has drawn
  a directed graph since v0.13.0, but you could never write one: every item was the same
  kind of node, every edge was a static `(after: N)` pointing backwards, and nothing a
  run learned could change where it went next. Now the markdown you type *is* the graph
  the scheduler executes, and `leopold graph` prints it. Two rules hold the whole design
  together — **the repository is the truth of what was built, the state channel is the
  truth of what was decided**, and **routing is deterministic**: a model may emit a
  signal, only the graph decides where that signal leads. No model call ever picks an
  edge. The full grammar is the
  [Plan Grammar reference](https://jonhvmp.github.io/leopold/reference/plan-grammar/).
- **Node kinds — `@node <kind>`, or the `@work` `@gate` `@verify` `@tool` `@human`
  `@feedback` shorthands, with an optional label (`@gate security`).** The engine treats
  each one differently instead of wrapping the same fixed verify gate around everything.
  `@gate` and `@verify` are review-only sessions over the uncommitted diff — every
  editing tool is denied on the session *and* in the driver's guard, so a node cannot
  write to the diff it is judging, and its verdict is the node's outcome (`blocked` →
  `fail`, which a route can catch). `@tool` means the item's text *is* a shell command:
  the driver runs it with no model turn and puts its exit status on the channel as
  `exit`, so `@on exit!=0 -> 5` needs no `@emit` line — and the git lock still applies,
  `@tool git push` is refused, not run. `@human` stops the run with `awaiting_human`,
  names the item and stages everything for whoever picks it up. `@work` is the default,
  and it is what every plan written before this grammar compiles to.
- **Conditional edges — `@on <condition> -> <target>`** (`->`, `=>` and `→` all parse).
  A condition is either a channel signal (`migrated=false`, `exit!=0`) or the node's own
  recorded outcome (`fail`, `blocked`, `ok`). Three behaviors are load-bearing and
  tested: a route is an edge control *may* take and never a dependency the scheduler
  waits on; a node that steers bypasses its other static successors, so a two-branch
  idiom runs exactly one branch; and routing latches — once a node has settled, a later
  node overwriting the same key cannot retroactively un-take a route. An absent key
  never matches, in either direction, because routing on something nobody emitted is
  precisely the bug that rule prevents.
- **A typed state channel — `@emit key=value` and `@needs key`.** A node declares the
  signals it may write and the ones it requires before it runs; a worker reports what it
  actually decided on a new optional `SIGNALS:` line in its status block, and the loop
  accepts only keys that item declared. The channel lives in `.leopold/bus.json` and is
  deliberately tiny, with the ceilings enforced in code: keys match
  `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`, values are one-line scalars ≤ 256 characters, ≤ 128
  keys at once, ≤ 64 KiB total. A value big enough to hold a diff, a patch or a log is a
  value the channel refuses — that ceiling is what stops it becoming a second repository
  nobody reviews.
- **A malformed graph is refused before the first agent runs, and the diagnostic names
  the offender.** "Invalid graph" is not a diagnostic; ``item 7 ("Ship it") routes to item
  12, which does not exist (`@on fail`)`` is. Four defect classes — `cycle`,
  `dangling-edge`, `unmet-need`, `unreachable` — are checked as pre-flight by
  `leopold run`, by `--dry-run`, by `leopold workflow`, and by the `/leopold-run` skill
  before it activates a run. Zero agents are spawned when the graph is unsound.
- **`leopold graph`** — the command to run before you trust a plan. Bare, it prints an
  ASCII tree with each node's kind, checkbox, deps and signals, routes hanging under
  their source; `--mermaid` emits the same graph as a fenced diagram with a distinct
  shape per node kind; `--json` gives `{ plan, nodes, edges, diagnostics }`; `--quiet`
  prints nothing on success, so a pre-flight in a script is just
  `leopold graph --quiet || exit 1`. Exit `0` sound, `1` malformed, `2` no plan to read.
- **`@feedback` nodes may amend the plan, within bounds enforced in code and logged.** A
  feedback node reads the run's own evidence (`events.jsonl` plus the run metrics),
  read-only, and *proposes* amendments in a fenced `leopold-amend` block — it never
  applies one. The driver enforces the bounds: at most **3** added items per run (the
  counter lives in `state.json`, so a resumed run inherits what it already spent instead
  of getting a fresh purse), `add` is the only verb, nothing is ever deleted, an item
  already `[x]` is never rewritten, `GUARDRAILS.md` is never amended, and an added item
  is always a plain work item. Accepted items append at the end of `PLAN.md`, so no
  existing index moves; every acceptance writes a `DECISIONS.md` block whose `Reversal:`
  line names the exact line to delete, and every refusal is logged with the bound that
  refused it.
- **Both engines run the same graph.** One compilation, two consumers: `leopold workflow`
  emits a `graph` key beside the waves, which flips the canonical dynamic-workflow script
  from its wave loop to a **routed loop** dispatching from the same deterministic routing
  function the driver's scheduler uses, so a plan takes the same path whether it runs
  through the SDK driver or as a dynamic workflow. `hooks/stop-continuity.sh` learned the
  node kinds too, and allows the stop with `awaiting_human` when the next open item is a
  `@human` node — identically on Claude Code and Codex CLI.
  `packages/driver/test/hook-kinds.test.ts` parses the same plans with the hook and with
  the driver's parser and fails the build if they ever disagree.
- **The Canvas draws what you actually wrote.** Node kinds are rendered on the node with
  their label (`@gate security` reads `GATE · SECURITY`); an `@on` route is a bowed,
  dashed edge in its own color carrying the condition *as written*, so a branch never
  reads like a dependency; the inspector lists an item's routes and the signals it emits
  and needs; and a `@human` node the run is actually waiting on switches to a distinct
  amber `awaiting` state. Nothing is inferred — the node waits only when the run says it
  does.

### Compatibility
- **Every plan written before this release parses to a byte-identical graph and runs the
  identical path. That is a gate in the test suite, not a hope.** Every construct above
  is opt-in, and absence means today's behavior. `plan.test.ts` reparses the real plans
  Leopold has run — its own briefs, the shipped template, the fixtures — against a golden
  captured from the parser *as it stood before the grammar existed*, plus an edge-case
  corpus, and fails if a single legacy field moves. `leopold workflow` emits the `graph`
  key **only** when the plan actually authors one, so an old brief compiles to the same
  payload and runs the same wave loop with the same prompts and the same report shape.
  Validation cannot turn an old plan into a new failure either: `(after:)` edges only
  ever point backwards at existing items, so they cannot cycle, dangle or strand
  anything — a plan that declares no `@on`, `@emit` or `@needs` can never produce a
  diagnostic. The `SIGNALS:` status line is optional, and a status block without it
  parses exactly as it did before. Node-kind-less items are `work` nodes everywhere: in
  the driver, in the compiled workflow, in the Stop hook, and on the Canvas.

### Changed
- The driver's guard gained denials, never permissions. A read-only node (`@gate`,
  `@verify`, `@feedback`) additionally denies every editing tool *and* any shell command
  that would write under the run's own `.leopold/` — without that second half the first
  is theatre, since a node that can reach `PLAN.md` through `sed -i` walks around every
  amendment bound. Work nodes are locked exactly as before: `git commit` and `git push`,
  nothing else.
- Read-only nodes are checked against a receipt, not trusted. The tree signature now
  covers file *contents* as well as which paths are dirty — `git status --porcelain` is
  byte-identical before and after a write to a file that is already dirty, which is
  precisely the kind of file a gate reviews — computed through a throwaway
  `GIT_INDEX_FILE` so taking the signature never stages anything in the repo it measures.
  The brief itself gets a second receipt, with `PLAN.md` hashed with its checkboxes
  blanked (a `--parallel` run legitimately closes another item mid-node) and the
  checkbox state covered by its own flip ledger, so a node that marks the plan done to
  end the run on `plan_complete` is caught and restored.

## [0.14.2] - 2026-08-06

### Fixed
- **A dying agent took the whole workflow down.** `leopold workflow --run` parsed the
  brief, logged the Plan phase and `wave 1/N`, then stopped with `reason: error` and no
  items done. The native Claude Code runtime returns `null` when an agent dies, and the
  canonical script is written against that contract — it checks for null and charges the
  round. The in-driver runtime let the exception propagate instead, and the script's wave
  loop has no try/catch, so one transient failure unwound past every remaining item and
  out to the CLI. `agent()` now honors the same contract: a dead agent becomes `null`, the
  run continues, and the failure is reported through `onAgentError`. The agent cap and the
  token budget still abort the run — those are deliberate stops, not one agent
  misbehaving. Reported as #51.
- **The audit trail recorded that a run failed, never why.** The stop event was a bare
  `{"event":"stop","reason":"error"}`, so the one artifact a user can hand over — their
  `events.jsonl` — could not say what went wrong. #51 was filed with a flawless repro and
  no root cause for exactly this reason. The event now carries `error`, and every failing
  agent becomes a `wf_agent_error` with its label and message.

## [0.14.1] - 2026-08-04

### Fixed
- **The installer checked gstack globally and could leave a harness with nothing.**
  The gate asked `manage.sh detect`, which answers "is gstack on this machine" — true
  if the checkout exists *or* if *any* resolved harness sees its skills. On a box where
  gstack lived under Claude Code only, installing into both harnesses printed
  `gstack detected`, skipped setup, and left Codex with zero skills. A checkout that no
  skills dir points at satisfied the same gate, in which case *neither* harness got
  anything. `detect` was not wrong, it was answering the menu's question; the installer
  needs a different one, so `detect-all` (every resolved harness sees the skills,
  ignoring a checkout nobody links to) and `missing` (which harnesses are uncovered)
  join it. The installer now reports complete coverage, repairs partial coverage with
  the existing checkout — no re-clone, no network — or falls back to the usual prompt.
  Reported as #48, and seen on a real install: `gstack detected` while Claude had 0 skills.

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
