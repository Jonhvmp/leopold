# Launch checklist (manual — the human runs this)

Everything here is a **gated** action: Leopold drafts, you post. Do them in order; the
first two are prerequisites for the rest landing well.

## 0. Before anything
- [ ] Land the release: merge the open PR, then `git tag v0.4.0` happens via CI (or tag
      manually). Confirm `npm` shows the latest `leopold-driver` if it changed.
- [ ] Re-read each draft in `docs/launch/`; fix the live numbers (stars, version) and your
      handle/links. Drafts go stale — treat them as starting points.
- [ ] (Demo) Record `assets/demo.cast` and render the SVG (see `scripts/record-demo.sh`),
      then embed it at the top of the README. The cast is the single biggest conversion
      lever; do it before the posts if you can.

## 1. Repo hygiene (5 min, high signal)
- [ ] **Enable GitHub Discussions** (Settings → General → Features). This is where a new
      tool's community forms; it is off by default.
- [ ] Add `topics` to the repo: `claude-code`, `ai-agents`, `autonomous-agents`,
      `agent-harness`, `orchestration`.
- [ ] Confirm the README badges render (CI green, npm version, license).
- [ ] Pin one issue inviting guard bypass attempts ("break the lock") — it doubles as
      marketing and as real security review.

## 2. Coordinated post (same day, a few hours apart)
- [ ] **Show HN** (`show-hn.md`). Post in the morning ET on a weekday. Reply to every
      comment in the first 2 hours; that window decides the rank.
- [ ] **r/ClaudeAI** (`reddit-claudeai.md`). Lead with utility, not philosophy. Put the
      "Leopold vs Ralph" link in a comment, not the body.
- [ ] **X thread** (`x-thread.md`). Pin it. Reply to your own thread with the demo SVG.

## 3. Directories / lists (within the week)
- [ ] Submit the `awesome-claude-code` entry (`awesome-claude-code-pr.md`).
- [ ] Submit to the Claude Code plugin marketplace / any skills directory.
- [ ] Consider Product Hunt once the demo SVG is in place (it needs a strong hero image).

## 4. After
- [ ] Triage Discussions/issues fast for the first week.
- [ ] Turn every reported bypass into a red-team test case (the project's whole credibility
      rests on this).
