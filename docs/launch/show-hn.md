# Show HN draft

> Draft for the human to post. Not posted by Leopold. Tune the numbers (stars, version)
> before posting. Keep it honest — alpha is alpha.

**Title:** Show HN: Leopold – brief Claude Code like a teammate, it runs autonomously

**URL:** https://github.com/Jonhvmp/leopold

**Text:**

I kept wanting Claude Code to run for an hour while I did something else, but it pauses
at every fork: "approach A or B?", "commit?", "next item or stop?". The right default
when you're watching; the wrong one when you're not.

Leopold is a small harness that flips two of those without touching the third. You debate
the work with it first — goals, taste, what "done" means, hard never/always rules — and
that becomes a durable brief (MISSION/CHARTER/PLAN). Then a Stop hook re-injects "continue"
after each turn, and the agent decides forks from your charter instead of asking, logging
each decision (and how to reverse it) to DECISIONS.md. Safety defaults stay locked.

The part I most want feedback on is the **git lock**, because the whole pitch is "autonomy
you can trust." The PreToolUse guard blocks commit/push/`rm -rf`/etc. while autonomous. I
found and fixed real bypasses in my own guard (`git -c user.name=x commit`,
`rm --recursive --force`, `find -delete`, git by absolute path) and turned each into a
red-team test — 59 cases for the bash hook + unit tests for the TS driver guard, in CI.
If you can slip something past it, I'd genuinely like the bug.

It's built to conduct gstack (Garry Tan's skill suite) when present, but works on plain
Claude Code. There's an optional external SDK driver too. Status is honest alpha.

Closest cousin is Ralph (the bash `while true` loop) — Leopold's bet is that a *charter*
beats a fixed prompt and a *hook* beats a shell loop. Comparison in the repo. Happy to be
told I'm wrong about that.
