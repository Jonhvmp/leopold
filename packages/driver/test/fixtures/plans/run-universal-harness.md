# Plan

> Ordered, checkbox backlog for the universal-harness mission. `(after: N)` = a real
> dependency on item N (1-based). Items without a marker are independent and safe to
> run concurrently under `--parallel`; items that write the same file are chained.
> Use Serena (LSP) for code edits. Every new behavior gets a test — no claim without
> one. Every installer change is verified against a TEMP harness home, never `~/`.
>
> Already landed before this plan (do not redo): `provider.ts` capability registry,
> `providers/codex.ts` (`codex exec` backend), provider routing in `sdk.ts`,
> `install.sh --harness`, `scripts/install-codex.sh` (both hooks), `leopold harness`,
> multi-harness `leopold doctor`, `.codex-plugin/plugin.json`,
> `docs/concepts/harnesses.md` (+ pt-BR).

- [x] Add a `leopold home` subcommand to the driver that prints the resolved Leopold
      asset home, using the same precedence as the installer, and document the
      no-CLI shell fallback one-liner in `docs/reference/`. — done when: the command
      prints an absolute path on both harness layouts and the fallback resolves
      identically.
      @scenario `LEOPOLD_HOME=/tmp/leo` set → `leopold home` prints `/tmp/leo`
      @scenario no override, `$CLAUDE_HOME/leopold` exists → prints that path
      @scenario no override, only `$CODEX_HOME` exists → prints `$CODEX_HOME/leopold`
      @scenario the documented shell fallback, run with the same env, prints the same
                path as `leopold home` in all three cases above

- [x] (after: 1) Replace every hardcoded `~/.claude` path in `skills/*/SKILL.md` with
      the resolver from item 1 (30 occurrences across 8 skills; `leopold-enhance` has
      18 of them). — done when: no SKILL.md contains the literal `~/.claude`, and each
      changed command still runs on a Claude-only layout.
      @scenario `grep -rl '~/.claude' skills/*/SKILL.md` → no matches
      @scenario a Claude-only machine runs `/leopold-doctor` → it finds and runs the
                doctor script exactly as before this change
      @scenario a Codex-only machine runs the same skill → it resolves
                `$CODEX_HOME/leopold` and runs the same script

- [x] (after: 2) Make the skills' prose harness-neutral: say "the agent"/"the harness"
      instead of "Claude Code" where the statement is not Claude-specific, and where a
      tool is named, name both harnesses' equivalents so the sentence is actionable on
      either (subagent spawn, task list, skill invocation, slash command). — done when:
      the remaining "Claude Code" mentions are only in statements that are genuinely
      Claude-specific, and every tool reference an agent must act on names both.
      @scenario a reader on Codex hits a tool instruction → it names the Codex
                equivalent alongside the Claude one, not only `Task`/`TodoWrite`
      @scenario every SKILL.md still parses: frontmatter `name` + `description` intact,
                and `leopold doctor` counts 12 skills after a reinstall

- [x] Extract one shared hook-wiring helper for the extensions (e.g.
      `extensions/lib/harness.sh`) that resolves the target harnesses and writes a
      hook into `settings.json` (jq) or `config.toml` (marker block), idempotently,
      with a backup and post-write validation + rollback — the same contract
      `scripts/install-codex.sh` already proved. — done when: the helper is covered by
      a hermetic test and `install-codex.sh` uses it rather than its own copy.
      @scenario wiring the same hook three times into a temp `config.toml` → exactly
                one hook entry, and the file still parses as TOML
      @scenario wiring the same hook three times into a temp `settings.json` → exactly
                one hook entry, and the file still parses as JSON
      @scenario the write would produce an unparseable file → the original is restored
                and the helper exits non-zero with the block printed for manual use

- [x] (after: 4) Port the **serena** extension to Codex: register the MCP server with
      `codex mcp add` and wire its hooks through the shared helper; `manage.sh
      install|status|doctor` all report per harness. — done when: a temp-home Codex
      install registers serena and its doctor is green.
      @scenario `CODEX_HOME=<temp>` install → serena appears in Codex's MCP config
      @scenario `manage.sh status` on a machine with both harnesses → reports serena's
                state for each, not just Claude's
      @scenario `manage.sh install` run twice → second run reports "already installed"
                and changes nothing

- [x] (after: 4) Port the **enhance** extension to Codex: wire its UserPromptSubmit
      hook into `config.toml` via the shared helper, keep the enabled/disabled state
      file shared across harnesses. — done when: toggling on one harness is reflected
      in `manage.sh status` for both, and the existing `scripts/test-enhance.sh` still
      passes unchanged.
      @scenario Codex-only temp home, enhance installed → `hooks.UserPromptSubmit` in
                `config.toml` points at `enhance.py`
      @scenario enhance disabled → the hook is still wired but a prompt passes through
                unmodified (silent no-op), same as on Claude
      @scenario `scripts/test-enhance.sh` → passes with no edits

- [x] (after: 4) Port the **ovmem** extension to Codex: wire its UserPromptSubmit,
      SessionStart, SessionEnd and PreCompact hooks through the shared helper and make
      its payload handling tolerate Codex's session payload shape. — done when: a
      temp-home Codex install wires all four events and ovmem's doctor is green.
      @scenario Codex-only temp home, ovmem installed → all four hook events present
                in `config.toml` and the file parses
      @scenario a Codex SessionStart payload reaches `ovmem.py` → it returns without
                error and injects its memory block
      @scenario re-running the installer → no duplicate hook entries

- [x] (after: 4) Make the **gstack** extension harness-aware: install its skills into
      every detected harness's skills dir and report per harness. — done when: a
      Codex-only machine gets gstack skills where Codex looks for them.
      @scenario `CODEX_HOME=<temp>` install → gstack skills resolve under the Codex
                skills root
      @scenario `manage.sh status` with both harnesses present → reports each

- [x] Teach `scripts/leopold-watch.py` to read a Codex transcript: detect a Codex
      rollout JSONL (`session_meta` first line) and parse `event_msg` /
      `payload.type == "token_count"` → `info.total_token_usage` for tokens and
      context, plus `agent_message` for assistant text; add the OpenAI models to the
      price map. — done when: a Codex-conducted run shows real tokens, cost and
      context in the dashboard, and a Claude run is unchanged.
      @scenario a Codex rollout file is the run's `transcript_path` → the dashboard
                reports non-zero tokens and a non-zero cost estimate
      @scenario a Claude transcript → every number matches what the dashboard reported
                before this change
      @scenario a transcript in neither format → the panel says the cost is unavailable
                for this harness instead of showing zeros

- [x] Make `scripts/leopold-menu.sh` and `scripts/leopold-up.sh` harness-aware:
      resolve the asset home like item 1, and have `leopold-up` seed project
      permissions/trust for whichever harness is present (`.claude/settings.json`
      and/or Codex project trust) and point `/init` at the right memory file
      (`CLAUDE.md` vs `AGENTS.md`). — done when: both scripts run to completion on a
      Codex-only temp layout.
      @scenario Codex-only temp home → `leopold-menu.sh` finds its extensions registry
                and lists all four extensions
      @scenario Codex-only project → `leopold-up` reports the Codex memory file
                (`AGENTS.md`) as the target, not `CLAUDE.md`

- [x] (after: 5, 6, 7, 8) Add a hermetic `scripts/test-codex-install.sh` covering the
      whole Codex path — skills, both hooks, all four extensions, idempotency,
      rollback on invalid TOML — against temp homes only, and wire it into the
      Makefile `test` target and CI. — done when: the suite is green and provably
      touches no real harness home.
      @scenario the suite runs with `CODEX_HOME`/`CLAUDE_HOME`/`LEOPOLD_HOME` in a
                temp dir → passes, and the real `~/.codex/config.toml` mtime is
                unchanged
      @scenario a deliberately corrupted target `config.toml` → the installer restores
                the backup and the suite asserts the rollback happened
      @scenario `make test` → runs this suite alongside the existing ones

- [x] (after: 3, 9, 10, 11) Update the docs and metadata for the universal install:
      `docs/concepts/harnesses.md` + pt-BR (extensions and dashboard sections),
      `docs/getting-started/install.md` + pt-BR, `docs/reference/hooks.md`, README,
      CHANGELOG (close the Unreleased block as 0.14.0), and bump `VERSION` +
      `packages/driver/package.json` to 0.14.0. — done when: docs build `--strict`
      clean and no doc claims a capability the tests do not cover.
      @scenario `mkdocs build --strict` → exits 0
      @scenario every harness-parity claim in README/docs maps to a test in the suite
      @scenario `VERSION`, `packages/driver/package.json` and the CHANGELOG heading
                all read 0.14.0

- [x] (after: 12) Final verification sweep and hand-off: `make test`, the guard
      red-team suite, driver typecheck/build/tests, CLI smoke, `npm pack` dry-run, a
      dual-harness install into temp homes, and `leopold doctor` on both. Stage
      everything and report readiness — do NOT commit, push or tag. — done when: every
      suite is green and the working tree is fully staged with a written summary of
      what changed and what the human should review first.
      @scenario every suite listed above → green, with the output quoted in the report
      @scenario `git status` → all mission changes staged, nothing committed
      @scenario the report names the riskiest change and how to undo it
