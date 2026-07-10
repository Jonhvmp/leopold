// Leopold — brief compiled into a dynamic workflow.
//
// This is the CANONICAL shape /leopold-workflow generates. The compiler reads the
// brief from .leopold/ and passes it in as `args`; the script below turns the plan
// into a governed, resumable, adversarially-verified run — with git locked the whole
// time (a workflow never commits; agents stage work, the human commits).
//
// Why compile the brief into a workflow at all:
//   - The PLAN lives in CODE, not a single growing context window. That structurally
//     kills the three failure modes Anthropic names for long single-context runs:
//     agentic laziness (declaring done at 35/50), self-preferential bias (grading your
//     own work), and goal drift (losing the charter across compactions).
//   - Every item gets an INDEPENDENT adversarial review with its own clean context.
//   - The run is resumable and shows up in /workflows with a live phase tree.
//
// args shape (the compiler fills this from .leopold/):
//   {
//     mission:        string,   // .leopold/MISSION.md (first section is enough)
//     charter:        string,   // .leopold/CHARTER.md — the decider
//     waves:          Array<Array<{                    // dependency-ordered waves
//                       id: string, text: string,      // the plan item
//                       effort: 'low'|'medium'|'high'|'xhigh'|'max',
//                       critical: boolean,             // billing/auth/migrations → 2nd+ reviewer
//                       sensitive: boolean,            // security-sensitive diff → security lens
//                     }>>,
//     maxReviewRounds: number,  // default 2
//   }

export const meta = {
  name: 'leopold-run',
  description:
    'Conduct a Leopold brief as a dynamic workflow: implement each plan item, adversarially verify it against the charter, loop until the plan is done — git stays locked (nothing is committed).',
  phases: [
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

const brief = args || {}
const mission = String(brief.mission || '').trim()
const charter = String(brief.charter || '').trim()
const waves = Array.isArray(brief.waves) ? brief.waves : []
const MAX_REVIEW = Number.isFinite(brief.maxReviewRounds) ? brief.maxReviewRounds : 2
const items = waves.flat()

// The charter is the decider. Every agent carries it so it decides the way the user
// would instead of stopping to ask — and never touches git.
const CHARTER_BLOCK = `=== MISSION ===\n${mission}\n\n=== CHARTER (decide the way this says the user would) ===\n${charter}\n\nHARD RULES: never \`git commit\`/\`git push\`/publish (stage and report). Never edit files outside this project. Decide reversible or charter-clear forks yourself; only a genuinely irreversible AND charter-ambiguous fork is a reason to stop.`

function implPrompt(item, feedback) {
  return `${CHARTER_BLOCK}

Work on this plan item now, completely and verified (build, lint, tests as the item needs):

  ${item.text}
${feedback ? `\nA prior review found blocking issues — fix every one first:\n${feedback}\n` : ''}
Make the edits in the repo. Do NOT commit. When it is genuinely done and verified, return a one-paragraph summary of what changed and how you verified it.`
}

// Adversarial reviewer. Each lens is a distinct skeptic with its own clean context —
// this is the structural fix for self-preferential bias (a fresh agent did NOT write
// the code it is judging).
function reviewPrompt(item, lens) {
  const lensLine = {
    correctness: 'Focus on correctness: logic bugs, broken edge cases, unhandled errors, off-by-one, wrong assumptions.',
    security: 'Focus on security: injection, authn/authz, secret handling, data exposure, unsafe defaults. Run /security-review rigor.',
    'does-it-actually-work': 'Focus on whether it actually works end to end: was it really verified, or only claimed? Would the build/tests pass?',
  }[lens] || 'Review for correctness and obvious defects.'
  return `You are a Leopold review gate: a strict, independent senior reviewer. You did NOT write this code. Review ONLY the current uncommitted diff for the plan item:

  ${item.text}

Steps:
1. Run \`git --no-pager diff HEAD\` (and \`--stat\`) to see the change; read surrounding code as needed.
2. If /code-review is available, invoke it and fold its findings in. ${lensLine}
3. Be conservative — an empty blocking list is the right answer for a clean diff. "blocking" = a real correctness/security defect a maintainer would refuse to merge; nits are not blocking.

Do NOT edit, commit, or push. Return the JSON verdict.`
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['ok', 'blocking'],
  properties: {
    ok: { type: 'boolean' },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        required: ['issue'],
        properties: { file: { type: 'string' }, issue: { type: 'string' } },
      },
    },
    summary: { type: 'string' },
  },
}

// One plan item: implement → adversarial verify → fix, looping up to MAX_REVIEW rounds.
// The `role:key` label scheme (`impl:<id>` / `verify:<id>:<lens>`) is also the edge-hint
// channel the Leopold Canvas reads: leopold-watch's /api/graph links each verify node
// to the exact impl node sharing its <id>, so the DAG is precise, not phase-approximate.
async function runItem(item) {
  let feedback = ''
  let round = 0
  for (;;) {
    await agent(implPrompt(item, feedback), { label: `impl:${item.id}`, phase: 'Execute', effort: item.effort })

    // Critical/sensitive items face a panel of diverse-lens skeptics; ordinary items
    // get a single correctness reviewer. Refute-to-converge: any blocking finding
    // sends the item back for a fix.
    const lenses = item.critical
      ? ['correctness', 'security', 'does-it-actually-work']
      : item.sensitive
        ? ['correctness', 'security']
        : ['correctness']

    const verdicts = await parallel(
      lenses.map((lens) => () =>
        agent(reviewPrompt(item, lens), {
          label: `verify:${item.id}:${lens}`,
          phase: 'Verify',
          schema: REVIEW_SCHEMA,
          effort: item.sensitive || item.critical ? 'high' : 'medium',
        }),
      ),
    )

    // Union blocking findings across lenses, de-duplicated by file+issue.
    const seen = new Set()
    const blocking = []
    for (const v of verdicts.filter(Boolean)) {
      for (const b of v.blocking || []) {
        const key = `${b.file || '?'}::${b.issue}`.toLowerCase()
        if (!seen.has(key)) { seen.add(key); blocking.push(b) }
      }
    }

    if (blocking.length === 0) return { id: item.id, text: item.text, done: true, rounds: round }
    round += 1
    if (round > MAX_REVIEW) {
      log(`item ${item.id}: still ${blocking.length} blocking after ${MAX_REVIEW} rounds — leaving for the human.`)
      return { id: item.id, text: item.text, done: false, rounds: round, blocking }
    }
    feedback = blocking.map((b, i) => `${i + 1}. [${b.file || '?'}] ${b.issue}`).join('\n')
    log(`item ${item.id}: ${blocking.length} blocking (round ${round}/${MAX_REVIEW}) → fixing`)
  }
}

phase('Plan')
log(`Leopold: ${items.length} plan item(s) across ${waves.length} dependency wave(s). Git is locked — nothing will be committed; work is left staged for you.`)

// Waves run in dependency order. Items WITHIN a wave are independent by construction
// (no `(after:)` marker links them), so they could be parallelized — but because
// workflow agents edit the real working tree, running them serially avoids cross-item
// tree conflicts. For a wave whose items touch strictly disjoint files, flip this to
// `parallel(wave.map(item => () => runItem(item)))` with worktree isolation on the
// impl agent (see the skill's "Advanced: worktree-parallel" note).
const results = []
for (let w = 0; w < waves.length; w++) {
  const wave = waves[w]
  log(`— wave ${w + 1}/${waves.length}: ${wave.length} item(s)`)
  for (const item of wave) {
    const r = await runItem(item)
    results.push(r)
    log(`  ${r.done ? '✓' : '✗'} ${item.id}: ${item.text}`)
  }
}

phase('Report')
const done = results.filter((r) => r.done)
const incomplete = results.filter((r) => !r.done)
return {
  mission: mission.split('\n').find((l) => l.trim() && !l.startsWith('#')) || mission.split('\n')[0] || '',
  total: results.length,
  done: done.length,
  incomplete: incomplete.map((r) => ({ item: r.text, blocking: r.blocking || [] })),
  note: 'Everything is staged for your review; nothing was committed. Commit what you approve.',
}
