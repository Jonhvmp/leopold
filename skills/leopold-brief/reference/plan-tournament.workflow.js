// Plan tournament — draft the PLAN from three angles before committing to one.
//
// A plan drafted once inherits its author's first framing. For a substantial
// mission, three independent drafters (MVP-first / risk-first / user-journey-first)
// explore the solution space wider than one pass ever will; judges score each
// draft against the mission and charter, and a synthesizer builds the final plan
// from the winner's skeleton grafted with the best ideas of the runners-up.
//
// args shape (the brief skill fills this):
//   {
//     mission: string,     // the mission being planned (full text)
//     charter: string,     // decision preferences (full text)
//     projectDir: string,  // repo root, so drafters can ground items in real files
//     constraints: string, // plan format rules (checkbox items, (after: N) markers, sizing)
//   }

export const meta = {
  name: 'leopold-plan-tournament',
  description:
    'Draft the Leopold PLAN from three independent angles (MVP-first, risk-first, user-journey-first), judge the drafts against the mission and charter, and synthesize the winner with the best ideas of the runners-up.',
  phases: [
    { title: 'Draft' },
    { title: 'Judge' },
    { title: 'Synthesize' },
  ],
}

const a = args || {}
const mission = String(a.mission || '')
const charter = String(a.charter || '')
const projectDir = String(a.projectDir || '.')
const constraints = String(a.constraints || '')

const ANGLES = [
  {
    key: 'mvp-first',
    stance:
      'MVP-FIRST: the smallest end-to-end slice that proves the mission works ships as early as possible; everything else layers on top of a running system. Front-load whatever creates a walking skeleton.',
  },
  {
    key: 'risk-first',
    stance:
      'RISK-FIRST: the items most likely to sink the mission — unknown APIs, integrations, migrations, performance cliffs — come first, while there is still room to change course. Cheap and certain work goes last.',
  },
  {
    key: 'user-first',
    stance:
      'USER-JOURNEY-FIRST: order by what the end user touches, most important journey first; each item completes a visible piece of that journey. Internal plumbing exists only in service of a journey item.',
  },
]

const DRAFT_SCHEMA = {
  type: 'object',
  required: ['plan', 'rationale'],
  properties: {
    plan: { type: 'array', items: { type: 'string' }, description: 'Ordered plan items, each a single "- [ ]"-ready line (marker included when needed)' },
    rationale: { type: 'string', description: 'Why this ordering, 3-5 sentences' },
  },
}

phase('Draft')
const drafts = (await parallel(ANGLES.map((angle) => () =>
  agent(
    `Draft a Leopold PLAN for this mission from one deliberate stance.

Your stance — commit to it fully; the other stances have their own drafters:
${angle.stance}

MISSION:
${mission}

CHARTER (the user's decision preferences):
${charter.slice(0, 3000)}

Ground the items in the REAL repo at ${projectDir}: check what exists (read-only) so items name actual files/modules and are sized honestly.

Plan format rules:
${constraints}

Return the ordered item list and your rationale.`,
    { label: `draft:${angle.key}`, phase: 'Draft', schema: DRAFT_SCHEMA },
  ).then((d) => (d ? { angle: angle.key, ...d } : null)),
))).filter(Boolean)

if (drafts.length === 0) return { winner: null, note: 'No drafter produced a plan.' }
log(`${drafts.length} draft(s) produced`)

// ── Judge: every draft scored by two independent judges (barrier: comparative) ──
phase('Judge')
const SCORE_SCHEMA = {
  type: 'object',
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['angle', 'score'],
        properties: {
          angle: { type: 'string' },
          score: { type: 'number', description: '0-10' },
          strongest: { type: 'string', description: 'The single best idea in this draft worth keeping even if it loses' },
          weakest: { type: 'string' },
        },
      },
    },
  },
}

const judgePrompt = (lens) =>
  `You are judging ${drafts.length} candidate plans for the same mission. Score each 0-10 through this lens: ${lens}. Comparative judgment — read all drafts before scoring any. For each, also name its single strongest idea (worth grafting even if the draft loses) and its weakest point.

MISSION:\n${mission.slice(0, 2500)}\n
CHARTER:\n${charter.slice(0, 2000)}\n
DRAFTS (JSON):\n${JSON.stringify(drafts, null, 2)}`

const judgments = (await parallel([
  () => agent(judgePrompt('DELIVERY REALISM — will this ordering actually reach done? Are items honestly sized, dependencies real, verification built in?'), { label: 'judge:realism', phase: 'Judge', schema: SCORE_SCHEMA }),
  () => agent(judgePrompt('MISSION FIT — does this ordering serve the definition of done and the charter\'s priorities, not the drafter\'s aesthetic?'), { label: 'judge:mission-fit', phase: 'Judge', schema: SCORE_SCHEMA }),
])).filter(Boolean)

const totals = new Map()
for (const j of judgments) {
  for (const s of j.scores || []) {
    totals.set(s.angle, (totals.get(s.angle) || 0) + (Number(s.score) || 0))
  }
}
const ranked = drafts
  .map((d) => ({ ...d, total: totals.get(d.angle) || 0 }))
  .sort((x, y) => y.total - x.total)
const winner = ranked[0]
const grafts = judgments.flatMap((j) => (j.scores || []).filter((s) => s.angle !== winner.angle).map((s) => s.strongest)).filter(Boolean)
log(`winner: ${winner.angle} (${winner.total} pts) — grafting ${grafts.length} idea(s) from runners-up`)

// ── Synthesize ───────────────────────────────────────────────────────────────────
phase('Synthesize')
const FINAL_SCHEMA = {
  type: 'object',
  required: ['plan'],
  properties: {
    plan: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'What was grafted from the runners-up and why' },
  },
}

const final = await agent(
  `Synthesize the final Leopold PLAN. Start from the winning draft's skeleton and graft in the runner-up ideas below where they genuinely improve it (drop any that don't fit — grafting is not obligatory). Re-check dependency markers after grafting.

Plan format rules:\n${constraints}

WINNING DRAFT (${winner.angle}):\n${JSON.stringify(winner.plan, null, 2)}\nIts rationale: ${winner.rationale}

IDEAS FROM RUNNERS-UP worth considering:\n${grafts.map((g, i) => `${i + 1}. ${g}`).join('\n')}`,
  { label: 'synthesize', phase: 'Synthesize', schema: FINAL_SCHEMA },
)

return {
  winner: winner.angle,
  ranking: ranked.map((d) => ({ angle: d.angle, total: d.total })),
  plan: final?.plan || winner.plan,
  notes: final?.notes || '',
}
