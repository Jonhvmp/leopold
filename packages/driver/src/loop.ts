// The orchestration loop: the conductor burns down the plan, one fresh worker
// per item, deciding from the charter, with git locked, until the plan is done
// or a stop condition fires. It notifies the human on completion or escalation.
//
// Two modes share one per-item engine (processItem): the default serial loop, and
// a --parallel scheduler that runs independent items concurrently, each in its own
// worktree, replaying each item's diff onto the main tree as a staged patch.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadBrief, initState, writeState, killSwitch, loadConfig, clearRunTokens, readAmendmentsAdded, briefDigest } from "./config.js";
import { runItem } from "./worker.js";
import { decide, resolveEscalation, type EscalationResolution } from "./conductor.js";
import { logEvent, logDecision, logPersonaDecision, openItems, nextOpenItem } from "./log.js";
import { notify } from "./notify.js";
import { createWorktree, cleanupWorktree, type Worktree } from "./worktree.js";
import { reapOrphan } from "./reaper.js";
import { overBudget } from "./budget.js";
import { classifyItem } from "./classify.js";
import { smartRoute } from "./route.js";
import { reviewItem, diffIsSensitive, lensesFor } from "./review.js";
import { rootCausePanel, formatLead } from "./hypotheses.js";
import { learnFromRun } from "./learn.js";
import {
  parsePlanFile, allDone, setItemDone, checkboxVector, checkboxLedgerMark, driverFlipsSince,
  forgedCheckboxes, restoreCheckboxes, type PlanEmit, type PlanItem, type PlanNodeKind,
} from "./plan.js";
import { dispatchPlan, newRouting, settleNode, type RunRouting } from "./dispatch.js";
import {
  preflightOrRepair, repairDeadlock, strandsOf, renderDeadlockAttempt,
  type DeadlockRepair, type Strand,
} from "./repair.js";
import { readSignals } from "./bus.js";
import type { GraphDiagnostic } from "./graph.js";
import { drainCommands } from "./commands.js";
import { headSha, diffAgainst, applyStaged, snapshotTree, restoreTree, stageAll, treeStateSignature } from "./git.js";
import { bashDenial } from "./guard.js";
import {
  isReviewOnly, isTool, isFeedback, isReadOnlyNode, isHuman, haltsRun, toolCommand,
  reviewNodeAppend, buildReviewNodePrompt, feedbackNodeAppend, buildFeedbackPrompt,
  buildHumanNodePrompt,
  TOOL_EXIT_SIGNAL, TOOL_TIMEOUT_EXIT, TOOL_TIMEOUT_MS,
} from "./kinds.js";
import {
  synthesizePersona, personaAppend, parseDecisionBlock, DEFAULT_REVERSAL, type Persona,
} from "./persona.js";
import { rescueRepeatedFailure } from "./rescue.js";
import { parseAmendments, applyAmendments, MAX_ADDED_ITEMS, type AmendProposal } from "./amend.js";
import { runTournament, type RunAttempt } from "./tournament.js";
import { currentProvider } from "./sdk.js";
import { HARNESSES } from "./provider.js";
import type { Brief, DriverConfig, RunState, WorkerStatus } from "./types.js";

/** The item's uncommitted change set (file list), for sensitivity detection. */
function diffStat(cwd: string): string {
  const r = spawnSync("git", ["--no-pager", "diff", "--stat", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

/** On a serial retry the failed attempt's diff is still in the shared tree. Ed's
 *  principle: do not patch a dead end — building on a failed diff pulls the fresh
 *  worker back toward the same wrong region of the solution space. Frame the prior
 *  attempt as someone else's dead end (third-person projection, which the models
 *  handle far better than "your own code is wrong") and push a clean restart. Kept
 *  as framing, not a destructive git reset, so prior items' staged work is never at
 *  risk. The parallel scheduler needs none of this — each dispatch is a fresh
 *  worktree off HEAD, already a clean start. */
const FRESH_RESTART =
  "The previous attempt at this item FAILED. Treat its code as a dead end written by someone else: do NOT patch, extend, or try to salvage it. Where that approach went wrong, replace it wholesale with a genuinely different one instead of adjusting it in place — reworking a failed diff pulls back toward the same dead end. Start from the behavior the item needs, not from the code already sitting there.";

/** Combine the fresh-restart framing with the root-cause panel's lead (if any).
 *  Exported for unit tests — the framing must survive on every serial retry
 *  whether or not the hypothesis panel produced a surviving lead. */
export function retryLead(panelLead?: string): string {
  return panelLead ? `${FRESH_RESTART}\n\n${panelLead}` : FRESH_RESTART;
}

/** Whether a serial retry should do a LITERAL reset (restore the pre-item snapshot)
 *  instead of only reframing. Pure + tested: it needs the toggle on, a worktree-
 *  isolated run (never the user's live repo), an actual retry, and a snapshot of
 *  THIS item to restore. When false, the retry falls back to the retryLead framing. */
export function shouldLiteralReset(o: {
  isRetry: boolean; literalReset: boolean; isolated: boolean; haveSnapshot: boolean;
}): boolean {
  return o.isRetry && o.literalReset && o.isolated && o.haveSnapshot;
}

/** Whether an item should be settled by a best-of-k tournament (R3) instead of a
 *  single attempt. Pure + tested: needs K>1, a worktree-isolated run (the winner is
 *  applied with restoreTree, never pointed at a live repo), and a critical/max item —
 *  best-of-k is for the sharp edges, not routine work. K=1 (default) → always false,
 *  so the loop is byte-for-byte unchanged when the toggle is off. */
export function tournamentEligible(o: {
  bestOfK: number; isolated: boolean; critical: boolean; maxEffort: boolean;
}): boolean {
  return o.bestOfK > 1 && o.isolated && (o.critical || o.maxEffort);
}

interface Escalation { item: string; question: string; why: string; }
interface ItemOutcome {
  done: boolean; escalated: boolean; escalation?: Escalation;
  /** Last worker-reported summary — feeds the root-cause panel on a retry. */
  detail?: string;
  /** Signals the worker reported over its turns, merged (a later turn wins). Undefined
   *  when it reported none, which is every turn of a plan that declares no `@emit`. */
  signals?: Record<string, string>;
  /** Plan amendments a `@feedback` node PROPOSED. Judged and applied by the scheduler
   *  (`applyProposals`), never here: both schedulers already serialize their PLAN.md
   *  writes, and an amendment written from inside the item would race them. Undefined
   *  for every other kind — which is every item of every plan without a feedback node. */
  proposals?: AmendProposal[];
}

/** When an item is being RETRIED after a failure, run the root-cause panel and
 *  turn its surviving hypothesis into a concrete lead for the next attempt. */
async function leadForRetry(
  brief: Brief, cfg: DriverConfig, item: string, cwd: string, failureContext: string,
): Promise<string | undefined> {
  if (!cfg.hypotheses) return undefined;
  console.log("  root-cause panel: 3 investigators over disjoint evidence…");
  const panel = await rootCausePanel(cfg, brief, item, cwd, failureContext);
  logEvent(brief.leoDir, {
    event: "hypothesis", item, considered: panel.considered, survived: panel.survived,
    angle: panel.survivor?.angle ?? null, confidence: panel.survivor?.confidence ?? null,
    theory: panel.survivor?.theory?.slice(0, 200) ?? null,
  });
  const lead = formatLead(panel);
  console.log(lead
    ? `  panel -> survivor (${panel.survivor?.angle}, ${panel.survivor?.confidence}/10): ${panel.survivor?.theory}`
    : `  panel -> no hypothesis survived refutation (${panel.considered} considered)`);
  return lead;
}

/** The item a scheduler last failed on, and what that attempt reported. Both schedulers
 *  keep one so the failure ceiling has something concrete to change the approach ON. */
interface LastFailed { index: number; text: string; detail: string; }

/** The run is at its failure ceiling. Instead of giving up, spend the run's ONE
 *  persona-led change of approach (rescue.ts): run the root-cause panel over the failure
 *  evidence, hand its surviving hypothesis to a role synthesized from that failure, and
 *  return the lead the last attempt runs under.
 *
 *  `null` = stop with `repeated_failure`, exactly as before: the rescue was already spent,
 *  nothing has failed yet to change the approach on, or no different approach could be
 *  decided. Nothing here raises `max_failures` or any other budget — the attempt it buys
 *  is one, and it is charged as an iteration like every other.
 *
 *  ONE HELPER FOR BOTH SCHEDULERS, so the serial loop and the parallel wave cannot end up
 *  granting different numbers of last chances. */
async function rescueLead(
  brief: Brief, cfg: DriverConfig, state: RunState, failed: LastFailed | null, cwd: string,
): Promise<string | null> {
  if (!failed || state.failure_rescue_used) return null;
  console.log(`\n--- ${failed.text}  [last attempt] ---\n` +
    `  ${state.consecutive_failures} consecutive failures — the ceiling is ${state.max_failures}. Deciding a different approach instead of stopping.`);
  const panelLead = await leadForRetry(brief, cfg, failed.text, cwd, failed.detail);
  const lead = await rescueRepeatedFailure(brief, cfg, state, {
    item: failed.text, failureContext: failed.detail, failures: state.consecutive_failures, panelLead,
  });
  writeState(brief.leoDir, state); // the rescue is spent on disk before the attempt runs
  return lead;
}

/** On a clean finish, optionally mine the run into proposed charter amendments.
 *  Returns a human-facing note to append to the completion message (empty if off
 *  or nothing survived). Best-effort — never throws into the finish path. */
async function maybeLearn(cfg: DriverConfig, brief: Brief): Promise<string> {
  if (!cfg.learnOnFinish) return "";
  console.log("learn-on-finish: mining this run for charter amendments…");
  const r = await learnFromRun(cfg, brief);
  logEvent(brief.leoDir, { event: "learn", proposed: r.proposed, out: r.outPath });
  if (r.proposed === 0) {
    console.log("  learn -> no amendments proposed (the charter already covers this run).");
    return "\n\nlearn-on-finish: no charter amendments — the charter already fits how this run decided.";
  }
  console.log(`  learn -> ${r.proposed} amendment(s) proposed in ${r.outPath}`);
  return `\n\nlearn-on-finish proposed ${r.proposed} charter amendment(s) in .leopold/CHARTER-amendments.md:\n` +
    r.rules.map((x) => `  • ${x}`).join("\n") + `\nReview and fold in what sounds like you; the charter itself was not touched.`;
}

/** Build the worker's opening instruction for an item. Exported for tests: an item
 *  with `@scenario` acceptance lines lists them as the definition of done; an item
 *  with none produces the same prompt shape it always had (backward compatible).
 *
 *  `emits` are the signals the item declared with `@emit`. Only those may be reported,
 *  and only they are mentioned — an item declaring none produces a byte-identical
 *  prompt to the one this built before the graph grammar existed. */
export function signalsBlock(emits: PlanEmit[]): string {
  const keys = [...new Set(emits.map((e) => e.key))];
  if (!keys.length) return "";
  return (
    `Signals — this item declares ${keys.map((k) => `\`${k}\``).join(", ")}. The plan ROUTES on ${keys.length > 1 ? "them" : "it"}, so state what you decided by adding one line to your status block:\n` +
    `  SIGNALS: ${emits.map((e) => `${e.key}=${e.value}`).join(", ")}\n` +
    `Report the value that is actually true of what you did. A signal is a decision (one short word or number), never work product — code, diffs and files belong in the repository. Any other key is refused.\n\n`
  );
}

export function buildWorkerPrompt(item: string, scenarios: string[], lead?: string, steer?: string, scope: string[] = [], emits: PlanEmit[] = []): string {
  return (
    (steer ? `${steer}\n\n` : "") +
    `Work on this plan item now:\n\n${item}\n\n` +
    (scope.length
      ? `Likely in scope — start with these files (the item's slice); read widely only if the change genuinely reaches past them:\n` +
        scope.map((f) => `  - ${f}`).join("\n") + `\n\n`
      : "") +
    (scenarios.length
      ? `Acceptance scenarios — this item is DONE only when EVERY one holds (given→when→then, observable from the caller/user's side):\n` +
        scenarios.map((s, i) => `  ${i + 1}. ${s}`).join("\n") + `\n\n`
      : "") +
    signalsBlock(emits) +
    (lead ? `${lead}\n\n` : "") +
    `Do it completely and verify it (build, lint, tests). Decide reversible or charter-clear forks yourself per the mission and charter. When the item is done, or if you hit a fork only the conductor can settle, close your turn with the leopold-status block.`
  );
}

/** A `@tool` node: the driver runs the declared command itself. NO MODEL TURN is spent —
 *  that is the whole point of the kind — and the command's exit status goes on the state
 *  channel as `exit`, so `@on exit=0 -> 5` (or a plain `@on fail -> 6`) can route on it.
 *
 *  The git lock still holds: the command goes through the SAME `bashDenial` a worker's
 *  Bash tool goes through, so `@tool git push` is refused instead of being a way to
 *  write around the guard by putting the command in the plan. */
function runToolNode(brief: Brief, state: RunState, item: string, cwd: string): ItemOutcome {
  const command = toolCommand(item);
  logEvent(brief.leoDir, { event: "item_start", iteration: state.iteration, item, kind: "tool", command });
  console.log(`\n--- ${item}  [tool] ---`);
  if (!command) {
    const reason = "the @tool node declares no command — its text (or a backticked span in it) IS the command";
    logEvent(brief.leoDir, { event: "tool_refused", item, reason });
    console.log(`  tool -> refused: ${reason}.`);
    return { done: false, escalated: false, detail: reason };
  }
  const denial = bashDenial(brief.leoDir, command);
  if (denial) {
    logEvent(brief.leoDir, { event: "guard_block", tool: "tool_node", reason: denial, command });
    console.log(`  tool -> refused: ${denial}`);
    return { done: false, escalated: false, detail: denial };
  }
  const started = Date.now();
  const r = spawnSync(command, {
    cwd, shell: true, encoding: "utf8", timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = r.status === null && r.signal !== null;
  const code = timedOut ? TOOL_TIMEOUT_EXIT : (r.status ?? (r.error ? 127 : 1));
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  logEvent(brief.leoDir, {
    event: "tool_run", item, command, exit: code, ms: Date.now() - started,
    timed_out: timedOut, output: out.slice(-400),
  });
  console.log(`  tool -> \`${command}\` exited ${code}${timedOut ? " (timed out)" : ""}; no model turn spent.`);
  return {
    done: code === 0, escalated: false,
    detail: `\`${command}\` exited ${code}\n${out.slice(-600)}`,
    signals: { [TOOL_EXIT_SIGNAL]: String(code) },
  };
}

/** What the scheduler dispatched: the node's kind and its label. Absent = a `work`
 *  node, which is what every plan written before the graph grammar existed compiles to
 *  — and the path below is then byte-for-byte the one that ran before kinds existed. */
export interface NodeSpec { kind: PlanNodeKind; label?: string }

/** Apply a `@feedback` node's proposals, and report both halves out loud.
 *
 *  Called from the SCHEDULER, at the point where it already serializes its PLAN.md
 *  writes — an amendment is one more write to the file `setItemDone` owns, and two
 *  read-modify-write passes racing on it would drop one of them.
 *
 *  The budget is RUN-WIDE and lives in state.json (`amendments_added`), so three
 *  feedback nodes cannot each add three items, and a resumed run inherits what it
 *  already spent instead of starting over with a full purse. */
function applyProposals(
  brief: Brief, state: RunState, node: PlanItem, proposals: AmendProposal[],
): void {
  if (proposals.length === 0) return;
  // The higher of what this process knows and what the file says: the counter is
  // seeded from disk at startup so a resumed run inherits its spend, and taking the
  // max means any other writer of state.json can only ever SHRINK the purse.
  const alreadyAdded = Math.max(state.amendments_added ?? 0, readAmendmentsAdded(brief.leoDir));
  const r = applyAmendments(
    {
      leoDir: brief.leoDir, planPath: brief.planPath,
      by: node.index, byText: node.text, alreadyAdded, iteration: state.iteration,
    },
    proposals,
  );
  if (r.added) {
    state.amendments_added = alreadyAdded + r.added;
    writeState(brief.leoDir, state);
    for (const a of r.accepted) console.log(`  amendment -> item ${a.index} added: ${a.text}`);
    console.log(`  ${state.amendments_added}/${MAX_ADDED_ITEMS} plan amendments used this run; each is logged in DECISIONS.md with a Reversal line.`);
  }
  for (const x of r.refused) console.log(`  amendment refused [${x.bound}]: ${x.reason}`);
}

/** How many escalations one item may have SETTLED by a role before the run gives up on
 *  it. Two, not unlimited: a fork settled and then escalated again twice over is an item
 *  the run genuinely cannot make progress on, and burning the budget re-deciding it is
 *  the runaway loop this product exists to not be. It is a ceiling on repetition, never
 *  a judgment call — the first escalation of an item always gets settled. */
export const MAX_ESCALATIONS_SETTLED = 2;

/** Settle a fork the worker escalated, instead of ending the run over it.
 *
 *  Synthesize the ROLE this fork needs (persona.ts), let that role decide it against the
 *  charter (conductor.ts), RECORD the call with its persona, fork, charter basis and
 *  Reversal, and hand the worker the instruction that unblocks it. The decision entry is
 *  not bookkeeping around the feature — it IS the feature: an autonomous call that leaves
 *  no trail is the one failure mode this path sits a step away from.
 *
 *  `undefined` means the fork could not be settled (synthesis and resolution are both
 *  best-effort), and the caller then escalates exactly as it did before personas. */
async function settleEscalation(
  brief: Brief, cfg: DriverConfig, state: RunState, recent: string[],
  item: string, status: WorkerStatus, why: string,
): Promise<EscalationResolution | undefined> {
  const fork = status.decisionNeeded ?? status.summary;
  const persona = await synthesizePersona(cfg, brief, {
    fork: "escalation", item,
    detail: `${fork}${why ? `\nThe conductor escalated it because: ${why}` : ""}`,
  });
  logEvent(brief.leoDir, {
    event: "persona", fork: "escalation", item, synthesized: persona !== undefined,
    name: persona?.name ?? null, role: persona?.role ?? null, role_key: persona?.roleKey ?? null,
    constraints: persona?.constraints.length ?? 0,
  });
  console.log(persona
    ? `  escalation -> ${persona.name}, ${persona.role} takes it — bound by ${persona.constraints.length} charter rule(s).`
    : `  escalation -> no role synthesized; Leopold settles it on the charter alone.`);

  const settled = await resolveEscalation(cfg, brief, status, why, persona);
  if (!settled) {
    // Never silent: the run is about to stop, and the log says it stopped because the
    // fork would not settle, not because nobody tried.
    logEvent(brief.leoDir, { event: "escalation_unsettled", item, fork, persona: persona?.name ?? null });
    console.log(`  escalation -> could not be settled; handing it to you.`);
    return undefined;
  }

  logPersonaDecision(brief.leoDir, state.iteration, persona, settled, { fork: "escalation", item });
  logEvent(brief.leoDir, {
    event: "persona_decision", fork: "escalation", item,
    persona: persona?.name ?? null, role: persona?.role ?? null,
    decision: settled.decision, reversal: settled.reversal,
  });
  // The conductor sees this in `recent` on the worker's next turn, so it cannot settle
  // the same fork the other way two turns later.
  recent.push(`${persona ? `${persona.name} (${persona.role})` : "Leopold"} settled an escalation: ${settled.decision}`);
  console.log(`  decided: ${settled.decision}\n  reversal: ${settled.reversal}`);
  return settled;
}

/** Run one plan item to completion in `cwd`: classify → conduct → review gate.
 *  Shared by the serial loop and the parallel scheduler. Exported for the loop
 *  integration test (driven with an injected fake SDK, zero model calls).
 *
 *  The node's KIND decides which of four paths runs: a `tool` node runs its command
 *  with no model turn; a `gate`/`verify` node runs a review-only session that cannot
 *  edit (and skips the review gate — reviewing a review is theatre); a `feedback` node
 *  runs the same read-only session over the RUN and returns the amendments it proposes,
 *  for the scheduler to judge; a `work` node is everything this function did before.
 *
 *  A `human` node is the fifth: the plan asked a person, nobody is coming, so the role
 *  that decision needs is SYNTHESIZED (persona.ts) and the item runs under it, with the
 *  call it made written to DECISIONS.md. It only reaches here under the default
 *  `autonomy: full`; under `ask` both schedulers stop the run before dispatching one. */
export async function processItem(
  brief: Brief, cfg: DriverConfig, state: RunState, recent: string[],
  item: string, scenarios: string[], cwd: string, lead?: string, steer?: string,
  emits: PlanEmit[] = [], node: NodeSpec = { kind: "work" },
): Promise<ItemOutcome> {
  const kind = node.kind;
  if (haltsRun(kind, cfg.autonomy)) {
    // Defensive, and only reachable under `autonomy: ask`: the schedulers stop before
    // dispatching a @human node in that posture, so reaching here means a caller
    // bypassed them. Do nothing rather than spend a turn on an item the run was
    // explicitly told a person closes.
    logEvent(brief.leoDir, { event: "awaiting_human", item, dispatched: false });
    return { done: false, escalated: false, detail: "a @human node: a person decides this item" };
  }
  if (isTool(kind)) return runToolNode(brief, state, item, cwd);
  const readOnly = isReadOnlyNode(kind);
  const feedback = isFeedback(kind);
  const human = isHuman(kind);

  const klass = cfg.smartRouting
    ? await smartRoute(cfg, brief, item, cwd)
    : classifyItem(item, brief.charter);
  logEvent(brief.leoDir, {
    event: "item_start", iteration: state.iteration, item, effort: klass.effort,
    critical: klass.critical, routed: cfg.smartRouting, reason: klass.reason,
    scenarios: scenarios.length, ...(readOnly ? { kind } : {}),
  });
  console.log(`\n--- ${item}  [${readOnly || human ? `${kind}, ` : ""}effort=${klass.effort}${klass.critical ? ", critical" : ""}${cfg.smartRouting ? ", smart-routed" : ""}${scenarios.length ? `, ${scenarios.length} scenario(s)` : ""}] ---`);

  // A @human node: the plan asked a person, and nobody is coming. Synthesize the ROLE
  // this decision needs and run the item under it. Best-effort by construction —
  // synthesis returns undefined on any failure and the item then runs under the default
  // worker prompt, because a run must never die over who it could not decide it was.
  const persona: Persona | undefined = human
    ? await synthesizePersona(cfg, brief, {
        fork: "human", item,
        detail: node.label ? `The plan labelled this decision "${node.label}".` : undefined,
      })
    : undefined;
  if (human) {
    logEvent(brief.leoDir, {
      event: "persona", fork: "human", item, synthesized: persona !== undefined,
      name: persona?.name ?? null, role: persona?.role ?? null, role_key: persona?.roleKey ?? null,
      constraints: persona?.constraints.length ?? 0,
    });
    console.log(persona
      ? `  persona -> ${persona.name}, ${persona.role} — bound by ${persona.constraints.length} charter rule(s).`
      : `  persona -> not synthesized; the item runs under the default worker prompt.`);
  }

  // Slice-scoped context (opt-in): when routing researched the item's files, point
  // the worker at that slice instead of the whole repo. Off / no file set = unchanged.
  const scope = cfg.sliceScope ? (klass.files ?? []) : [];
  const workerPrompt = feedback
    ? buildFeedbackPrompt(item, scenarios, steer, signalsBlock(emits))
    : readOnly
      ? buildReviewNodePrompt(kind, item, scenarios, steer, signalsBlock(emits))
      : human
        ? buildHumanNodePrompt(item, scenarios, steer, signalsBlock(emits))
        : buildWorkerPrompt(item, scenarios, lead, steer, scope, emits);
  // A review-only node must leave the tree exactly as it found it. The editing tools
  // are denied twice over (session + guard), and this is the receipt: if the tree moved
  // anyway — a Bash redirect, say — the run SAYS SO instead of passing a silent edit off
  // as a clean gate. The signature is CONTENT-sensitive on purpose: a gate's shell can
  // append to a file that is already dirty, and a names-only signature never notices.
  const treeBefore = readOnly ? treeStateSignature(cwd) : "";
  // …and the same receipt for the brief itself, which that signature CANNOT see:
  // `.leopold/` is gitignored, so a write to PLAN.md or GUARDRAILS.md leaves
  // `git status --porcelain` byte-identical. The guard refuses those writes; this is
  // what makes one that slipped through impossible to slip through QUIETLY.
  const briefBefore = readOnly ? briefDigest(brief.leoDir) : "";
  // …and the half of PLAN.md the digest deliberately blanks: its CHECKBOXES. Blanking
  // them is what keeps a `--parallel` sibling closing its own item from reading as a
  // node edit, but it also blinded the receipt to the one forgery that ends a run early
  // — flip every `[ ]` to `[x]` and the next round sees allDone and stops with
  // `plan_complete`, work undone. The ledger tells the two apart: the driver records
  // every checkbox IT flips, so what moved and is not on the ledger was forged.
  const checksBefore = readOnly ? checkboxVector(brief.planPath) : "";
  const flipMark = readOnly ? checkboxLedgerMark() : 0;

  // The review gate inspects `cwd`'s diff, so it must see this item's worktree.
  const itemBrief: Brief = { ...brief, worktreeRoot: cwd };
  let escalated = false, itemDone = false, reviewRounds = 0;
  let escalation: Escalation | undefined;
  let lastSummary = "";
  // Signals the worker reported, merged across its turns. Nothing is filtered here —
  // settleNode decides what the plan actually lets this node put on the channel.
  const reported: Record<string, string> = {};
  // A feedback node's raw turns, kept whole: its `leopold-amend` block lives OUTSIDE
  // the status block, so the parsed status is not enough to read its proposals. A
  // @human node's `leopold-decision` block is outside it for the same reason.
  let amendText = "";

  await runItem({
    brief, cfg, item, workerPrompt, cwd, effort: klass.effort,
    ...(readOnly
      ? {
          readOnly: true,
          systemAppend: feedback ? feedbackNodeAppend(node.label ?? "") : reviewNodeAppend(kind, node.label ?? ""),
        }
      : {}),
    // The synthesized role, appended to the session's system prompt. Absent for every
    // node that reached no persona path, which leaves that prompt byte-identical.
    ...(persona ? { personaAppend: personaAppend(persona) } : {}),
    onBlock: (tool, reason) => logEvent(brief.leoDir, { event: "guard_block", tool, reason }),
    onCost: (usd) => {
      state.spent_usd = (state.spent_usd ?? 0) + usd;
      logEvent(brief.leoDir, { event: "cost", item, usd, spent_usd: state.spent_usd });
    },
    onTurn: async (status: WorkerStatus, text: string): Promise<string | null> => {
      lastSummary = `${status.kind}: ${status.summary}${status.evidence ? `\nEVIDENCE: ${status.evidence}` : ""}`.slice(0, 800);
      if (status.signals) Object.assign(reported, status.signals);
      if (feedback || human) amendText += text;
      logEvent(brief.leoDir, { event: "worker_turn", kind: status.kind, item: status.item || item });

      // A review-only node's verdict IS the answer — there is nothing for the conductor
      // to conduct and nothing to hand to a review gate. done = the gate passes, blocked
      // = it does not (and the plan routes on that `fail`). Only a genuine fork still
      // goes to the conductor, on the ordinary escalation path below.
      if (readOnly && status.kind !== "needs-decision") {
        itemDone = status.kind === "done";
        logEvent(brief.leoDir, {
          event: feedback ? "feedback" : "gate",
          item, kind, ok: itemDone, summary: status.summary.slice(0, 300),
        });
        console.log(`  ${kind} -> ${itemDone ? "pass" : `fail: ${status.summary.slice(0, 200)}`}`);
        return null;
      }

      const verdict = await decide(cfg, brief, status, recent.slice(-5).join("\n"));
      logDecision(brief.leoDir, state.iteration, status, verdict);
      if (verdict.logTitle) recent.push(`${verdict.logTitle}: ${verdict.reply ?? "(finish)"}`);

      if (verdict.action === "finish") {
        // Review gate: an independent pass over the item's diff before it closes.
        if (cfg.review && !readOnly && reviewRounds < cfg.maxReviewRounds) {
          const sensitive = klass.critical || diffIsSensitive(diffStat(cwd));
          // Conformance skeptic joins the panel only when the item has scenarios AND
          // the toggle is on — so scenario-less items and conformance:off runs are unchanged.
          const reviewScenarios = cfg.conformance ? scenarios : [];
          const lenses = lensesFor({ sensitive, critical: klass.critical, hasScenarios: reviewScenarios.length > 0 });
          const r = await reviewItem(cfg, itemBrief, { sensitive, critical: klass.critical, scenarios: reviewScenarios });
          logEvent(brief.leoDir, { event: "review", item, round: reviewRounds + 1, ok: r.ok, blocking: r.blocking.length, sensitive, lenses: lenses.length, panel: lenses.join("+") });
          if (!r.ok) {
            reviewRounds += 1;
            console.log(`  review -> ${r.blocking.length} blocking (round ${reviewRounds}/${cfg.maxReviewRounds})`);
            return (
              `A Leopold review gate found blocking issues; the item is NOT done yet:\n` +
              r.blocking.map((f, i) => `${i + 1}. [${f.file}] ${f.issue}`).join("\n") +
              `\n\nFix every one, re-verify (build/lint/test), then report status again.`
            );
          }
          console.log(`  review -> clean`);
        }
        itemDone = true;
        return null;
      }
      if (verdict.action === "escalate") {
        // NOTHING HALTS. The conductor could not settle this fork from the charter — so
        // the run works out WHO could, that role settles it, the decision is recorded
        // with its Reversal, and the worker is told what to do. `autonomy: ask` keeps the
        // old behavior exactly: the run escalates and stops, for a plan written against
        // it. The trust boundary is untouched either way — a role decides, and the guard
        // still denies the commit and the push that would execute the decision.
        const why = verdict.escalationReason ?? "";
        // Counted on the RUN, per item — never in a local. `processItem` is re-entered for
        // every attempt (serial retry, parallel re-dispatch, each best-of-k round), so a
        // local counter started over each time and the "two settled escalations, then the
        // run stops" ceiling quietly became two PER ATTEMPT.
        const settledSoFar = state.escalations_settled?.[item] ?? 0;
        if (cfg.autonomy !== "ask" && settledSoFar < MAX_ESCALATIONS_SETTLED) {
          state.escalations_settled = { ...(state.escalations_settled ?? {}), [item]: settledSoFar + 1 };
          const settled = await settleEscalation(brief, cfg, state, recent, item, status, why);
          if (settled) return settled.reply;
        }
        escalated = true;
        escalation = { item, question: status.decisionNeeded ?? status.summary, why };
        return null;
      }
      console.log(`  conductor -> ${verdict.reply}`);
      return verdict.reply ?? "Proceed using your best judgment per the charter, then report status.";
    },
  });

  if (readOnly) {
    const treeMoved = treeStateSignature(cwd) !== treeBefore;
    const forged = forgedCheckboxes(checksBefore, checkboxVector(brief.planPath), driverFlipsSince(flipMark, brief.planPath));
    const briefMoved = briefDigest(brief.leoDir) !== briefBefore || forged.length > 0;
    if (treeMoved || briefMoved) {
      // The node judged the work AND changed it. Never silent: name it in the log and on
      // stdout so the human sees a node that stepped outside its authority — and say
      // WHICH surface moved, because a write to the brief is the graver of the two.
      // A forged checkbox is more than reported: it is PUT BACK. The driver's ledger is
      // the record of which items it actually closed, so restoring from it is not a
      // guess — and leaving the forgery in place would end the run on a lie.
      const restored = forged.length ? restoreCheckboxes(brief.planPath, forged, checksBefore) : [];
      logEvent(brief.leoDir, {
        event: "review_node_edited", item, kind, tree: treeMoved, brief: briefMoved,
        ...(forged.length ? { checkboxes: forged, restored } : {}),
      });
      const what = briefMoved
        ? `modified the run's own brief under .leopold/${treeMoved ? " and the working tree" : ""}`
        : "modified the working tree";
      console.warn(`  ⚠ the ${kind} node ${what} — a read-only node must not. Inspect it before trusting its verdict.`);
      if (restored.length) {
        console.warn(`  ⚠ it moved the checkbox of item ${restored.join(", ")}, which it never ran — restored from the driver's own record.`);
      }
    }
  }

  // A @human node decided something a person was asked to decide. RECORD IT — persona,
  // fork, charter basis, the call and how to undo it — through the one DECISIONS.md
  // writer. This is not optional bookkeeping: an autonomous call that leaves no trail is
  // the failure mode this whole path sits one step away from, so the entry is written
  // whether the node closed the item or not, and its Reversal is never empty.
  if (human) {
    const d = parseDecisionBlock(amendText, lastSummary || item)
      ?? { decision: item, why: "", reversal: DEFAULT_REVERSAL };
    logPersonaDecision(brief.leoDir, state.iteration, persona, d, { fork: "human", item });
    logEvent(brief.leoDir, {
      event: "persona_decision", fork: "human", item, done: itemDone,
      persona: persona?.name ?? null, role: persona?.role ?? null,
      decision: d.decision, reversal: d.reversal,
    });
    console.log(`  decided: ${d.decision}\n  reversal: ${d.reversal}`);
  }

  // What the feedback node PROPOSED. Parsed here (this is where its turns are), judged
  // and applied by the scheduler — the node itself wrote nothing, and amend.ts is the
  // only thing that ever decides an amendment.
  const proposals = feedback ? parseAmendments(amendText) : [];

  return {
    done: itemDone, escalated, escalation, detail: lastSummary,
    ...(Object.keys(reported).length ? { signals: { ...reported } } : {}),
    ...(proposals.length ? { proposals } : {}),
  };
}

/** Run one item, escalating to a best-of-k tournament (R3) when it is critical/max
 *  and the toggle is on. Isolated runs only — the winner is applied with restoreTree,
 *  which never touches the user's live repo. Falls back to a single attempt when
 *  best-of-k is off, the item is ordinary, the run isn't isolated, or no attempt wins.
 *  Each attempt is a full processItem (so the winner already passed the review gate). */
async function runItemOrTournament(
  brief: Brief, cfg: DriverConfig, state: RunState, recent: string[],
  item: string, scenarios: string[], cwd: string, isolated: boolean,
  lead?: string, steer?: string, emits: PlanEmit[] = [], node: NodeSpec = { kind: "work" },
): Promise<ItemOutcome> {
  const single = (): Promise<ItemOutcome> => processItem(brief, cfg, state, recent, item, scenarios, cwd, lead, steer, emits, node);
  const klass = classifyItem(item, brief.charter);
  // Best-of-k fans out attempts that BUILD something and keeps the best diff. Only a
  // work node produces a diff to judge, so every other kind takes the single path.
  if (node.kind !== "work") return single();
  if (!tournamentEligible({ bestOfK: cfg.bestOfK, isolated, critical: klass.critical, maxEffort: klass.effort === "max" })) {
    return single();
  }

  // Seed each attempt with the current accumulated state (prior items' work).
  const basePatch = snapshotTree(cwd);
  const runAttempt: RunAttempt = async (attemptCwd) => {
    const o = await processItem(brief, cfg, state, recent, item, scenarios, attemptCwd, lead, steer, emits, node);
    return { ok: o.done, detail: o.detail ?? "" };
  };
  const t = await runTournament(cfg, brief, item, scenarios, cfg.bestOfK, cwd, runAttempt, basePatch);
  if (t.patch === null) {
    logEvent(brief.leoDir, { event: "tournament_no_winner", item, attempts: t.attempts });
    console.log(`  best-of-${t.attempts}: no attempt won — falling back to a single attempt.`);
    return single();
  }
  // Put the winner's full tree onto cwd (isolated worktree; restoreTree is fail-safe).
  const r = restoreTree(cwd, t.patch);
  logEvent(brief.leoDir, { event: "tournament_applied", item, winner: t.winner, scores: t.scores, applied: r.ok });
  if (!r.ok) {
    console.log(`  best-of-${t.attempts}: winner #${t.winner} did not apply (${r.err.slice(0, 100)}) — single attempt.`);
    return single();
  }
  console.log(`  best-of-${t.attempts}: attempt #${t.winner} won (scores ${t.scores.join("/")}), applied.`);
  return { done: true, escalated: false };
}

/** UNDER `autonomy: ask` ONLY. A `@human` node is where the run hands the seat back:
 *  it stops BEFORE dispatching anything for that item — no agent, no tokens — names the
 *  item, and stages everything so whoever picks it up finds a reviewable index. Staging
 *  is all it touches: the human still commits. Returns the message to notify with.
 *
 *  This mirrors hooks/stop-continuity.sh (same `awaiting_human` stop reason, same event),
 *  so a plan means the same thing on the in-session engine and here — under BOTH
 *  postures, which is why the hook learns `autonomy` alongside this. */
function haltForHuman(brief: Brief, state: RunState, node: PlanItem, cwd: string): string {
  const staged = stageAll(cwd).ok;
  if (cwd !== brief.root) stageAll(brief.root);
  state.awaiting_item = node.index;
  state.awaiting_text = node.text;
  logEvent(brief.leoDir, {
    event: "awaiting_human", item: node.index, text: node.text,
    label: node.kindLabel || null, staged,
  });
  console.log(
    `\n--- ${node.text}  [human] ---\n` +
    `  plan item ${node.index} is a @human node — a person decides it. The run is paused; everything is staged.`,
  );
  return (
    `Plan item ${node.index} is a @human node — it needs you:\n\n  ${node.text}\n\n` +
    `The run stopped there (awaiting_human) and staged everything for your review; nothing was committed. ` +
    `Answer it, mark the item [x] in .leopold/PLAN.md, then re-run leopold-driver to continue.`
  );
}

/** The plan's graph is malformed, so the run never started. Carries the diagnostics
 *  so an embedder gets the same named offenders the CLI printed, not just a string. */
export class InvalidPlanGraphError extends Error {
  readonly diagnostics: GraphDiagnostic[];
  constructor(diagnostics: GraphDiagnostic[]) {
    super(
      `PLAN.md declares an invalid graph (${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}) — ` +
      `the run did not start and no agent was dispatched. Fix the plan, then \`leopold graph\` to confirm.`,
    );
    this.name = "InvalidPlanGraphError";
    this.diagnostics = diagnostics;
  }
}

export async function runDriver(cwd: string, argv: string[]): Promise<void> {
  const brief = loadBrief(cwd);
  // Config honors the brief's GUARDRAILS.md for its toggles (review, hypotheses,
  // smart_routing, learn_on_finish), with CLI/env taking precedence.
  const cfg = loadConfig(argv, brief.guardrails);

  // FAIL FAST. The graph is validated before anything is activated, reaped, worktreed
  // or dispatched: a cycle, a route to an item that does not exist, an item nothing can
  // reach or an `@needs` nobody emits stops the run here, with every offender named, for
  // zero tokens. This is the same gate `leopold graph` runs, printing the same block —
  // one writer, so the pre-flight a human runs and the one the driver runs cannot
  // disagree. A plan with no graph grammar cannot produce a diagnostic, so this is
  // silent on every plan written before the grammar existed.
  //
  // …unless the run is autonomous, in which case a malformed graph is a DECISION before
  // it is a dead end: a plan engineer is synthesized, proposes the narrowest repair
  // (retarget a declared route, append an item) through the bounds amend.ts already
  // enforces, and the run starts on the repaired plan. A repair that does not produce a
  // valid graph writes nothing and the run refuses exactly as it did, printing the
  // diagnostics AND what the repair attempted.
  const preflight = await preflightOrRepair(brief, cfg);
  if (preflight.repair?.ok) {
    for (const a of preflight.repair.accepted) console.log(`  graph repaired -> item ${a.index}: ${a.line.trim()}`);
    for (const r of preflight.repair.refused) console.log(`  repair refused [${r.bound}]: ${r.reason}`);
    console.log(`  the repair is in DECISIONS.md with its Reversal; \`leopold graph\` now validates.\n`);
  }
  if (!preflight.ok) {
    console.error(preflight.report);
    logEvent(brief.leoDir, {
      event: "preflight_rejected",
      reason: "invalid_graph",
      problems: preflight.diagnostics.length,
      repaired: preflight.repair ? false : null,
      diagnostics: preflight.diagnostics.map((d) => ({ code: d.code, item: d.index, items: d.items, message: d.message })),
    });
    throw new InvalidPlanGraphError(preflight.diagnostics);
  }

  if (cfg.dryRun) {
    console.log("DRY RUN — brief loaded, no workers will run.\n");
    console.log("Mission:\n" + brief.mission.split("\n").slice(0, 10).join("\n"));
    console.log(`\nOpen plan items: ${openItems(brief.planPath)}`);
    console.log("Next item: " + (nextOpenItem(brief.planPath) ?? "(none)"));
    if (cfg.parallel > 1) console.log(`Parallel: up to ${cfg.parallel} concurrent (each in its own worktree).`);
    return;
  }

  // Preflight: reap a prior run that crashed leaving state.active === true.
  reapOrphan(brief.root, brief.leoDir);

  // Optional isolation: a run-wide worktree (serial only — the parallel scheduler
  // gives each item its own worktree off the main tree instead).
  let worktree: Worktree | null = null;
  if (cfg.worktree && cfg.parallel <= 1) {
    worktree = createWorktree(brief.root, brief.leoDir, randomUUID().slice(0, 8));
    if (worktree) {
      brief.worktreeRoot = worktree.path;
      console.log(`Isolated in worktree: ${worktree.path}  (branch ${worktree.branch})`);
    }
  }

  const state = initState(brief);
  // Charge the pre-flight graph repair to the run-wide amendment purse. It runs BEFORE
  // state exists, so it reads its budget off disk and the spend is folded in here — one
  // writer for state.json, and no path that changes the plan without paying for it.
  if (preflight.repair?.ok && preflight.repair.accepted.length) {
    state.amendments_added = (state.amendments_added ?? 0) + preflight.repair.accepted.length;
  }
  state.budget_usd = cfg.budgetUsd;
  state.spent_usd = 0;
  if (worktree) {
    state.worktree_path = worktree.path;
    state.worktree_branch = worktree.branch;
  }
  writeState(brief.leoDir, state);
  const recent: string[] = [];

  const harness = HARNESSES[currentProvider()];
  logEvent(brief.leoDir, {
    event: "run_start", conductor: cfg.conductorModel, provider: harness.id,
    worktree: worktree?.path ?? null, budget_usd: cfg.budgetUsd ?? null,
    review: cfg.review, parallel: cfg.parallel,
  });
  const gate = cfg.review ? `Review gate on (${cfg.maxReviewRounds} rounds/item).` : "Review gate off.";
  const mode = cfg.parallel > 1 ? `Parallel x${cfg.parallel}.` : "";
  console.log(`Leopold is conducting "${brief.root}" on ${harness.label}. Git is locked. ${gate} ${mode} touch .leopold/STOP to halt.\n`.replace(/\s+/g, " "));

  const stop = (reason: string) => {
    state.active = false;
    state.stopped_reason = reason;
    writeState(brief.leoDir, state);
    clearRunTokens(brief.leoDir);
    logEvent(brief.leoDir, { event: "stop", reason });
    if (worktree) cleanupWorktree(brief.root, worktree, brief.leoDir);
  };

  // What the run has decided so far: outcome words + the routes already taken. Both
  // dispatch paths share this type; a plan with no `@on` never puts anything in it.
  const routing = newRouting();

  if (cfg.parallel > 1) {
    await runParallel(brief, cfg, state, recent, routing, stop);
    return;
  }

  // --- Serial loop -----------------------------------------------------------
  // When an item is retried after a failure, the root-cause panel investigates
  // first and hands the next attempt a concrete lead instead of "try again".
  let lastFailed: LastFailed | null = null;
  // The lead the run's ONE persona-led last attempt runs under, decided at the failure
  // ceiling and consumed by the very next dispatch. Null on every run that never reaches
  // the ceiling, which is every run that finishes.
  let pendingRescue: string | null = null;
  // Pre-first-attempt tree snapshot for the literal fresh restart (R2). Captured
  // before an item's first attempt in an isolated run; restored on a retry.
  let snapshot: { index: number; patch: string } | null = null;
  for (;;) {
    if (killSwitch(brief.leoDir)) {
      stop("kill_switch");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped", "Kill switch hit.");
      return;
    }
    if (overBudget(state.spent_usd ?? 0, cfg.budgetUsd)) {
      stop("budget_exceeded");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped",
        `Budget reached: $${(state.spent_usd ?? 0).toFixed(2)} of $${cfg.budgetUsd?.toFixed(2)}. Work so far is staged for your review.`);
      return;
    }
    if (state.iteration >= state.max_iterations) {
      stop("iteration_budget");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped", "Iteration budget reached.");
      return;
    }
    if (state.consecutive_failures >= state.max_failures) {
      // The ceiling is not a budget — it is the run running out of ideas, and that is a
      // decision a role can make. Spend the run's single change of approach; only when
      // there is none to be had does the run stop as it always did.
      pendingRescue = await rescueLead(brief, cfg, state, lastFailed, brief.worktreeRoot ?? brief.root);
      if (pendingRescue === null) {
        stop("repeated_failure");
        await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs you", "Too many consecutive failures; stopping.");
        return;
      }
    }

    // Steer channel: apply any canvas commands (redirect/inject/kill/rerun) at this
    // turn boundary, exactly where STOP is honored. Git stays locked (commands only
    // log + flip PLAN.md checkboxes). redirect/inject return guidance for this item.
    const steer = drainCommands(brief);

    // What runs next comes from the GRAPH, not from "the first unchecked box": the
    // lowest dispatchable item, unless a route was taken, in which case its target
    // outranks the positional order. With no `@on` in the plan there is never a route,
    // and the lowest dispatchable item IS the first unchecked box — every dep points
    // backward, so everything above it is already done.
    const items = parsePlanFile(brief.planPath);
    const next = dispatchPlan(brief.leoDir, items, routing).order[0];
    if (!next) {
      const open = items.filter((i) => !i.done);
      if (open.length === 0 || routing.steered) {
        // Either every box is checked, or the run followed the path the plan declared
        // and the items it routed around are deliberately not done. Both are clean
        // finishes; the second says so, and names what it skipped.
        const skipped = open.map((i) => i.index);
        const learnNote = await maybeLearn(cfg, brief);
        stop(open.length === 0 ? "plan_complete" : "routed_complete");
        const routedNote = skipped.length
          ? ` The graph routed around item(s) ${skipped.join(", ")}, which stay open on purpose.`
          : "";
        await notify(brief.leoDir, cfg.webhookUrl, "Leopold finished",
          `Plan complete for ${brief.root}. Everything is staged for your review; nothing was committed.${routedNote}${learnNote}`);
        return;
      }
      // Open items, no route taken, nothing dispatchable: the run is waiting on a
      // decision nobody made. A role decides it ONCE — through the same bounded path a
      // graph repair uses — and the run moves. When it cannot, the run stops exactly as
      // it did before, naming what is stranded and what the repair tried.
      const dl = await repairDeadlock(brief, cfg, state, routing, items, state.iteration);
      writeState(brief.leoDir, state);
      if (dl?.ok) {
        console.log(`  deadlock -> ${dl.persona ? `${dl.persona.name}, ${dl.persona.role}` : "Leopold"} decided: ${dl.accepted.map((a) => a.line.trim()).join(" · ")}`);
        console.log(`  the run continues; this repair is spent for the run and the decision is in DECISIONS.md with its Reversal.`);
        continue;
      }
      const note = renderDeadlockAttempt(dl, strandsOf(items, routing, readSignals(brief.leoDir)));
      logEvent(brief.leoDir, {
        event: "deadlock", items: open.map((i) => i.index),
        repair_attempted: dl !== null, repair_ok: false,
      });
      console.warn(note);
      stop("deadlock");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped", note);
      return;
    }
    const item = next.text;
    const cwdForItem = brief.worktreeRoot ?? brief.root;

    // Under `autonomy: ask` a @human node still stops the run before a single token is
    // spent on it. Under the default `full` it is dispatched like any other node and
    // executed by the role processItem synthesizes for it.
    if (haltsRun(next.kind, cfg.autonomy)) {
      const msg = haltForHuman(brief, state, next, cwdForItem);
      stop("awaiting_human");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs you", msg);
      return;
    }

    state.iteration += 1;
    writeState(brief.leoDir, state);

    const cwd = cwdForItem;
    const isolated = cwd !== brief.root;
    const isRetry = lastFailed !== null && lastFailed.index === next.index;

    // Literal fresh restart (R2): on a retry in an isolated worktree, restore the
    // pre-item snapshot so the failed diff is truly discarded (not just reframed),
    // while prior items' staged work survives. Non-isolated or toggle-off falls back
    // to the retryLead framing below. Snapshot the tree on an item's first attempt.
    if (shouldLiteralReset({ isRetry, literalReset: cfg.literalReset, isolated, haveSnapshot: snapshot?.index === next.index })) {
      const r = restoreTree(cwd, snapshot!.patch);
      logEvent(brief.leoDir, { event: "literal_reset", item, ok: r.ok, err: r.ok ? null : r.err.slice(0, 200) });
      console.log(r.ok
        ? "  literal reset: failed diff discarded, pre-item tree restored."
        : `  literal reset failed (${r.err.slice(0, 120)}) — tree kept, framing fallback.`);
    } else if (!isRetry && cfg.literalReset && isolated) {
      snapshot = { index: next.index, patch: snapshotTree(cwd) };
    }

    // On a retry, frame the failed approach as a dead end (retryLead) with the
    // root-cause panel's lead — still right after a literal reset (take a NEW path).
    // A rescued attempt already carries the panel's evidence (the rescue decided ON it),
    // so it never runs the panel twice; it is still framed as a fresh restart, because
    // the approach it was handed is precisely NOT the one in the tree.
    const rescued = pendingRescue !== null && lastFailed?.index === next.index;
    const lead = rescued
      ? retryLead(pendingRescue!)
      : isRetry
        ? retryLead(await leadForRetry(brief, cfg, item, cwd, lastFailed!.detail))
        : undefined;
    // Only clear it when it was actually CONSUMED. The graph does not have to dispatch the
    // item that failed — a `rerun`/`inject` steer rewrites PLAN.md at this turn boundary,
    // and a route can send the run somewhere else entirely. Clearing unconditionally threw
    // the lead away in exactly those cases while `failure_rescue_used` stayed spent, so the
    // run lost its last attempt without ever making it.
    if (rescued) pendingRescue = null;
    // Carry the dispatched item's @scenario acceptance lines into the worker prompt +
    // review gate, and its @emit declarations into the signals it may report (both
    // empty for an item that declares neither).
    const outcome = await runItemOrTournament(
      brief, cfg, state, recent, item, next.scenarios, cwd, isolated, lead, steer, next.emits,
      { kind: next.kind, label: next.kindLabel },
    );

    if (outcome.escalated) {
      const e = outcome.escalation;
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs a call from you",
        `Item: ${e?.item}\nWorker: ${e?.question}\nWhy escalated: ${e?.why}\n\n` +
        `The run is paused. Make the call, adjust PLAN.md or CHARTER.md if needed, then re-run leopold-driver.`);
      stop("escalation");
      return;
    }
    // A feedback node proposed changes to the plan: judge them and apply what clears
    // the bounds, BEFORE the plan is re-read next round, so an accepted item is picked
    // up by this run. Nothing happens for any other kind.
    if (outcome.proposals) applyProposals(brief, state, next, outcome.proposals);

    // Settle the node: its signals go on the channel and the plan's routes for this
    // outcome are taken (and logged with why). No `@emit`/`@on` → this is a no-op that
    // only records the outcome word.
    const settled = settleNode(brief.leoDir, items, next, { done: outcome.done, signals: outcome.signals }, routing);
    for (const r of settled.routes) console.log(`  route -> item ${r.to} (${r.why}).`);

    if (outcome.done) {
      const left = setItemDone(brief.planPath, next.index);
      state.consecutive_failures = 0;
      lastFailed = null;
      writeState(brief.leoDir, state);
      logEvent(brief.leoDir, { event: "item_done", item, open_left: left });
      console.log(`  done. ${left} items left.`);
    } else if (settled.routes.length) {
      // The plan declared where this failure goes, so it is a handled outcome, not a
      // failing run: no retry, and it does not count toward max_failures — otherwise a
      // plan would stop itself by successfully walking its own error path.
      state.consecutive_failures = 0;
      lastFailed = null;
      writeState(brief.leoDir, state);
      logEvent(brief.leoDir, {
        event: "item_routed", item, index: next.index,
        to: settled.routes.map((r) => r.to), open: true,
      });
      console.log(`  not done — routed on. The item stays open in PLAN.md.`);
    } else {
      state.consecutive_failures += 1;
      lastFailed = { index: next.index, text: item, detail: outcome.detail ?? "" };
      writeState(brief.leoDir, state);
      logEvent(brief.leoDir, { event: "item_incomplete", item, fails: state.consecutive_failures });
    }
  }
}

/** Parallel scheduler: dispatch independent (dependency-satisfied) plan items up
 *  to cfg.parallel at once, each in its own worktree, then replay each finished
 *  item's diff onto the main tree as a staged patch (serialized). Nothing is
 *  committed — the run still leaves everything staged for the human. */
async function runParallel(
  brief: Brief, cfg: DriverConfig, state: RunState, recent: string[],
  routing: RunRouting, stop: (reason: string) => void,
): Promise<void> {
  const baseRoot = brief.root;
  const runShort = randomUUID().slice(0, 6);
  const inFlight = new Set<number>();
  const running = new Map<number, Promise<void>>();
  // Items that already failed once, with what the failed attempt reported —
  // a re-dispatch runs the root-cause panel first (same lead mechanic as serial).
  const failedDetail = new Map<number, string>();
  // The last item this wave failed on, and the lead its ONE persona-led last attempt runs
  // under once the run hits the failure ceiling. Both empty on every run that never does.
  let lastFailed: LastFailed | null = null;
  const rescueLeads = new Map<number, string>();
  // The item whose one rescued attempt is queued or running, so the ceiling check below
  // does not condemn an attempt that has not been judged yet.
  let rescuedIndex: number | null = null;
  let stopReason: string | null = null;
  let escalation: Escalation | undefined;
  let conflicts = 0;
  // The @human node the wave stopped at, if any (staged + reported after in-flight
  // items settle, so the human inherits everything the run produced).
  let humanNode: PlanItem | null = null;
  // What was stranded when the wave deadlocked, and the repair that could not unstick
  // it — reported after in-flight items settle, exactly as the @human note is.
  let deadlockStrands: Strand[] = [];
  let deadlockRepair: DeadlockRepair | null = null;

  // Patch application onto the shared main tree must be serialized.
  let applyChain: Promise<void> = Promise.resolve();
  const serialize = (fn: () => void): Promise<void> => {
    applyChain = applyChain.then(() => { fn(); }, () => { fn(); });
    return applyChain;
  };

  async function dispatch(pi: PlanItem, items: PlanItem[], steer?: string): Promise<void> {
    inFlight.add(pi.index);
    // A worktree isolates a node that WRITES, so two concurrent items cannot collide.
    // A gate/verify node writes nothing, and a fresh worktree forks off HEAD — which
    // would hand the node an empty diff and a green verdict on work it never saw. Those
    // kinds run against the accumulated main tree instead, where the run's work is.
    //
    // A @human node is a JUDGEMENT node and has exactly that property, so it does not get
    // one either. "Approve the maintenance window" is a call about work the run already
    // did, git is locked so none of that work is committed, and a fork off HEAD therefore
    // shows the persona a tree with none of it in — it would approve a migration it never
    // saw. It may still write (a persona completes the item like any other), so it takes
    // the main tree, the same way a feedback node does.
    const wt = pi.kind === "work"
      ? createWorktree(baseRoot, brief.leoDir, `${runShort}-i${pi.index}`)
      : null;
    const cwd = wt?.path ?? baseRoot;
    const base = headSha(cwd) || "HEAD";
    try {
      const prior = failedDetail.get(pi.index);
      // A rescued item carries the approach a role decided for its last attempt, with the
      // panel evidence already in it — so it never runs the panel a second time.
      const rescue = rescueLeads.get(pi.index);
      if (rescue !== undefined) rescueLeads.delete(pi.index);
      const lead = rescue ?? (prior !== undefined
        ? await leadForRetry(brief, cfg, pi.text, cwd, prior)
        : undefined);
      const outcome = await processItem(
        brief, cfg, state, recent, pi.text, pi.scenarios, cwd, lead, steer, pi.emits,
        { kind: pi.kind, label: pi.kindLabel },
      );
      if (outcome.escalated) {
        stopReason ??= "escalation";
        escalation ??= outcome.escalation;
        return;
      }
      // A feedback node's amendments, through the SAME serialization every other
      // PLAN.md write goes through — `setItemDone` on a concurrent item is a
      // read-modify-write of this exact file, and racing it would drop one of them.
      if (outcome.proposals) {
        await serialize(() => applyProposals(brief, state, pi, outcome.proposals!));
      }

      // Same settle step as the serial loop, through the same helper: signals on the
      // channel, then the routes the plan declared for this outcome.
      const settled = settleNode(brief.leoDir, items, pi, { done: outcome.done, signals: outcome.signals }, routing);
      for (const r of settled.routes) console.log(`  route -> item ${r.to} (${r.why}).`);
      if (!outcome.done) {
        if (settled.routes.length) {
          // Handled by the plan's own error path: not a retry, not a failure.
          state.consecutive_failures = 0;
          failedDetail.delete(pi.index);
          logEvent(brief.leoDir, {
            event: "item_routed", item: pi.text, index: pi.index,
            to: settled.routes.map((r) => r.to), open: true,
          });
          return;
        }
        state.consecutive_failures += 1;
        failedDetail.set(pi.index, outcome.detail ?? "");
        lastFailed = { index: pi.index, text: pi.text, detail: outcome.detail ?? "" };
        logEvent(brief.leoDir, { event: "item_incomplete", item: pi.text, fails: state.consecutive_failures });
        return;
      }
      failedDetail.delete(pi.index);
      // Replay the item's diff onto the main tree (staged), serialized.
      let applied = true;
      await serialize(() => {
        // Only an isolated node has a diff to replay; a node that ran in the main tree
        // already left its work exactly where the replay would have put it.
        if (wt) {
          const patch = diffAgainst(cwd, base);
          const res = applyStaged(baseRoot, patch);
          if (!res.ok) {
            applied = false;
            conflicts += 1;
            logEvent(brief.leoDir, { event: "merge_conflict", item: pi.text, worktree: cwd, err: res.err.slice(0, 300) });
            console.warn(`  ⚠ "${pi.text}" did not apply cleanly onto the main tree — worktree kept at ${cwd} for manual integration.`);
          }
        }
        const left = setItemDone(brief.planPath, pi.index);
        state.consecutive_failures = 0;
        writeState(brief.leoDir, state);
        logEvent(brief.leoDir, { event: "item_done", item: pi.text, open_left: left, applied });
        console.log(`  done: "${pi.text}". ${left} items left.${applied ? "" : " (conflict — manual merge)"}`);
      });
      // Only reclaim the worktree when its work is safely on the main tree.
      if (applied && wt) cleanupWorktree(baseRoot, wt, brief.leoDir);
    } finally {
      inFlight.delete(pi.index);
    }
  }

  for (;;) {
    if (stopReason) break;
    if (killSwitch(brief.leoDir)) { stopReason = "kill_switch"; break; }
    if (overBudget(state.spent_usd ?? 0, cfg.budgetUsd)) { stopReason = "budget_exceeded"; break; }
    if (state.iteration >= state.max_iterations) { stopReason = "iteration_budget"; break; }
    if (state.consecutive_failures >= state.max_failures) {
      // A rescued attempt that is QUEUED OR RUNNING has not been judged yet, and this
      // check must not judge it. `consecutive_failures` only drops when the item settles
      // (dispatch() zeroes it on success), so without this the very next pass re-enters
      // here while the attempt is still in flight, `rescueLead` returns null because the
      // rescue is already spent, and the run breaks with `repeated_failure` — throwing
      // away the last attempt it just paid a persona synthesis and a root-cause panel for.
      // Derived from the two live sets rather than a flag, so it cannot leak: an item that
      // was never dispatched is in neither, and the ceiling is judged again as it should be.
      const rescuePending = rescuedIndex !== null
        && (inFlight.has(rescuedIndex) || rescueLeads.has(rescuedIndex));
      if (!rescuePending) {
        // Same single change of approach the serial loop gets, through the same helper —
        // a last chance that existed on one scheduler and not the other would teach the
        // user a lie about what their plan does.
        const lead = await rescueLead(brief, cfg, state, lastFailed, baseRoot);
        if (lead === null) { stopReason = "repeated_failure"; break; }
        rescueLeads.set(lastFailed!.index, lead);
        rescuedIndex = lastFailed!.index;
      }
    }

    // Steer channel at the boundary: kill/rerun mutate PLAN.md before we read it;
    // redirect/inject guidance rides along with items dispatched this round.
    const steer = drainCommands(brief);

    const items = parsePlanFile(brief.planPath);
    if (allDone(items)) { stopReason = "plan_complete"; break; }

    // The dispatchable wave comes from the graph: `readyItems`' set when the plan
    // declares no `@on`, and the routed targets first when it does.
    const ready = dispatchPlan(brief.leoDir, items, routing, inFlight).order;

    // Under `autonomy: ask`, a @human node in the wave ends the run: a person decides
    // that item, so nothing is dispatched for it. In-flight items still settle below
    // before we stop. Under the default `full` this finds nothing and the node is
    // dispatched with the rest of the wave.
    const waiting = ready.find((pi) => haltsRun(pi.kind, cfg.autonomy));
    if (waiting) { humanNode = waiting; stopReason = "awaiting_human"; break; }

    while (running.size < cfg.parallel && ready.length && state.iteration < state.max_iterations && !stopReason) {
      const pi = ready.shift()!;
      state.iteration += 1;
      writeState(brief.leoDir, state);
      const p = dispatch(pi, items, steer).finally(() => running.delete(pi.index));
      running.set(pi.index, p);
    }

    if (running.size === 0) {
      // Nothing dispatchable and nothing running: done, routed around what is left,
      // or a genuine deadlock (a dependency or an `@needs` nothing satisfies).
      const fresh = parsePlanFile(brief.planPath);
      if (allDone(fresh)) { stopReason = "plan_complete"; break; }
      if (routing.steered) { stopReason = "routed_complete"; break; }
      // The same single, bounded, persona-led repair the serial loop gets, through the
      // same writer — a deadlock that recovers on one scheduler and stops on the other
      // would teach the user a lie about what their plan does.
      const dl = await repairDeadlock(brief, cfg, state, routing, fresh, state.iteration);
      writeState(brief.leoDir, state);
      if (dl?.ok) {
        console.log(`  deadlock -> ${dl.persona ? `${dl.persona.name}, ${dl.persona.role}` : "Leopold"} decided: ${dl.accepted.map((a) => a.line.trim()).join(" · ")}`);
        continue;
      }
      deadlockStrands = strandsOf(fresh, routing, readSignals(brief.leoDir));
      deadlockRepair = dl;
      console.warn(renderDeadlockAttempt(dl, deadlockStrands));
      stopReason = "deadlock";
      logEvent(brief.leoDir, {
        event: "deadlock", items: fresh.filter((i) => !i.done).map((i) => i.index),
        repair_attempted: dl !== null, repair_ok: false,
      });
      break;
    }
    await Promise.race(running.values());
  }

  // Let in-flight items settle before tearing down.
  await Promise.allSettled(running.values());

  // Mine the run BEFORE stop() — on_finish:archive moves DECISIONS.md out of place.
  const finished = stopReason === "plan_complete" || stopReason === "routed_complete";
  const learnNote = finished ? await maybeLearn(cfg, brief) : "";
  const humanNote = humanNode ? haltForHuman(brief, state, humanNode, baseRoot) : "";
  stop(stopReason ?? "plan_complete");

  const openLeft = parsePlanFile(brief.planPath).filter((i) => !i.done).map((i) => i.index);
  const routedNote = stopReason === "routed_complete" && openLeft.length
    ? ` The graph routed around item(s) ${openLeft.join(", ")}, which stay open on purpose.`
    : "";
  const tail = conflicts ? ` ${conflicts} item(s) need manual merge (worktrees kept).` : "";
  if (stopReason === "awaiting_human") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs you", `${humanNote}${tail}`);
  } else if (stopReason === "escalation") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs a call from you",
      `Item: ${escalation?.item}\nWorker: ${escalation?.question}\nWhy escalated: ${escalation?.why}\n\n` +
      `The run is paused. Make the call, adjust PLAN.md or CHARTER.md, then re-run.${tail}`);
  } else if (finished) {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold finished",
      `Plan complete for ${brief.root}. Everything is staged for your review; nothing was committed.${routedNote}${tail}${learnNote}`);
  } else if (stopReason === "budget_exceeded") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped",
      `Budget reached: $${(state.spent_usd ?? 0).toFixed(2)} of $${cfg.budgetUsd?.toFixed(2)}. Work so far is staged.${tail}`);
  } else if (stopReason === "deadlock") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped",
      `${renderDeadlockAttempt(deadlockRepair, deadlockStrands)}${tail}`);
  } else {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped", `Run stopped: ${stopReason}.${tail}`);
  }
}
