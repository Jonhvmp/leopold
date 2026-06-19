# r/ClaudeAI draft

> Draft for the human to post. Not posted by Leopold. r/ClaudeAI leans practical —
> lead with what it does for *their* Claude Code, not the philosophy.

**Title:** I built a harness that lets Claude Code run autonomously from a brief (git stays locked, red-teamed)

**Body:**

If you use Claude Code, you know it stops at every decision. Great with a human watching,
annoying when you want it to burn down a backlog while you're away.

Leopold (open source, MIT) is a thin layer on top of Claude Code:

- `/leopold-brief` — you talk through the mission and it writes MISSION/CHARTER/PLAN. The
  CHARTER is the important bit: your priorities, taste, and hard never/always rules.
- `/leopold-run` — it picks the next plan item, does it (reaching for the right gstack
  skill), and on a fork it decides from your charter instead of asking, logging the
  decision to DECISIONS.md. A Stop hook keeps it going; a PreToolUse hook keeps git locked.

Because it sells autonomy, I spent most of the effort on the **lock**, not features. The
guard blocks commit/push/`rm -rf`/publish while autonomous. I red-teamed it against my own
bypasses (`git -c …=… commit`, `rm --recursive --force`, `find -delete`, absolute-path git)
— 59 test cases in CI. You opt in per session if you actually want it to commit.

Install is `curl … | bash` (or a Claude Code plugin). It conducts gstack if you have it,
works without. Honest alpha — feedback (and bypass attempts) very welcome.

Repo + a "Leopold vs Ralph" writeup in the comments.
