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
//     autonomy:       'ask',    // OPTIONAL — present ONLY when the brief opted out of
//                               // full autonomy, so a plan that did not is byte-identical
//     graph:          {                                // OPTIONAL — see below
//                       nodes: Array<{
//                         index: number, id: string, text: string, done: boolean,
//                         kind: 'work'|'gate'|'human'|'tool'|'verify'|'feedback',
//                         label: string,
//                         deps: number[],               // `(after: N)` — static edges
//                         needs: string[],              // `@needs key`
//                         emits: Array<{key,value}>,    // `@emit key=value`
//                         routes: Array<{               // `@on <cond> -> <target>`
//                           when: string, target: number,
//                           kind: 'status'|'signal', key?, op?, value?,
//                         }>,
//                         effort, critical, sensitive,
//                       }>,
//                     },
//   }
//
// TWO LOOPS, ONE SCRIPT.
//   `graph` ABSENT — the plan is the flat checklist Leopold has always run, and the
//   wave loop below runs it exactly as it has always run it. The compiler only emits
//   `graph` when the plan actually authors one (a node kind, an `@on`, an `@emit`, a
//   `@needs`), so every brief written before this grammar existed takes this path with
//   a byte-identical payload and an identical execution.
//
//   `graph` PRESENT — the routed loop runs instead: it dispatches from the same
//   deterministic routing function the driver's scheduler uses, so /leopold-workflow
//   and /leopold-run take the SAME path through the SAME plan. Routing is pure — given
//   a graph and a state, the next node is a function, never a model's opinion. A model
//   may EMIT A SIGNAL; only the graph decides where that signal leads.
//
// THE REPOSITORY IS THE TRUTH OF WHAT WAS BUILT; THE CHANNEL IS THE TRUTH OF WHAT WAS
// DECIDED. `state.signals` carries decision words only (`migrated=false`); work product
// stays in git, staged, exactly as before. A node may only write the keys its own
// `@emit` lines declare — anything else is refused and reported.

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

// `args` normally arrives as a real object. Accept a JSON string too: a stringified
// payload would otherwise leave `waves` empty, and the run would report "0 items done,
// nothing committed" — which reads exactly like a clean finish.
const brief = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const mission = String(brief.mission || '').trim()
const charter = String(brief.charter || '').trim()
const waves = Array.isArray(brief.waves) ? brief.waves : []
const MAX_REVIEW = Number.isFinite(brief.maxReviewRounds) ? brief.maxReviewRounds : 2
const items = waves.flat()

// NOTHING HALTS, unless the brief asked for it. Under the default `full`, a `@human`
// node runs under a role Leopold synthesizes for it; under `ask` it stops the run and
// hands the seat back, exactly as this script has always done. Same toggle, same
// default and same word as the driver's `autonomy: full | ask` — a plan must mean the
// same thing on both engines.
const AUTONOMY = String(brief.autonomy || 'full').trim().toLowerCase() === 'ask' ? 'ask' : 'full'

// The authored graph, or null for a plain checklist. Null is the backward-compatible
// path and everything below guards on it.
const nodes = brief.graph && Array.isArray(brief.graph.nodes) && brief.graph.nodes.length
  ? brief.graph.nodes.map((n) => ({
      ...n,
      deps: Array.isArray(n.deps) ? n.deps : [],
      needs: Array.isArray(n.needs) ? n.needs : [],
      emits: Array.isArray(n.emits) ? n.emits : [],
      routes: Array.isArray(n.routes) ? n.routes : [],
      kind: n.kind || 'work',
    }))
  : null

// The charter is the decider. Every agent carries it so it decides the way the user
// would instead of stopping to ask — and never touches git.
const CHARTER_BLOCK = `=== MISSION ===\n${mission}\n\n=== CHARTER (decide the way this says the user would) ===\n${charter}\n\nHARD RULES: never \`git commit\`/\`git push\`/publish (stage and report). Never edit files outside this project. Decide reversible or charter-clear forks yourself; only a genuinely irreversible AND charter-ambiguous fork is a reason to stop.`

// What the plan lets THIS node decide. An item with no `@emit` produces the empty
// string, so its prompt is byte-identical to the one this script has always built.
function signalsBlock(item) {
  const emits = item.emits || []
  const keys = [...new Set(emits.map((e) => e.key))]
  if (!keys.length) return ''
  const shape = emits.map((e) => `"${e.key}": "${e.value}"`).join(', ')
  return `\nSignals — this item declares ${keys.map((k) => `\`${k}\``).join(', ')}. The plan ROUTES on ${keys.length > 1 ? 'them' : 'it'}, so state what you decided in the \`signals\` field of your JSON result, shaped like { ${shape} }.
Report the value that is actually TRUE of what you did, not the one you hoped for. A signal is a decision (one short word or number), never work product — code, diffs and files belong in the repository, and any key this item did not declare is refused.
`
}

// The item's @scenario acceptance lines, rendered for a prompt. Empty string for an item
// that declares none, so such items' prompts stay byte-identical to what this script has
// always built. These lines are load-bearing: the compiler once dropped them and every
// conformance check downstream passed vacuously (issue #60) — the implementer builds to
// them, the reviewer judges against them.
function scenariosBlock(item, framing) {
  const list = item.scenarios || []
  if (list.length === 0) return ''
  return `\n${framing}\n${list.map((s) => `  @scenario ${s}`).join('\n')}\n`
}

// `decide` is set ONLY on a node that reached a persona path (today: `@human` under
// `autonomy: full`). Without it `personaAppend` and `decisionAsk` are both the empty
// string, so the prompt is byte-identical to the one this script has always built.
function implPrompt(item, feedback, decide) {
  return `${CHARTER_BLOCK}${personaAppend(decide && decide.persona)}

Work on this plan item now, completely and verified (build, lint, tests as the item needs):

  ${item.text}
${scenariosBlock(item, 'It is done ONLY when every one of these acceptance cases holds:')}${feedback ? `\nA prior review found blocking issues — fix every one first:\n${feedback}\n` : ''}${signalsBlock(item)}${decisionAsk(decide)}
Make the edits in the repo. Do NOT commit. When it is genuinely done and verified, return a one-paragraph summary of what changed and how you verified it.`
}

// A work node that may emit returns JSON instead of prose, so its decision reaches the
// router as data. Only such nodes get a schema; every other impl agent is unchanged.
const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: { summary: { type: 'string' }, signals: { type: 'object' } },
}

// A node deciding on a human's behalf reports the CALL alongside the work — the three
// fields DECISIONS.md needs, and the reason this engine can write the same entry the
// driver writes. `reversal` is required by the schema because an autonomous decision
// with no way back is the one shape this project does not ship.
const DECISION_SCHEMA = {
  type: 'object',
  required: ['summary', 'decision', 'reversal'],
  properties: {
    summary: { type: 'string' }, signals: { type: 'object' },
    decision: { type: 'string' }, why: { type: 'string' }, reversal: { type: 'string' },
  },
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
${scenariosBlock(item, 'The item declares these acceptance cases — an unmet one IS a blocking finding:')}
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
async function runItem(item, decide) {
  let feedback = ''
  let round = 0
  let decided
  const emits = item.emits || []
  for (;;) {
    const implOpts = { label: `impl:${item.id}`, phase: 'Execute', effort: item.effort }
    if (decide) implOpts.schema = DECISION_SCHEMA
    else if (emits.length) implOpts.schema = IMPL_SCHEMA
    const built = await agent(implPrompt(item, feedback, decide), implOpts)

    // A dead implementer (skipped by the user, or a terminal API error after retries)
    // returns null. Reviewing that is worse than useless: it leaves an empty diff, the
    // reviewer correctly finds nothing blocking, and the item closes as DONE — a false
    // green on work that never happened. Charge the round and retry instead; if the
    // budget runs out, the item is reported incomplete, which is the honest answer.
    if (built === null) {
      round += 1
      log(`item ${item.id}: the implement agent died (round ${round}/${MAX_REVIEW}) — not reviewing an empty diff`)
      if (round > MAX_REVIEW) {
        return {
          id: item.id, text: item.text, done: false, rounds: round,
          blocking: [{ issue: 'the implement agent never returned — nothing was built for this item' }],
        }
      }
      continue
    }

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

    // What the node says it decided. Only a node that declared `@emit` is even asked,
    // and settleNode below refuses anything it did not declare.
    const reported = built && typeof built === 'object' && built.signals && typeof built.signals === 'object'
      ? built.signals
      : undefined

    // The call this node made on the human's behalf, kept across review rounds: a fix
    // round re-states it, and if a later round states none the earlier one still stands.
    // A persona path that decided and left no entry is the failure mode this closes, so
    // the record survives everything except never having decided at all.
    if (decide) decided = readDecision(built, decide) || decided

    if (blocking.length === 0) return { id: item.id, text: item.text, done: true, rounds: round, signals: reported, decision: decided }
    round += 1
    if (round > MAX_REVIEW) {
      log(`item ${item.id}: still ${blocking.length} blocking after ${MAX_REVIEW} rounds — leaving for the human.`)
      return { id: item.id, text: item.text, done: false, rounds: round, blocking, signals: reported, decision: decided }
    }
    feedback = blocking.map((b, i) => `${i + 1}. [${b.file || '?'}] ${b.issue}`).join('\n')
    log(`item ${item.id}: ${blocking.length} blocking (round ${round}/${MAX_REVIEW}) → fixing`)
  }
}

// ---------------------------------------------------------------------------
// The routed engine. Everything below only runs when the plan authored a graph.
// ---------------------------------------------------------------------------

// A GATE or VERIFY node judges the work; it never edits it. Same review-only authority
// the driver gives these kinds, so a plan means the same thing on both engines.
function gatePrompt(node) {
  const focus = node.kind === 'verify'
    ? 'This is a VERIFY node: prove the work actually holds. Re-run what the item needs (build, lint, tests) READ-ONLY and judge the evidence, not the claim. "It should work" is a fail; a green run you executed yourself is a pass.'
    : `This is a GATE node${node.label ? ` labelled "${node.label}"` : ''}: judge the uncommitted diff against the concern this item states. Be specific and conservative — name the file and the defect, and pass a clean diff instead of inventing work.`
  return `${CHARTER_BLOCK}

You are a Leopold ${node.kind.toUpperCase()} node. You did NOT write this code and you may NOT edit it — no Edit/Write, no fixes, no commits. ${focus}

  ${node.text}

Start from the change itself: \`git --no-pager diff HEAD\` (and \`--stat\`). Read surrounding code as needed; read-only shell is yours.
${signalsBlock(node)}
Return the JSON verdict: \`ok\` true only if this node PASSES.`
}

// A TOOL node is a command, not an opinion. The driver runs it directly with no model
// turn; a workflow script has no shell of its own, so the command goes to a agent that
// may do nothing but run it and report the exit status. Either way the plan routes on
// the same `exit` signal.
function toolPrompt(node) {
  const m = String(node.text).match(/`([^`]+)`/)
  const command = (m ? m[1] : node.text).trim()
  return {
    command,
    prompt: `${CHARTER_BLOCK}

You are a Leopold TOOL node. Run EXACTLY this command in the repository root, once, and report what happened. Do not fix anything, do not edit any file, do not commit, and do not run anything else:

  ${command}

Return the JSON verdict with the command's real exit status — 0 only if it genuinely exited 0.`,
  }
}

const GATE_SCHEMA = {
  ...REVIEW_SCHEMA,
  properties: { ...REVIEW_SCHEMA.properties, signals: { type: 'object' } },
}
const TOOL_SCHEMA = {
  type: 'object',
  required: ['exit'],
  properties: { exit: { type: 'number' }, output: { type: 'string' } },
}

// The signal a `@tool` node always reports: its command's exit status. Implicitly
// declared, exactly as in the driver — `@on exit=0 -> 5` works with no `@emit` line.
const TOOL_EXIT_SIGNAL = 'exit'

async function runGateNode(node) {
  // `node:<kind>:<id>` — a PLAN node of that kind, kept clear of the review gate's
  // `verify:<id>:<lens>` labels so the two can never be read as each other.
  const v = await agent(gatePrompt(node), {
    label: `node:${node.kind}:${node.id}`, phase: 'Verify', schema: GATE_SCHEMA,
    effort: node.critical || node.sensitive ? 'high' : node.effort,
  })
  const blocking = (v && v.blocking) || []
  const ok = !!(v && v.ok) && blocking.length === 0
  return {
    id: node.id, text: node.text, done: ok, rounds: 0,
    blocking: ok ? undefined : (blocking.length ? blocking : [{ issue: `the ${node.kind} node did not pass` }]),
    signals: v && typeof v.signals === 'object' ? v.signals : undefined,
  }
}

async function runToolNode(node) {
  const { command, prompt } = toolPrompt(node)
  if (!command) {
    // Never silently "handled": a tool node with nothing to run is a plan defect, and
    // it fails as one instead of passing as a no-op.
    return {
      id: node.id, text: node.text, done: false, rounds: 0,
      blocking: [{ issue: 'the @tool node declares no command — its text (or a backticked span in it) IS the command' }],
    }
  }
  const v = await agent(prompt, { label: `node:tool:${node.id}`, phase: 'Execute', schema: TOOL_SCHEMA, effort: 'low' })
  // A dead agent is not a passing command. 127 is the shell's "could not run it".
  const exit = v && Number.isFinite(v.exit) ? Number(v.exit) : 127
  log(`  tool ${node.id}: \`${command}\` exited ${exit}`)
  return {
    id: node.id, text: node.text, done: exit === 0, rounds: 0,
    blocking: exit === 0 ? undefined : [{ issue: `\`${command}\` exited ${exit}` }],
    signals: { [TOOL_EXIT_SIGNAL]: String(exit) },
  }
}

// ---- feedback nodes: the run may improve its own plan, never run away with it ------
// A @feedback node reads the RUN — the plan, the decisions, what has been built so far —
// and PROPOSES amendments. It never applies one: it returns proposals, the bounds below
// decide which survive, and only then is anything written. The bounds are the driver's
// (packages/driver/src/amend.ts), mirrored here in CODE rather than in the prompt,
// because an instruction is a suggestion to a model and a bound is not.
//
//   at most 3 items added per RUN · never delete · never touch a done item ·
//   never edit GUARDRAILS.md · ADD is the only verb · plain work items only
//
// Every accepted amendment gets a DECISIONS.md block with a Reversal line; every
// refusal is logged with the bound that refused it. Same trail, same bounds, both
// engines — which is the whole point of mirroring it.

const MAX_ADDED_ITEMS = 3
const MAX_ITEM_TEXT = 300
const BOUND_RULE = {
  'add-budget': `a feedback node may add at most ${MAX_ADDED_ITEMS} items per run`,
  'no-delete': 'a feedback node may never delete a plan item',
  'no-touch-done': 'a feedback node may never touch an item already marked done',
  'no-guardrails': 'a feedback node may never edit GUARDRAILS.md',
  'add-only': 'a feedback node may only ADD items',
  'work-only': 'a feedback node may only add a plain work item, never a node kind it would then execute',
  malformed: `an added item is one checkbox line of text (at most ${MAX_ITEM_TEXT} characters) whose (after: N) points at an item that exists`,
}
// The run-wide budget. Not per node: three feedback nodes do not get three purses.
let amendmentsAdded = 0

function feedbackPrompt(node) {
  return `${CHARTER_BLOCK}

You are a Leopold FEEDBACK node${node.label ? ` labelled "${node.label}"` : ''}. You READ THE RUN and may propose changes to the plan; you never make them. You may NOT edit any file — no Edit/Write, no fixes, no commits.

  ${node.text}

Your evidence is the run itself: \`.leopold/PLAN.md\`, \`.leopold/DECISIONS.md\`, \`.leopold/events.jsonl\` if it exists, and what has actually been built so far (\`git --no-pager diff --stat HEAD\`). Read them. An opinion with no line from that evidence behind it is not feedback, and "the plan is right, change nothing" is usually the strongest answer — propose nothing rather than inventing work.

THE BOUNDS, enforced in code (a proposal that breaks one is refused and logged, not applied):
- at most ${MAX_ADDED_ITEMS} items may be added per RUN, appended at the end of the plan;
- an item is NEVER deleted, and an item already marked [x] is NEVER touched;
- GUARDRAILS.md is NEVER amended — that boundary is the human's;
- an added item is a plain work item: one line, at most ${MAX_ITEM_TEXT} characters, no \`@gate\`/\`@tool\`/\`@human\`/\`@verify\`/\`@feedback\` marker, and any \`(after: N)\` must point at an item that already exists.

Return the JSON verdict. \`proposals\` is an ordered list, most important first — if you propose more than the budget allows, the later ones are refused. Return an empty list when the plan needs nothing.`
}

const AMEND_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['op', 'text'],
        properties: {
          op: { type: 'string', enum: ['add', 'delete', 'edit', 'guardrails'] },
          text: { type: 'string' },
          target: { type: 'number' },
        },
      },
    },
  },
}

// Strip what a model wraps an item in — a bullet, a checkbox, a heading mark, quotes —
// and collapse it to the single line PLAN.md carries.
function normalizeItemText(text) {
  let t = String(text == null ? '' : text).trim().replace(/\s+/g, ' ')
  t = t.replace(/^[-*+][ \t]+/, '').replace(/^-?[ \t]*\[[ xX]\][ \t]*/, '').replace(/^#+[ \t]*/, '')
  const q = t.match(/^"([\s\S]*)"$|^'([\s\S]*)'$/)
  if (q) t = (q[1] === undefined ? (q[2] === undefined ? '' : q[2]) : q[1]).trim()
  return t.trim()
}

// PURE. Same rules, same order and same bound codes as the driver's judgeAmendments:
// proposals are judged as written, so "the first 3 apply, the rest are refused" is the
// node's own priority order deciding which 3 survive.
function judgeAmendments(proposals, remaining, itemCount, doneSet) {
  const accepted = []
  const refused = []
  let budget = Math.max(0, remaining)
  let count = itemCount
  const refuse = (proposal, bound, detail) =>
    refused.push({ proposal, bound, reason: detail ? `${BOUND_RULE[bound]} — ${detail}` : BOUND_RULE[bound] })

  for (const p of proposals) {
    const op = String((p && p.op) || '').toLowerCase()
    const target = Number.isFinite(p && p.target) ? Number(p.target) : undefined
    if (op === 'guardrails') { refuse(p, 'no-guardrails'); continue }
    if (op === 'delete') { refuse(p, 'no-delete', `it asked to delete ${target ? `item ${target}` : 'an item'}`); continue }
    if (op === 'edit') {
      if (target !== undefined && doneSet.has(target)) refuse(p, 'no-touch-done', `item ${target} is already marked done`)
      else refuse(p, 'add-only', `it asked to edit ${target ? `item ${target}` : 'an item'}`)
      continue
    }
    if (op !== 'add') { refuse(p, 'add-only', `"${op || 'nothing'}" is not an ADD`); continue }

    const text = normalizeItemText(p && p.text)
    if (!text) { refuse(p, 'malformed', 'it added no text'); continue }
    if (text.length > MAX_ITEM_TEXT) { refuse(p, 'malformed', `it is ${text.length} characters`); continue }
    const dep = text.match(/^\((?:after|deps)\s*:\s*([0-9,\s]+)\)\s*/i)
    if (dep) {
      const bad = dep[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && (n < 1 || n > count))
      if (bad.length) { refuse(p, 'malformed', `it depends on item ${bad.join(', ')}, which does not exist`); continue }
    }
    if (/^@/.test(dep ? text.slice(dep[0].length) : text)) { refuse(p, 'work-only', `it declares "${text.slice(0, 40)}"`); continue }
    if (budget <= 0) { refuse(p, 'add-budget', `${MAX_ADDED_ITEMS - Math.max(0, remaining) + accepted.length} already added this run`); continue }

    count += 1
    budget -= 1
    accepted.push({ index: count, text, line: `- [ ] ${text}` })
  }
  return { accepted, refused }
}

/** The DECISIONS.md block one accepted amendment leaves behind — through the SAME
 *  writer every other entry on this engine goes through, so an amendment and a persona
 *  decision cannot end up in two shapes in one file. */
function amendmentDecisionBlock(a, node) {
  return decisionBlock(
    `Plan amended — item ${a.index} added by the @feedback node at item ${node.index}   (${new Date().toISOString()})`,
    [
      ['Fork', `add "${a.text}" to the plan vs leave the plan as the human wrote it`],
      ['Class', 'reversible'],
      ['Charter', `${BOUND_RULE['add-budget']}, never delete, never touch a done item, never edit GUARDRAILS`],
      ['Decision', `appended item ${a.index}: ${a.line}`],
      ['Why', `the @feedback node at item ${node.index} ("${String(node.text).slice(0, 80)}") proposed it from the run's own evidence, and it clears every bound`],
      ['Reversal', `delete the line "${a.line}" at the end of .leopold/PLAN.md — items are appended, so no existing item's index moved`],
    ],
  )
}

/** Persist what the bounds accepted. A workflow script has no filesystem of its own, so
 *  the write goes to an agent — the same delegation a `@tool` node uses — but the agent
 *  gets NO judgement to make: it appends the exact bytes this script computed. */
async function writeAmendments(node, accepted) {
  const planLines = accepted.map((a) => `\n${a.line}\n`).join('')
  const decisions = accepted.map((a) => amendmentDecisionBlock(a, node)).join('')
  await agent(`${CHARTER_BLOCK}

You are applying a Leopold plan amendment that has ALREADY been judged and accepted. Make exactly these two appends and nothing else — no rewording, no reordering, no other edit, no commit:

1. Append to the END of \`.leopold/PLAN.md\`, verbatim:
${planLines}
2. Append to the END of \`.leopold/DECISIONS.md\` (create it if missing), verbatim:
${decisions}

Do not modify any existing line of either file, do not touch \`.leopold/GUARDRAILS.md\`, and do not add anything of your own.`, { label: `node:amend:${node.id}`, phase: 'Execute', effort: 'low' })
}

async function runFeedbackNode(node, doneSet) {
  const v = await agent(feedbackPrompt(node), {
    label: `node:feedback:${node.id}`, phase: 'Verify', schema: AMEND_SCHEMA, effort: node.effort,
  })
  const proposals = v && Array.isArray(v.proposals) ? v.proposals : []
  const result = { id: node.id, text: node.text, done: true, rounds: 0 }
  if (!proposals.length) {
    log(`  feedback ${node.id}: no amendment proposed`)
    return result
  }
  const maxIndex = nodes.reduce((m, n) => Math.max(m, n.index), 0)
  const j = judgeAmendments(proposals, MAX_ADDED_ITEMS - amendmentsAdded, maxIndex, doneSet)
  for (const x of j.refused) log(`  amendment refused [${x.bound}]: ${x.reason}`)
  if (!j.accepted.length) return result

  amendmentsAdded += j.accepted.length
  for (const a of j.accepted) {
    // The added item joins THIS run: an amendment the run cannot execute is a note, not
    // an amendment. Appended, so no existing index moves — exactly as in the driver.
    const added = {
      index: a.index, id: `i${a.index}`, text: a.text, kind: 'work', label: '',
      done: false, deps: [], needs: [], emits: [], routes: [],
      effort: node.effort, critical: false, sensitive: false,
    }
    nodes.push(added)
    byIndex.set(added.index, added)
    log(`  amendment -> item ${a.index} added: ${a.text}`)
  }
  await writeAmendments(node, j.accepted)
  log(`  ${amendmentsAdded}/${MAX_ADDED_ITEMS} plan amendments used this run; each is logged in DECISIONS.md with a Reversal line.`)
  return result
}

// ---- the decision trail: ONE writer, and the shape the driver already writes -------
// /leopold-workflow used to write NO decisions at all: the trail lived in the driver's
// loop (`logDecision`), so the same brief run as a workflow left DECISIONS.md empty —
// 48 agents, zero entries. Everything this engine decides now lands here, in the exact
// block shape packages/driver/src/log.ts writes: `## D<n> — <title>` and six padded
// fields, with Reversal never blank. An auditor reading DECISIONS.md cannot tell which
// engine wrote an entry, only who decided and why — which is the whole point.
//
// ONE WRITER FOR THAT FILE ON THIS ENGINE TOO: a `@feedback` node's plan amendments and
// a persona's decision both build their block with `decisionBlock` and both persist
// through an agent that appends the exact bytes this script computed.

const FIELD_WIDTH = 13
let decisionCounter = 0
/** Every decision this run recorded, in the order it made them. */
const decisionsMade = []

/** One DECISIONS.md block: the heading and its padded fields. */
function decisionBlock(heading, fields) {
  return ['', `## ${heading}`, ...fields.map(([k, v]) => `${`${k}:`.padEnd(FIELD_WIDTH)}${v}`), ''].join('\n')
}

/** Persist decision blocks. A workflow script has no filesystem of its own, so the write
 *  goes to an agent — the same delegation the amendment writer uses — and that agent gets
 *  NO judgement to make: it appends the exact bytes this script computed. */
async function writeDecisionEntries(blocks, label) {
  if (!blocks.length) return
  await agent(`${CHARTER_BLOCK}

You are RECORDING a decision Leopold has already made. Append to the END of \`.leopold/DECISIONS.md\` (create it if it does not exist), verbatim, and make no other change — no rewording, no reordering, no other edit, no commit:
${blocks.join('')}
Do not modify any existing line of that file, do not touch \`.leopold/PLAN.md\` or \`.leopold/GUARDRAILS.md\`, and do not add anything of your own.`, { label, phase: 'Execute', effort: 'low' })
}

// ---- personas: the role Leopold assumes where the plan asked for a person ----------
// Mirrored from packages/driver/src/persona.ts, in CODE and not in a prompt, for the
// same reason the amendment bounds above are mirrored: BOTH ENGINES OR NEITHER. A
// `@human` node that resolves under a synthesized role in the driver and halts here
// would teach the user a lie about their own plan.
//
// TWO HALVES, AND ONLY ONE IS A MODEL CALL: the FIT (a name, the expertise the item
// needs, what it optimizes for) is synthesized; the CONSTRAINTS are lifted from
// CHARTER.md verbatim by `charterHardRules` below, so a model cannot soften or forget
// them. Synthesis is best-effort — any failure returns undefined and the item runs under
// the default prompt, because a run must never die over who it could not decide it was.

const FORK_SITUATION = {
  human: 'a @human node — the plan asked a person to decide this, and no person is coming',
  escalation: 'an escalation — the worker hit a fork it could not settle from the charter',
  repair: 'a broken plan graph — a route points nowhere, or the graph will not validate',
  deadlock: 'a deadlock — items are open, nothing is dispatchable, and the run is waiting on a decision nobody made',
  'repeated-failure': 'repeated failure — the same kind of failure has now happened three times',
}

const MAX_LIST = 6
const MAX_FIELD = 240
const MAX_RULE = 320
const MAX_CHARTER_RULES = 32

const GENERIC_ROLES = new Set([
  'assistant', 'ai assistant', 'ai', 'agent', 'ai agent', 'an agent', 'helper', 'bot',
  'model', 'llm', 'worker', 'generalist', 'expert', 'specialist', 'professional',
  'engineer', 'developer', 'software engineer', 'leopold', 'claude', 'persona',
])

const RULE_HEADING = /^#{1,6}\s*(never|always|hard rules?|rules?|constraints?|non-?goals?|must|do not|don'?t|guardrails?|boundaries)\b/i
const OTHER_HEADING = /^#{1,6}\s+/
const RULE_WORDS = /\b(never|always|must not|must never|may never|cannot|can not|do(?:es)? not|did not|will not|shall not|don'?t|no new|not negotiable|non-negotiable|forbidden|is locked|stays locked|only ever|at most|refuse)\b/i
const LIST_MARKER = /^(?:[-*+]|\d+[.)])[ \t]+/
const HEADING_POLARITY = [
  [/^#{1,6}\s*(never|must not|must never|do not|don'?t)\b/i, 'Never: '],
  [/^#{1,6}\s*(always|must)\b/i, 'Always: '],
  [/^#{1,6}\s*non-?goals?\b/i, 'Non-goal: '],
]

function clip(s, max = MAX_FIELD) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

function listOf(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/\s*[;\n]\s*/) : []
  const out = []
  for (const x of raw) {
    const t = clip(typeof x === 'string' ? x : JSON.stringify(x))
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= MAX_LIST) break
  }
  return out
}

function headingPrefix(heading) {
  for (const [re, prefix] of HEADING_POLARITY) if (re.test(heading)) return prefix
  return ''
}

/** The charter's binding rules, VERBATIM and in the charter's own order — pure,
 *  deterministic, model-free. A wrapped bullet is ONE rule; a rule under `## Never`
 *  carries that heading's polarity, because "Run `git push`" lifted bare under "you are
 *  bound by these" reads as an instruction to run it; and when the cap bites it drops
 *  heuristic prose before it drops a declared prohibition. Same rules, same order and
 *  same output as the driver's charterHardRules. */
function charterHardRules(charter) {
  const candidates = []
  let declaredSection = false
  let sectionPrefix = ''
  let fenced = false
  let block = ''
  let blockDeclared = false
  let blockPrefix = ''

  const flush = () => {
    const text = clip(block.replace(LIST_MARKER, '').trim(), MAX_RULE)
    block = ''
    if (text.length < 4) return
    if (!blockDeclared && !RULE_WORDS.test(text)) return
    candidates.push({ text: blockDeclared ? blockPrefix + text : text, declared: blockDeclared })
  }
  const open = (line) => {
    block = line
    blockDeclared = declaredSection
    blockPrefix = sectionPrefix
  }

  for (const raw of String(charter == null ? '' : charter).split('\n')) {
    const line = raw.trim()
    if (/^```/.test(line)) { flush(); fenced = !fenced; continue }
    if (fenced) continue
    if (!line || /^[-=]{3,}$/.test(line)) { flush(); continue }
    if (OTHER_HEADING.test(line)) {
      flush()
      declaredSection = RULE_HEADING.test(line)
      sectionPrefix = declaredSection ? headingPrefix(line) : ''
      continue
    }
    if (LIST_MARKER.test(line)) { flush(); open(line); continue }
    if (block) block += ' ' + line
    else open(line)
  }
  flush()

  const seen = new Set()
  const unique = candidates.filter((c) => !seen.has(c.text) && (seen.add(c.text), true))
  if (unique.length <= MAX_CHARTER_RULES) return unique.map((c) => c.text)

  const keep = new Set()
  for (const pass of [true, false]) {
    unique.forEach((c, i) => { if (c.declared === pass && keep.size < MAX_CHARTER_RULES) keep.add(i) })
  }
  return unique.filter((_, i) => keep.has(i)).map((c) => c.text)
}

const NO_EXECUTION_CLAUSE =
  'You DECIDE; you do not ship. Two things are enforced for you: the Leopold guard denies `git commit` and `git push` (force-push always), and that is its entire scope — stage the work and say what you decided. EVERYTHING ELSE IS ON YOU, because nothing blocks it: do not run git tag, do not publish a package, do not cut a release, do not open an external PR, and never raise a budget or iteration limit, clear a kill switch, or edit GUARDRAILS.md. Treat those as hard denials even though no hook will stop you.'

const DEFAULT_REVERSAL =
  'Nothing was committed: discard this item\'s staged work (`git restore --staged --worktree .`) and the decision is undone.'
const DEFAULT_WHY =
  'no separate reasoning was stated; the charter rules binding this role are the basis.'
const NO_PERSONA = 'Leopold — no role was synthesized; the default worker rules applied'

const PERSONA_SCHEMA = {
  type: 'object',
  required: ['name', 'role', 'expertise'],
  properties: {
    name: { type: 'string' }, role: { type: 'string' },
    expertise: { type: 'array', items: { type: 'string' } },
    optimizesFor: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
}

function personaPrompt(input) {
  return `You are Leopold, an autonomous orchestrator. A plan item has reached a point that used to wait for a human being. No human is coming: you decide who should do this work, and that role then does it.

Your job right now is ONE thing: synthesize the ROLE this specific item needs. Not the answer — the person.

What makes a real persona:
- A NAME and a specific role title. "An assistant", "an agent", "an engineer" is not a persona, it is the same generic answer with a hat on. If the item is about visual hierarchy, the role is a designer. If it is about a database cutover, the role is a release/data engineer. Fit the role to THIS item's actual subject matter.
- The EXPERTISE this item genuinely needs, concretely (2-4 items). Name real skills, not adjectives.
- What this role OPTIMIZES FOR when it decides (2-4 items), consistent with the mission and the charter below.
- WHY this role fits this item, in one or two lines.

What this role may NOT do, ever, whatever it concludes: git commit, git push, git tag, publish, open an external PR, raise or route around any budget or iteration limit, clear a kill switch, or edit GUARDRAILS.md. It DECIDES; the human ships. A decision it cannot execute is still a decision worth recording.

Do not restate the charter's rules: they are attached to the role in code, verbatim, whatever you write.

${CHARTER_BLOCK}

The run reached this and would previously have stopped for a human.

SITUATION: ${FORK_SITUATION[input.fork] || input.fork}
ITEM: ${clip(input.item, 600)}
WHAT IS ACTUALLY BEING DECIDED: ${clip(input.detail || '', 900) || '(the item as written)'}

Synthesize the role that should take this. Return the JSON object now.`
}

/** One model call, no tools. Returns undefined on anything unusable — an unparseable
 *  answer, a generic role, a dead agent — and the caller then runs the item under the
 *  default prompt rather than the run dying. */
async function synthesizePersona(input, label) {
  let v
  try {
    v = await agent(personaPrompt(input), { label, phase: 'Plan', schema: PERSONA_SCHEMA, effort: 'low' })
  } catch { return undefined }
  if (!v || typeof v !== 'object') return undefined
  const role = clip(typeof v.role === 'string' ? v.role : '', 80)
  const name = clip(typeof v.name === 'string' ? v.name : '', 80)
  const expertise = listOf(v.expertise)
  if (!role || !name || !expertise.length) return undefined
  if (GENERIC_ROLES.has(role.toLowerCase().replace(/[.\s]+$/, ''))) return undefined
  // The binding rules are the CHARTER'S, lifted in code — nothing the model wrote is
  // consulted here. That is what makes "the persona carries the charter's hard rules" a
  // property of this script rather than a hope about a prompt.
  return {
    name, role, expertise,
    optimizesFor: listOf(v.optimizesFor),
    constraints: charterHardRules(charter),
    rationale: clip(typeof v.rationale === 'string' ? v.rationale : '', 400),
    fork: input.fork,
    item: clip(input.item, 300),
  }
}

/** The prompt fragment that ASSUMES the role. Empty for an unsynthesized persona, so the
 *  prompt is byte-identical to the default one when synthesis found nobody. */
function personaAppend(persona) {
  if (!persona) return ''
  const bullets = (xs) => xs.map((x) => `  - ${x}`).join('\n')
  return `

YOU ARE ${persona.name.toUpperCase()} — ${persona.role}.
This item reached ${FORK_SITUATION[persona.fork] || persona.fork}. No human is coming; you have the seat, and you make this call yourself.

- Your expertise:
${bullets(persona.expertise)}
${persona.optimizesFor.length ? `- You optimize for:\n${bullets(persona.optimizesFor)}\n` : ''}- ${persona.rationale || 'This role is what the item needs.'}
- YOU ARE BOUND BY THESE RULES. They come from the project's charter, they are not advice, and a decision that breaks one is wrong however well argued:
${bullets(persona.constraints)}

${NO_EXECUTION_CLAUSE}

Do the work this item asks for, completely, and state the call you made, why the charter supports it, and how to undo it.`
}

/** What a node on a persona path is asked to state. Empty for every other node. */
function decisionAsk(decide) {
  if (!decide) return ''
  return `
This plan item was written for a PERSON to decide. No person is coming: you have the seat, and you make the call yourself — then do the work it implies, completely and verified.
Decide from the mission and the charter, never from what would be easiest. If the decision implies an action this run must not take — git commit, git push, tag, publish, opening a PR — MAKE THE CALL ANYWAY, stage the work, and say plainly that shipping it is the human's step. A decision you do not execute is still a decision worth recording.
Along with your \`summary\`, return \`decision\` (the call you made, one line), \`why\` (the charter/mission basis for it) and \`reversal\` (how a human undoes this, concretely — the file to revert, the flag to flip).
`
}

/** The decision the node stated, normalized. Never returns an entry with an empty
 *  Reversal: a decision with no way back is not done, so there is no path producing one. */
function readDecision(built, decide) {
  if (!built || typeof built !== 'object') return undefined
  const decision = clip(built.decision || '') || clip(built.summary || '')
  if (!decision) return undefined
  return {
    decision,
    why: clip(built.why || '') || DEFAULT_WHY,
    reversal: clip(built.reversal || '') || DEFAULT_REVERSAL,
    persona: decide && decide.persona,
    fork: decide ? decide.fork : 'human',
    item: clip(decide && decide.item ? decide.item : '', 300),
  }
}

/** What bound the role that decided, for the trail's `Charter:` line. */
function charterBasisOf(persona) {
  if (!persona) return 'no persona was synthesized; the default worker rules applied'
  const n = persona.constraints.length
  if (n === 0) return `no binding rule found in CHARTER.md — ${persona.role} decided on the mission alone`
  return `${n} charter rule(s) bind ${persona.role}; first: ${persona.constraints[0]}`
}

/** A persona decision as a DECISIONS.md block — the driver's six fields, in its order,
 *  with none of them blank. `turn` is this run's dispatch ordinal, the workflow's
 *  equivalent of the driver's iteration number. */
function personaDecisionEntry(d, turn) {
  const persona = d.persona
  decisionCounter += 1
  const title = persona ? `${persona.name} decided: ${persona.role}` : 'Leopold decided (no persona synthesized)'
  const fork = (persona && persona.fork) || d.fork
  const item = (persona && persona.item) || d.item
  return decisionBlock(`D${decisionCounter} — ${title}   (turn ${turn}, ${new Date().toISOString()})`, [
    ['Persona', persona ? `${persona.name} — ${persona.role} (${persona.expertise.join('; ')})` : NO_PERSONA],
    ['Fork', `${FORK_SITUATION[fork] || fork || 'an autonomous fork'}${item ? `: ${item}` : ''}`],
    ['Class', 'n/a'],
    ['Charter', charterBasisOf(persona)],
    ['Decision', d.decision],
    ['Why', d.why || DEFAULT_WHY],
    ['Reversal', d.reversal || DEFAULT_REVERSAL],
  ])
}

/** A @human node under `autonomy: full`. The plan asked a person; nobody is coming, so
 *  the role that decision needs is synthesized and the item runs under it — through the
 *  same implement → adversarially verify → fix loop every other work node runs, because
 *  a decision made on someone's behalf deserves MORE scrutiny, not less. The call it
 *  made is then written to DECISIONS.md before the run moves on. */
async function runHumanNode(node) {
  const persona = await synthesizePersona(
    { fork: 'human', item: node.text, detail: node.label ? `The plan labelled this decision "${node.label}".` : '' },
    `node:persona:${node.id}`,
  )
  log(persona
    ? `  persona -> ${persona.name}, ${persona.role} — bound by ${persona.constraints.length} charter rule(s).`
    : '  persona -> not synthesized; the item runs under the default worker prompt.')

  const turn = results.length + 1
  const r = await runItem(node, { fork: 'human', persona, item: node.text })
  const d = r.decision || {
    // The node returned nothing usable. It still decided — it ran with the seat — and an
    // autonomous call with no entry is exactly the failure this closes, so the entry is
    // written from what is known instead of being skipped.
    decision: `ran the @human item "${clip(node.text, 120)}" under ${persona ? `${persona.name}, ${persona.role}` : 'the default worker prompt'} and stated no separate call`,
    why: DEFAULT_WHY, reversal: DEFAULT_REVERSAL, persona, fork: 'human', item: clip(node.text, 300),
  }
  // The block is built first so the entry can carry its `D<n>` — the report points at
  // the exact heading in DECISIONS.md instead of asking the reader to find it.
  const block = personaDecisionEntry(d, turn)
  decisionsMade.push({
    n: decisionCounter, item: node.text,
    persona: persona ? `${persona.name} — ${persona.role}` : NO_PERSONA,
    fork: d.fork || 'human', decision: d.decision, reversal: d.reversal,
  })
  log(`  decided: ${d.decision}`)
  log(`  reversal: ${d.reversal}`)
  await writeDecisionEntries([block], `node:decision:${node.id}`)
  return r
}

// ---- "what I decided for you": the calls, riskiest first ---------------------------
// The trail is complete and nobody reads it at the end of a run that went well, so the
// run says its calls out loud: a few lines at the bottom of the report, riskiest first,
// each naming WHO decided and HOW TO UNDO IT.
//
// Mirrored from packages/driver/src/summary.ts in CODE, for the same reason the persona
// and amendment logic above is mirrored: BOTH ENGINES OR NEITHER. The driver reads the
// order back off DECISIONS.md; this engine has the entries in hand, and the SCORE is the
// same function of the same four inputs — test/decided-for-you.test.ts runs the two side
// by side over one set of decisions and fails if they ever order it differently.
//
// RISK IS ORDERING, NOT A VERDICT: it never hides an entry, and the full trail is one
// line away. With no persona decision the summary is the empty string, so a plain
// checklist's report is byte-for-byte the string it has always been.

const MAX_SUMMARIZED = 5
const FORK_RISK = { escalation: 50, human: 42, deadlock: 34, repair: 30, 'repeated-failure': 22, unknown: 26 }
const HEAVY_SUBJECT = /\b(prod|production|cutover|deploy|deployed|release|releasing|publish|publishing|ship|shipping|migrat\w*|schema|drop\w*|delete\w*|truncat\w*|credential\w*|secret\w*|token|security|breaking|irreversible|data loss|rollback|customer|billing|payment)\b/i

function riskOf(e) {
  let risk = FORK_RISK[e.fork] || FORK_RISK.unknown
  if (e.persona === NO_PERSONA) risk += 14
  if (HEAVY_SUBJECT.test(e.decision)) risk += 12
  if (e.reversal === DEFAULT_REVERSAL) risk += 6
  return risk
}

/** The decisions in reading order, riskiest first; ties keep the order they were made. */
function byRisk(entries) {
  return entries.map((e, i) => ({ e, i })).sort((a, b) => riskOf(b.e) - riskOf(a.e) || a.i - b.i).map((x) => x.e)
}

/** The block that ends the report. Empty for a run that decided nothing on your behalf. */
function decidedForYou(entries) {
  if (!entries.length) return ''
  const shown = entries.slice(0, MAX_SUMMARIZED)
  const lines = shown.map((e, i) => `  ${i + 1}. [${e.fork}] ${e.persona.split(' (')[0]} (D${e.n}): ${e.decision}\n     Reversal: ${e.reversal}`)
  const more = entries.length - shown.length
  return `\n\nWhat I decided for you (${entries.length} call${entries.length === 1 ? '' : 's'}, riskiest first):\n${lines.join('\n')}` +
    (more > 0 ? `\n  (+${more} more)` : '') +
    `\nThe full trail — charter basis and why — is in .leopold/DECISIONS.md.`
}

// ---- routing: pure, deterministic, and a mirror of the driver's graph.ts ----------
// Given a graph and a state, the next node is a function. No model call decides an
// edge; a node only ever EMITS a signal the graph then routes on.

const TRUTHY = new Set(['true', '1', 'yes', 'on', 'ok', 'pass', 'passed', 'success'])
const byIndex = new Map((nodes || []).map((n) => [n.index, n]))

// signal (`key=value` / `key!=value`) — compares the channel. An ABSENT key never
// matches, in either direction: unknown is not "different from", and routing on
// something nobody emitted is the bug that rule prevents.
// status (a bare word) — matches the node's own outcome word; when it recorded none, a
// truthy signal of the same name matches (`@emit ok` then `@on ok -> 5`).
function routeMatches(route, from, state) {
  const signals = state.signals || {}
  if (route.kind === 'signal') {
    const key = route.key || ''
    if (!Object.prototype.hasOwnProperty.call(signals, key)) return false
    const actual = String(signals[key]).trim()
    const expected = String(route.value == null ? '' : route.value).trim()
    const eq = actual.toLowerCase() === expected.toLowerCase()
    return route.op === '!=' ? !eq : eq
  }
  const word = String(route.when || '').trim().toLowerCase()
  if (!word) return false
  const outcome = state.status[from]
  if (outcome !== undefined && outcome !== null && String(outcome).trim() !== '') {
    return String(outcome).trim().toLowerCase() === word
  }
  const key = String(route.when).trim()
  if (!Object.prototype.hasOwnProperty.call(signals, key)) return false
  const v = String(signals[key]).trim().toLowerCase()
  return TRUTHY.has(v) || v === word
}

function needsMet(node, state) {
  const signals = state.signals || {}
  return (node.needs || []).every((k) => Object.prototype.hasOwnProperty.call(signals, k))
}

// The route edges leaving `from` whose condition holds right now. Done-blind on
// purpose: a node that FAILED is asked too, because that is exactly when the plan's
// `@on fail -> N` is supposed to speak.
function takenRoutes(from, state) {
  const node = byIndex.get(from)
  if (!node) return []
  return node.routes
    .filter((r) => routeMatches(r, from, state))
    .sort((a, b) => a.target - b.target)
}

// What runs next. A done node whose route condition matches STEERS: its matched targets
// become dispatchable even if their static deps are unmet (a route is an explicit
// jump), and the nodes that merely sat downstream of it via `(after:)` are bypassed for
// this dispatch. With no `@on` anywhere this returns precisely the static ready set, in
// ascending order — the wave loop's order, item for item.
// THE LATCH. A route is taken ONCE, when the node settles, against the channel as it
// stood at that instant. Signal keys are global — a later `@tool` node overwrites the
// same `exit` an earlier one routed on — so re-testing a settled node's conditions on a
// later round would un-take its route and un-bypass the branch the plan steered past.
// `latched.frozen` is every node whose outcome this run recorded; for those the router
// REPLAYS `latched.taken` instead of re-evaluating. Identical to the driver's RunRouting.
function routeDecision(doneSet, state, latched) {
  const frozen = (latched && latched.frozen) || new Set()
  const replay = new Set(((latched && latched.taken) || []).map((t) => `${t.from}->${t.to}`))
  const edgesFrom = (index) => frozen.has(index)
    ? (byIndex.get(index) || { routes: [] }).routes
        .filter((r) => replay.has(`${index}->${r.target}`))
        .sort((a, b) => a.target - b.target)
    : takenRoutes(index, state)

  const routed = new Set()
  const steered = new Set()
  for (const n of nodes) {
    if (!doneSet.has(n.index)) continue
    for (const r of edgesFrom(n.index)) {
      steered.add(n.index)
      if (!byIndex.has(r.target) || doneSet.has(r.target)) continue
      routed.add(r.target)
    }
  }

  const bypassed = new Set()
  if (steered.size > 0) {
    for (const n of nodes) {
      for (const d of n.deps) if (steered.has(d) && !routed.has(n.index)) bypassed.add(n.index)
    }
  }

  const out = new Set(routed)
  for (const n of nodes) {
    if (doneSet.has(n.index) || bypassed.has(n.index)) continue
    if (!n.deps.every((d) => doneSet.has(d))) continue
    if (!needsMet(n, state)) continue
    out.add(n.index)
  }
  for (const i of routed) {
    const n = byIndex.get(i)
    if (n && !needsMet(n, state)) out.delete(i)
  }

  const asc = (s) => [...s].sort((a, b) => a - b)
  // Routed targets first, then ascending: a taken route means "go there next", so it
  // outranks positional order. Identical to the driver's dispatchPlan.
  const order = [...asc(out).filter((i) => routed.has(i)), ...asc(out).filter((i) => !routed.has(i))]
  return { order, routed: asc(routed), bypassed: asc(bypassed) }
}

// Which signals actually reach the channel. The plan says what a node may decide; a
// model cannot widen that at runtime. A declared key the node did not report takes its
// DECLARED value when the node ended ok and declared exactly one value for that key.
function signalsFor(node, outcome) {
  const declared = new Map()
  if (node.kind === 'tool') declared.set(TOOL_EXIT_SIGNAL, [])
  for (const e of node.emits) {
    if (declared.has(e.key)) declared.get(e.key).push(e.value)
    else declared.set(e.key, [e.value])
  }
  const emitted = {}
  const refused = []
  for (const [key, value] of Object.entries(outcome.signals || {})) {
    if (declared.has(key)) emitted[key] = String(value)
    else refused.push({ key, reason: `item ${node.index} does not declare "${key}" with @emit` })
  }
  if (outcome.done) {
    for (const [key, values] of declared) {
      if (key in emitted) continue
      const uniq = [...new Set(values)]
      if (uniq.length === 1) emitted[key] = String(uniq[0])
    }
  }
  return { emitted, refused }
}

phase('Plan')
// An empty plan means the compile handed the run nothing. Fail loudly: a clean
// "0/0 done, nothing committed" report is indistinguishable from a finished run.
if (items.length === 0) {
  throw new Error('Leopold: no plan items reached the workflow (args.waves was empty). Check that args was passed as a real object, not a stringified blob.')
}
log(`Leopold: ${items.length} plan item(s) across ${waves.length} dependency wave(s). Git is locked — nothing will be committed; work is left staged for you.`)

// Waves run in dependency order. Items WITHIN a wave are independent by construction
// (no `(after:)` marker links them), so they could be parallelized — but because
// workflow agents edit the real working tree, running them serially avoids cross-item
// tree conflicts. For a wave whose items touch strictly disjoint files, flip this to
// `parallel(wave.map(item => () => runItem(item)))` with worktree isolation on the
// impl agent (see the skill's "Advanced: worktree-parallel" note).
const results = []
const routesTaken = []
const stranded = []
const routedAround = []
let awaitingHuman = null

if (!nodes) {
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]
    log(`— wave ${w + 1}/${waves.length}: ${wave.length} item(s)`)
    for (const item of wave) {
      const r = await runItem(item)
      results.push(r)
      log(`  ${r.done ? '✓' : '✗'} ${item.id}: ${item.text}`)
    }
  }
} else {
  // The routed loop. `closed` is every node that has ENDED — finished, settled by a
  // route, or out of review rounds — and it is what the router treats as done, so the
  // loop cannot dispatch the same node twice and always terminates. A node that ended
  // badly with no route handling it still lets the plan continue, exactly as the wave
  // loop has always done; the driver escalates to the human instead, which is a
  // difference in what a FAILURE means, never in where a ROUTE goes.
  const state = { signals: {}, status: {} }
  const closed = new Set(nodes.filter((n) => n.done).map((n) => n.index))
  log(`Routing is on: ${nodes.length} node(s), ${nodes.reduce((a, n) => a + n.routes.length, 0)} conditional edge(s).`)

  // One writer for the latch the router replays: the loop and the post-loop report ask
  // the same question of the same channel, so what the report calls "routed around" is
  // exactly what the last dispatch bypassed.
  const latch = () => ({ frozen: new Set(Object.keys(state.status).map(Number)), taken: routesTaken })

  for (;;) {
    const d = routeDecision(closed, state, latch())
    if (d.order.length === 0) break
    const node = byIndex.get(d.order[0])
    if (d.bypassed.length) log(`  bypassed this dispatch (control routed away): ${d.bypassed.join(', ')}`)

    // A HUMAN node under `autonomy: ask` stops the run and asks. Nothing after it is
    // dispatched — that posture exists so a person closes this item, and deciding it on
    // their behalf is the one thing they opted out of.
    if (node.kind === 'human' && AUTONOMY === 'ask') {
      awaitingHuman = { id: node.id, item: node.text }
      log(`  ⏸ ${node.id} is a @human node and autonomy is "ask" — stopping and asking. Everything so far is staged.`)
      break
    }

    log(`— ${node.id} [${node.kind}]${d.routed.includes(node.index) ? ' (routed here)' : ''}: ${node.text}`)
    const r = node.kind === 'tool'
      ? await runToolNode(node)
      : node.kind === 'feedback'
        ? await runFeedbackNode(node, closed)
        : (node.kind === 'gate' || node.kind === 'verify')
          ? await runGateNode(node)
          : node.kind === 'human'
            // Nothing halts: the role this decision needs is synthesized, the item runs
            // under it, and the call it made is recorded — the driver's path, on this
            // engine, so a plan means the same thing wherever it runs.
            ? await runHumanNode(node)
            : await runItem(node)
    results.push(r)
    closed.add(node.index)

    // Settle: the node's declared signals go on the channel FIRST, so it may route on
    // the very signal it just decided (`@emit migrated=false` + `@on migrated=false`).
    state.status[node.index] = r.done ? 'ok' : 'fail'
    const { emitted, refused } = signalsFor(node, r)
    Object.assign(state.signals, emitted)
    if (Object.keys(emitted).length) {
      log(`  signals: ${Object.entries(emitted).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    }
    for (const x of refused) log(`  signal refused: ${x.reason}`)

    for (const route of takenRoutes(node.index, state)) {
      if (!byIndex.has(route.target)) {
        // The graph validator names a dangling edge before any agent runs; this catches
        // a payload edited after that gate. Never silently "handled".
        log(`  route ${node.index} → ${route.target} points at no such item — not taken`)
        continue
      }
      routesTaken.push({ from: node.index, to: route.target, when: route.when })
      log(`  route: ${node.index} → ${route.target} (@on ${route.when})`)
    }
    log(`  ${r.done ? '✓' : '✗'} ${node.id}: ${node.text}`)
  }

  // The loop ended, and a node still open is one of two different things. A branch the
  // graph deliberately routed PAST is open ON PURPOSE — that is what a conditional edge
  // is for, and calling it stranded is a false alarm on the happy path of every
  // branching plan. The driver says exactly this: any steer ends the run
  // `routed_complete` with "the graph routed around item(s) N, which stay open on
  // purpose". Everything else waits on a signal nothing emitted or on a route control
  // never reached — that is STRANDED, and the driver decides it under a synthesized
  // role or stops with `deadlock` naming the items. A workflow run has no scheduler
  // left to unstick, so it names them; a stranded item that appears nowhere in the
  // report is the silent degrade this project does not ship.
  if (!awaitingHuman) {
    const open = (i) => byIndex.has(i) && !closed.has(i) && !byIndex.get(i).done
    // The last dispatch's bypass set, plus everything sitting behind it: a node whose
    // dependency was routed past could never have run either.
    const around = new Set(routeDecision(closed, state, latch()).bypassed.filter(open))
    for (let grew = true; grew; ) {
      grew = false
      for (const n of nodes) {
        if (!open(n.index) || around.has(n.index)) continue
        if (!n.deps.some((d) => open(d) && around.has(d))) continue
        around.add(n.index)
        grew = true
      }
    }
    for (const n of nodes) {
      if (!open(n.index)) continue
      if (around.has(n.index)) {
        routedAround.push({ item: n.text })
        log(`  ↷ ${n.id} stays open on purpose — the graph routed around it`)
        continue
      }
      const waiting = (n.needs || []).filter((k) => !Object.prototype.hasOwnProperty.call(state.signals, k))
      stranded.push({ item: n.text, waiting_on: waiting })
      log(`  ⚠ ${n.id} never became dispatchable: ${waiting.length ? `waits on signal ${waiting.map((k) => `"${k}"`).join(', ')}, which nothing emitted` : 'no wave and no route reached it'}`)
    }
  }
}

phase('Report')
// Empty for a plan that authored no graph, so a plain checklist's note is the string it
// has always been, byte for byte.
const routedNote = routedAround.length
  ? ` The graph routed around ${routedAround.length} item(s), which stay open on purpose.`
  : ''
const done = results.filter((r) => r.done)
const incomplete = results.filter((r) => !r.done)
// The calls this run made on your behalf, riskiest first, and the block that ends the
// note. Both are empty for a run that decided nothing — the note is then the string it
// has always been.
const decided = byRisk(decisionsMade)
const decidedNote = decidedForYou(decided)
// The routed keys appear ONLY for a plan that authored a graph, so a plain checklist
// reports exactly the shape it has always reported.
return {
  mission: mission.split('\n').find((l) => l.trim() && !l.startsWith('#')) || mission.split('\n')[0] || '',
  total: results.length,
  done: done.length,
  incomplete: incomplete.map((r) => ({ item: r.text, blocking: r.blocking || [] })),
  ...(nodes ? { routes: routesTaken } : {}),
  // What Leopold decided on your behalf, RISKIEST FIRST. Present only when it decided
  // something, so a run with no persona path reports exactly the shape it has always
  // reported — and every entry here is also in DECISIONS.md, with its charter basis.
  ...(decisionsMade.length ? { decisions: decided } : {}),
  ...(stranded.length ? { stranded } : {}),
  // The branches the graph deliberately routed past. Reported, never counted as a
  // failure — the driver's `routed_complete` says the same thing in its own words.
  ...(routedAround.length ? { routed_around: routedAround } : {}),
  ...(awaitingHuman ? { awaiting_human: awaitingHuman } : {}),
  note: (stranded.length && !awaitingHuman
    ? `${stranded.length} item(s) never became dispatchable — the plan strands them (see \`stranded\`). Everything else is staged for your review; nothing was committed.${routedNote}`
    : awaitingHuman
    ? `Stopped at a @human node ("${awaitingHuman.item}") — it is your decision to make. Everything so far is staged; nothing was committed.`
    : `Everything is staged for your review; nothing was committed. Commit what you approve.${routedNote}`) + decidedNote,
}
