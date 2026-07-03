// Leopold Learn — the self-improving charter.
//
// The charter is the part of Leopold that "becomes you" — but it is written once,
// at brief time, from what you REMEMBERED about how you decide. Your actual
// decisions leak better data: the calls Leopold logged in DECISIONS.md, the
// corrections you keep typing in sessions, the reverts in git history. This
// workflow mines those sources with independent agents, clusters the recurring
// signals, puts every candidate rule in front of a skeptic (would it have
// prevented a real mistake? is it already covered? is it a one-off?), and distills
// the survivors into a PROPOSAL file. It never edits CHARTER.md itself — the
// charter is the user's identity; the human applies the amendments.
//
// args shape (the skill fills this):
//   {
//     projectDir:    string,   // absolute repo root
//     charter:       string,   // current CHARTER.md content (so miners don't re-propose it)
//     decisionsPaths: string[],// DECISIONS.md + archived runs' DECISIONS.md (absolute paths)
//     transcriptDir: string,   // ~/.claude/projects/<slug>/ (session .jsonl files), '' if none
//     outPath:       string,   // where to write the proposal (.leopold/CHARTER-amendments.md)
//     maxCandidates: number,   // cap on rules to verify (default 12)
//   }

export const meta = {
  name: 'leopold-learn',
  description:
    'Mine past Leopold decisions, session corrections, and git history for recurring judgment calls; skeptic-verify each candidate; distill the survivors into charter amendments the human can apply.',
  phases: [
    { title: 'Mine' },
    { title: 'Cluster' },
    { title: 'Verify' },
    { title: 'Distill' },
  ],
}

const a = args || {}
const projectDir = String(a.projectDir || '.')
const charter = String(a.charter || '')
const decisionsPaths = Array.isArray(a.decisionsPaths) ? a.decisionsPaths : []
const transcriptDir = String(a.transcriptDir || '')
const outPath = String(a.outPath || '.leopold/CHARTER-amendments.md')
const MAX = Number.isFinite(a.maxCandidates) ? a.maxCandidates : 12

const CANDIDATES_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'evidence'],
        properties: {
          rule: { type: 'string', description: 'The charter rule, phrased as the user would write it (concrete, testable)' },
          evidence: { type: 'string', description: 'The specific decisions/corrections/commits that show the pattern, with counts' },
          source: { type: 'string' },
        },
      },
    },
  },
}

const CHARTER_NOTE = `The CURRENT charter is below — do NOT propose anything it already covers; only propose rules the recorded behavior shows are MISSING or repeatedly overridden:\n---\n${charter.slice(0, 4000)}\n---`

// ── Mine: three independent miners over DISJOINT sources ─────────────────────────
// Each miner is blind to the others' sources, so the same pattern surfacing twice
// is real signal, not shared bias.
phase('Mine')

const miners = []

if (decisionsPaths.length) {
  miners.push(() => agent(
    `You are mining a Leopold project's autonomous decision log for recurring judgment patterns worth promoting into the charter.

Read these decision logs (each entry has Fork / Class / Charter / Decision / Why / Reversal):
${decisionsPaths.map((p) => `- ${p}`).join('\n')}

Look for: forks the conductor had to settle from GENERIC principles because the charter was silent; the same kind of call made 2+ times; escalations that a one-line charter rule would have prevented. ${CHARTER_NOTE}

Return up to 8 candidate rules with concrete evidence (quote the decisions, count the repeats).`,
    { label: 'mine:decisions', phase: 'Mine', schema: CANDIDATES_SCHEMA },
  ))
}

if (transcriptDir) {
  miners.push(() => agent(
    `You are mining Claude Code session transcripts for corrections the user keeps making — each recurring correction is a charter rule that was never written down.

Transcript directory (newest sessions matter most; they are .jsonl, one JSON message per line — use grep/jq-style extraction rather than reading whole files, they are large):
  ${transcriptDir}

Look ONLY at USER messages ("type":"user" entries or human turns) for: repeated style/stack corrections ("use X not Y"), repeated pushback on approach, repeated "don't do that" or "always do this" instructions, and repeated manual fixes right after the assistant's work. Ignore one-offs. ${CHARTER_NOTE}

Return up to 8 candidate rules; evidence must cite the actual phrasings and how many separate sessions they appear in.`,
    { label: 'mine:transcripts', phase: 'Mine', schema: CANDIDATES_SCHEMA },
  ))
}

miners.push(() => agent(
  `You are mining a git repository's history for judgment patterns the commit record shows but nobody wrote down.

Repo: ${projectDir}

Run read-only git commands (git log --oneline -100, git log --grep, git show --stat on interesting commits). Look for: revert/fixup/"oops" chains (something keeps being done wrong then corrected), repeated churn on the same file for the same kind of mistake, commit messages that state a norm ("stop doing X", "always Y"). ${CHARTER_NOTE}

Return up to 8 candidate rules with the commit hashes as evidence.`,
  { label: 'mine:git-history', phase: 'Mine', schema: CANDIDATES_SCHEMA },
))

// Barrier is justified: clustering needs ALL miners' candidates at once.
const mined = (await parallel(miners)).filter(Boolean).flatMap((r) => r.candidates || [])
log(`mined ${mined.length} raw candidate(s) from ${miners.length} source(s)`)

if (mined.length === 0) {
  return { proposed: 0, outPath: null, note: 'No recurring patterns found — the charter already covers how this project runs.' }
}

// ── Cluster: merge duplicates across sources (cross-source repeats are the gold) ─
phase('Cluster')
const clustered = await agent(
  `Cluster these candidate charter rules mined from different sources. Merge duplicates and near-duplicates into one rule each (keep the sharpest phrasing, concatenate the evidence, and note when a pattern appeared in MORE THAN ONE independent source — that is the strongest signal). Drop anything vague, untestable, or trivially one-off. Keep at most ${MAX}, strongest first.

Candidates (JSON):
${JSON.stringify(mined, null, 2)}`,
  { label: 'cluster', phase: 'Cluster', schema: CANDIDATES_SCHEMA },
)
const candidates = (clustered?.candidates || []).slice(0, MAX)
log(`clustered to ${candidates.length} distinct candidate(s)`)

// ── Verify: one skeptic per candidate, prompted to KILL it ───────────────────────
phase('Verify')
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['keep'],
  properties: {
    keep: { type: 'boolean' },
    refined: { type: 'string', description: 'The rule, tightened into its most concrete, testable phrasing' },
    why: { type: 'string' },
  },
}

const verified = await parallel(candidates.map((c) => () =>
  agent(
    `You are a skeptic judging whether a mined rule deserves to enter a project's charter — the document an autonomous run uses to decide as the user would. Default to keep=false; a wrong rule misroutes every future decision.

Candidate rule: ${c.rule}
Evidence: ${c.evidence}

Kill it if ANY of these hold — check against the repo at ${projectDir} where facts are checkable:
1. The current charter already covers it (charter excerpt): ${charter.slice(0, 1500)}
2. The evidence is a one-off dressed up as a pattern (fewer than 2 independent occurrences).
3. It is too vague to resolve a real fork ("prefer quality" resolves nothing).
4. It encodes a temporary circumstance, not a durable preference.

If it survives, refine it into the most concrete, testable phrasing (the charter style: "prefer a 10-line obvious function over a helper unless used 3+ times", not "avoid abstractions").`,
    { label: `verify:${c.rule.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => ({ c, v })),
))

const survivors = verified
  .filter(Boolean)
  .filter(({ v }) => v.keep)
  .map(({ c, v }) => ({ rule: (v.refined || c.rule).trim(), evidence: c.evidence, why: v.why || '' }))
log(`${survivors.length}/${candidates.length} candidate(s) survived the skeptic`)

if (survivors.length === 0) {
  return { proposed: 0, outPath: null, note: `All ${candidates.length} candidates were killed by the skeptic — no amendment proposed.` }
}

// ── Distill: write the proposal file (NOT the charter itself) ─────────────────────
phase('Distill')
await agent(
  `Write a charter amendment proposal to the file ${outPath} (create parent dirs if needed). This is a PROPOSAL for the human — do NOT touch CHARTER.md or any other file.

Format:
# Charter amendments (proposed by /leopold-learn)

> Each rule below was mined from your recorded decisions, verified by a skeptic,
> and is NOT yet in the charter. Review and fold the ones that sound like you
> into .leopold/CHARTER.md; delete the rest. This file is safe to delete.

Then one section per rule:
## <the rule, one line>
- **Evidence:** <the evidence>
- **Why it survived review:** <the why>
- **Suggested charter section:** <Always / Never / Tie-breakers / Preferences — pick the best fit>

The rules (JSON):
${JSON.stringify(survivors, null, 2)}

After writing, return the single word: written`,
  { label: 'distill', phase: 'Distill' },
)

return {
  proposed: survivors.length,
  outPath,
  rules: survivors.map((s) => s.rule),
  note: 'Proposal written. The charter itself was NOT modified — review the file and fold in what sounds like you.',
}
