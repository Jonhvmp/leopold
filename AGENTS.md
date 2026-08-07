# Leopold — working agreement for coding agents

**The full agreement lives in [`CLAUDE.md`](CLAUDE.md). Read it before you change
anything.** This file exists because Codex CLI loads `AGENTS.md` and Claude Code loads
`CLAUDE.md`; Leopold ships on both, so its own repo speaks to both.

The three rules that are violated most often, inlined so a session that never opens the
other file still gets them right:

1. **English for anything that lands in the repo or on GitHub** — code, comments, commit
   messages, PR titles and bodies, issue replies, CHANGELOG, docs. The `.pt-BR.md` docs
   are translations of an English original, never Portuguese-first. Chatting with the
   maintainer in Portuguese is fine; the artifact is English.
2. **Write as Jonhvmp, first person.** Never mention Claude, an AI or an assistant in a
   commit, PR, release or changelog, and never add a `Co-Authored-By` trailer for a model.
3. **Never push, tag, publish, merge, or open an external PR on your own.** Commit when
   the work is verified, then report readiness. Those actions are the maintainer's.

And the bar: `make test` is the gate, a regression test is verified **by mutation**
(reintroduce the bug, watch it fail), and nothing that writes into a harness home is
tested anywhere but a temp dir.
