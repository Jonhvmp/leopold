# Leopold — working agreement for coding agents

Leopold is an autonomous orchestration harness for **Claude Code and Codex CLI**. You
are working on the tool that conducts runs, so the bar is the one Leopold sets for its
own runs.

## Language: English for anything that lands in the repo or on GitHub

This is the rule people trip on most, so it is first.

**English, always:** source code, identifiers, code comments, commit messages, PR
titles and bodies, issue titles/comments/replies, CHANGELOG entries, README, `docs/`
(the `.pt-BR.md` twins are the *only* exception — they exist because the docs site is
bilingual), test names and assertion messages, log lines, CLI output, error strings.

**Portuguese is fine** in conversation with the maintainer. That is a chat register,
not a project artifact. The moment a sentence is going to be committed, pushed, or
posted to GitHub, it is English.

A `.pt-BR.md` doc is a translation of an English original, never a Portuguese-first
page. If you add a doc, write the English one first and translate it.

This rule predates this file — see `CONTRIBUTING.md`. It lives here too because a
contributor reads CONTRIBUTING and an agent reads this.

## Authorship

Every commit, PR, release note and changelog entry is written **as Jonhvmp**, first
person, in his voice. Never mention Claude, an AI, an assistant, "generated with", and
never add a `Co-Authored-By` trailer for a model. Confident tone, no hedging.

## Git

- Commit freely when the work is done and verified.
- **Never** `git push`, `git tag`, `npm publish`, merge a PR, or open an external PR on
  your own. Those are the maintainer's calls — stage, commit, and report readiness.
- **Force-push:** never on `main`, `develop`, or any branch someone else may have pulled.
  On your own unmerged feature branch it is fine for tidying your own commits (amending a
  message, squashing), and always with `--force-with-lease` so you cannot clobber work you
  have not seen. If in doubt, it is a shared branch — ask.
- During an autonomous Leopold run, `git commit` and `git push` are additionally locked
  by `hooks/guard-irreversible.sh`. That is the product's core promise: the run stages,
  the human ships.

## The bar for "done"

- `make test` is the gate. It is what CI runs: hooks, guard red-team, the harness
  extension suites, the driver (typecheck + tests + build + smoke), and `mkdocs --strict`.
- **A regression test is verified by mutation.** Reintroduce the bug, watch the test
  fail, restore it. A test that still passes with the bug present is theatre.
- Anything that writes into a harness home or a project is tested hermetically:
  `CLAUDE_HOME` / `CODEX_HOME` / `LEOPOLD_HOME` pointed at a temp dir. Never `~/`.
- Installer paths prove idempotency: install three times, assert one hook.
- No claim ships that the tests do not back. If a doc says "tested", a test exists.

## Architecture rules that are not negotiable

- **Zero runtime dependencies.** bash + jq for the harness layer, TypeScript stdlib for
  the driver, Python stdlib for `leopold-watch.py`, vanilla JS + SVG for the Canvas. No
  framework, bundler, CDN, web font, or build step. If it cannot run offline with no
  supply chain, it is not Leopold.
- **Both harnesses or neither.** A capability that works on Claude Code and silently
  degrades on Codex (or the reverse) is half-shipped. The two hooks are the same
  unmodified scripts on both; keep it that way.
- **One writer per surface.** JSON and TOML hook wiring lives in
  `extensions/lib/harness.sh` alone. Copy-pasting it into an extension is how the two
  harnesses drift apart.
- **Additive and backward compatible.** Extend modules in their current style. A change
  that alters how an existing brief parses or runs is the wrong change — find the
  additive form, even if it is uglier.
- **Never degrade silently.** If something cannot work on a harness, say so in the UI
  and in `leopold doctor`. A zero, an empty panel, or a no-op that reads as success is
  worse than an error.

## Verify, do not assume

Every claim about how Claude Code or Codex behaves is checked against the local binary —
run it, read the payload, watch the effect — before it is coded against or written into
a doc. A `strings` dump or a doc page is a hypothesis; a live session is a fact.

## Layout

```
hooks/            the two hooks: guard-irreversible.sh (git lock), stop-continuity.sh (continuity)
skills/           the /leopold-* skills, installed into each harness's skills dir
extensions/       serena · gstack · ovmem · enhance, + lib/harness.sh (the shared writer)
packages/driver/  the TypeScript SDK driver (provider seam in sdk.ts → providers/)
scripts/          installers, doctor, menu, leopold-watch.py (dashboard + Canvas), test suites
templates/        the brief artifacts a project copies into .leopold/
docs/             mkdocs site, English + .pt-BR.md twins
```

`.leopold/` in this repo is Leopold's own brief — it dogfoods itself. Finished missions
are archived under `.leopold/runs/`.
