# X / Twitter thread draft

> Draft for the human to post. Not posted by Leopold. One idea per post; keep the hook tight.

**1/**
Claude Code pauses at every fork: "A or B?", "commit?", "next or stop?"
Right when you're watching. Wrong when you want it to run for an hour while you're away.

Leopold: brief it like a teammate, it conducts Claude Code in your seat. Open source. 🧵

**2/**
You don't write a prompt. You debate the work — goals, taste, what "done" means, your hard
never/always rules — and that becomes a durable brief: MISSION / CHARTER / PLAN.

The CHARTER is the trick. It's the part that "becomes you", so the agent can decide instead
of ask.

**3/**
`/leopold-run` and it loops on its own:
pick the next plan item → do it → hit a fork → consult the charter → if it's reversible &
clear, decide, log it to DECISIONS.md, keep going.

A Stop hook re-injects "continue". You review what "you" decided later.

**4/**
The scary part of autonomy is your repo. So the lock got the most work, not the features.

git commit/push, `rm -rf`, publish — all blocked while autonomous, regardless of permission
mode. You opt in per session.

**5/**
And I red-teamed my own lock. Found real bypasses —
`git -c user.name=x commit`, `rm --recursive --force`, `find -delete`, abs-path git —
fixed them, and made each one a test. 59 cases in CI. Try to break it.

**6/**
Closest relative is Ralph (the `while true` bash loop). Leopold's bet: a charter beats a
fixed prompt, and a hook beats a shell loop.

Honest alpha. Conducts gstack, works on plain Claude Code.
Repo: github.com/Jonhvmp/leopold
