// Leopold Enhance Learn — the self-improving prompt profile.
//
// The enhancer rewrites weak prompts through ~/.claude/enhance/PROMPT-PROFILE.md,
// but that profile starts empty. The best data about how YOU phrase things is in
// the enhancement ledger: every prompt that got enhanced and then CORRECTED right
// after is an interpretation the rewriter got wrong; every band of the gate that
// keeps misfiring is a threshold worth tuning. This workflow mines the ledger and
// the session transcripts with independent agents, clusters the recurring signals,
// puts every candidate rule in front of a kill-biased skeptic, and distills the
// survivors into a PROPOSAL file. It never edits PROMPT-PROFILE.md itself — the
// human applies the amendments (same trust structure as /leopold-learn).
//
// args shape (the skill fills this):
//   {
//     ledgerPaths:    string[], // enhancements.jsonl (+ rotated .1) — absolute paths
//     transcriptDirs: string[], // ~/.claude/projects/<slug>/ dirs derived from ledger cwds, [] if none
//     profile:        string,   // current PROMPT-PROFILE.md content (so miners don't re-propose it)
//     outPath:        string,   // ~/.claude/enhance/PROFILE-amendments.md (absolute)
//     maxCandidates:  number,   // cap on rules to verify (default 10)
//   }

export const meta = {
  name: 'leopold-enhance-learn',
  description:
    'Mine the enhancement ledger + session transcripts for prompts the enhancer misread and gate misfires; skeptic-verify each candidate; distill the survivors into prompt-profile amendments the human can apply.',
  phases: [
    { title: 'Mine' },
    { title: 'Cluster' },
    { title: 'Verify' },
    { title: 'Distill' },
  ],
}

const a = args || {}
const ledgerPaths = Array.isArray(a.ledgerPaths) ? a.ledgerPaths : []
const transcriptDirs = Array.isArray(a.transcriptDirs) ? a.transcriptDirs : []
const profile = String(a.profile || '')
const outPath = String(a.outPath || '')
const MAX = Number.isFinite(a.maxCandidates) ? a.maxCandidates : 10

const CANDIDATES_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'evidence', 'kind'],
        properties: {
          rule: { type: 'string', description: 'The profile rule or gate adjustment, phrased concretely ("when I say arruma X I mean lint+types, not a refactor")' },
          evidence: { type: 'string', description: 'The specific ledger entries / corrections that show the pattern, with counts' },
          kind: { type: 'string', enum: ['interpretation', 'gate'], description: 'interpretation = a PROMPT-PROFILE.md line fed to the rewriter; gate = a threshold/lexicon adjustment' },
          source: { type: 'string' },
        },
      },
    },
  },
}

const PROFILE_NOTE = `The CURRENT profile is below — do NOT propose anything it already covers; only propose rules the recorded behavior shows are MISSING:\n---\n${profile.slice(0, 2000)}\n---`

// ── Mine: two independent miners with disjoint lenses ─────────────────────────────
// The correlator reads how the USER REACTED in transcripts; the stats miner never
// leaves the ledger. The same pattern surfacing in both is real signal.
phase('Mine')

const miners = []

if (transcriptDirs.length) {
  miners.push(() => agent(
    `You are mining for prompts the enhancer MISREAD: enhanced prompts the user had to correct right after. Each recurring misread is a prompt-profile rule that was never written down.

The enhancement ledger (JSONL, one entry per enhancement; fields: ts, session_id, prompt_excerpt, cwd, injected, score, signals):
${ledgerPaths.map((p) => `- ${p}`).join('\n')}

The session transcript directories (files are <session_id>.jsonl, one JSON message per line; they are LARGE — use grep/jq-style extraction, never read whole files):
${transcriptDirs.map((p) => `- ${p}`).join('\n')}

The join recipe:
1. Take ledger entries with "injected":true. Each has ts, session_id, prompt_excerpt.
2. The transcript is <dir>/<session_id>.jsonl (if absent, grep the dir's *.jsonl for the session id).
3. Anchor: the "type":"user" line whose text starts with the prompt_excerpt, timestamp within ±120s of the ledger ts.
4. Scan the next 1-2 "type":"user" messages after the anchor. Flag a CORRECTION when any of: bilingual correction cues ("no,", "não", "not what I", "I meant", "eu quis dizer", "na verdade", "actually", "instead", "wrong", "errado", "undo", "desfaz", "reverte", "stop", "para"); an interruption marker ("[Request interrupted by user]"); or a restatement (the next user message shares half the enhanced prompt's content words and is 2x+ longer — the user re-explaining themselves).

From the corrections, derive rules of kind "interpretation" ('when I say "arruma X" I mean lint+types, not a refactor — corrected 3 times') or kind "gate" ('never enhance my prompts about <topic>; the interpretation was wrong twice'). Ignore one-offs. ${PROFILE_NOTE}

Return up to 8 candidates; evidence must cite the actual prompts and correction phrasings with counts.`,
    { label: 'mine:corrections', phase: 'Mine', schema: CANDIDATES_SCHEMA },
  ))
}

miners.push(() => agent(
  `You are mining an enhancement ledger for STATISTICAL gate misfires — no transcripts, only the ledger itself.

Ledger files (JSONL; fields: ts, session_id, cwd, prompt_excerpt, words, score, signals {short, structure, anchor, vague, question}, mode, model, latency_ms, injected, injected_chars, error):
${ledgerPaths.map((p) => `- ${p}`).join('\n')}

Look for: signal combinations or score bands that dominate the FAILED set (injected:false — timeouts, exits) vs the healthy set; projects (cwd) or prompt shapes that get enhanced far more than others (possible false-positive pocket); recurring prompt_excerpt patterns that keep scoring right at the threshold; latency outliers by mode. Propose kind "gate" adjustments (a threshold value, a lexicon addition, a skip rule) with counts as evidence. Only patterns with 3+ occurrences. ${PROFILE_NOTE}

Return up to 8 candidates.`,
  { label: 'mine:ledger-stats', phase: 'Mine', schema: CANDIDATES_SCHEMA },
))

// Barrier is justified: clustering needs ALL miners' candidates at once.
const mined = (await parallel(miners)).filter(Boolean).flatMap((r) => r.candidates || [])
log(`mined ${mined.length} raw candidate(s) from ${miners.length} miner(s)`)

if (mined.length === 0) {
  return { proposed: 0, outPath: null, note: 'No recurring patterns found — the enhancer is reading your prompts the way you mean them.' }
}

// ── Cluster: merge duplicates across miners (cross-miner repeats are the gold) ────
phase('Cluster')
const clustered = await agent(
  `Cluster these candidate prompt-profile rules mined by different miners. Merge duplicates and near-duplicates into one rule each (keep the sharpest phrasing, concatenate the evidence, preserve the kind, and note when a pattern appeared in BOTH independent miners — that is the strongest signal). Drop anything vague, untestable, or trivially one-off. Keep at most ${MAX}, strongest first.

Candidates (JSON):
${JSON.stringify(mined, null, 2)}`,
  { label: 'cluster', phase: 'Cluster', schema: CANDIDATES_SCHEMA },
)
const candidates = (clustered?.candidates || []).slice(0, MAX)
log(`clustered to ${candidates.length} distinct candidate(s)`)

// ── Verify: one skeptic per candidate, prompted to KILL it ────────────────────────
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
    `You are a skeptic judging whether a mined rule deserves to enter the user's prompt profile — the file a rewriter uses to interpret every weak prompt this user types, in every project. Default to keep=false; a wrong rule warps every future interpretation.

Candidate (kind: ${c.kind}): ${c.rule}
Evidence: ${c.evidence}

Kill it if ANY of these hold — the ledger files are readable if you need to recount:
1. The current profile already covers it (excerpt): ${profile.slice(0, 1200)}
2. The evidence is a one-off dressed up as a pattern (fewer than 2 independent occurrences).
3. It is too vague to change an interpretation or a gate decision ("be more careful" changes nothing).
4. It encodes a temporary project circumstance, not a durable habit of how this user writes prompts.
5. Its kind is wrong (an interpretation rule disguised as a gate tweak, or vice versa) — kill and say so.

If it survives, refine it into its most concrete phrasing (profile style: '- "sobe" means deploy to staging, never production', not '- be careful with deploys').`,
    { label: `verify:${c.rule.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => ({ c, v })),
))

const survivors = verified
  .filter(Boolean)
  .filter(({ v }) => v.keep)
  .map(({ c, v }) => ({ rule: (v.refined || c.rule).trim(), evidence: c.evidence, kind: c.kind, why: v.why || '' }))
log(`${survivors.length}/${candidates.length} candidate(s) survived the skeptic`)

if (survivors.length === 0) {
  return { proposed: 0, outPath: null, note: `All ${candidates.length} candidates were killed by the skeptic — no amendment proposed.` }
}

// ── Distill: write the proposal file (NOT the profile itself) ─────────────────────
phase('Distill')
await agent(
  `Write a prompt-profile amendment proposal to the file ${outPath} (create parent dirs if needed). This is a PROPOSAL for the human — do NOT touch PROMPT-PROFILE.md, state.json, or any other file.

Format:
# Prompt-profile amendments (proposed by /leopold-enhance learn)

> Each rule below was mined from your enhancement ledger, verified by a skeptic,
> and is NOT yet in your profile. Review: fold "interpretation" rules into
> ~/.claude/enhance/PROMPT-PROFILE.md as "- rule" lines; apply "gate" adjustments
> to ~/.claude/enhance/state.json thresholds yourself. This file is safe to delete.

Then one section per rule:
## <the rule, one line>
- **Kind:** <interpretation | gate>
- **Evidence:** <the evidence>
- **Why it survived review:** <the why>

The rules (JSON):
${JSON.stringify(survivors, null, 2)}

After writing, return the single word: written`,
  { label: 'distill', phase: 'Distill' },
)

return {
  proposed: survivors.length,
  outPath,
  rules: survivors.map((s) => ({ rule: s.rule, kind: s.kind })),
  note: 'Proposal written. The profile itself was NOT modified — review the file and fold in what sounds like you.',
}
