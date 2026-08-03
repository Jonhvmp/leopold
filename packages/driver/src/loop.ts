// The orchestration loop: the conductor burns down the plan, one fresh worker
// per item, deciding from the charter, with git locked, until the plan is done
// or a stop condition fires. It notifies the human on completion or escalation.
//
// Two modes share one per-item engine (processItem): the default serial loop, and
// a --parallel scheduler that runs independent items concurrently, each in its own
// worktree, replaying each item's diff onto the main tree as a staged patch.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadBrief, initState, writeState, killSwitch, loadConfig, clearRunTokens } from "./config.js";
import { runItem } from "./worker.js";
import { decide } from "./conductor.js";
import { logEvent, logDecision, markItemDone, openItems, nextOpenItem } from "./log.js";
import { notify } from "./notify.js";
import { createWorktree, cleanupWorktree, type Worktree } from "./worktree.js";
import { reapOrphan } from "./reaper.js";
import { overBudget } from "./budget.js";
import { classifyItem } from "./classify.js";
import { smartRoute } from "./route.js";
import { reviewItem, diffIsSensitive, lensesFor } from "./review.js";
import { rootCausePanel, formatLead } from "./hypotheses.js";
import { learnFromRun } from "./learn.js";
import { parsePlanFile, readyItems, allDone, setItemDone, type PlanItem } from "./plan.js";
import { drainCommands } from "./commands.js";
import { headSha, diffAgainst, applyStaged, snapshotTree, restoreTree } from "./git.js";
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
 *  with none produces the same prompt shape it always had (backward compatible). */
export function buildWorkerPrompt(item: string, scenarios: string[], lead?: string, steer?: string, scope: string[] = []): string {
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
    (lead ? `${lead}\n\n` : "") +
    `Do it completely and verify it (build, lint, tests). Decide reversible or charter-clear forks yourself per the mission and charter. When the item is done, or if you hit a fork only the conductor can settle, close your turn with the leopold-status block.`
  );
}

/** Run one plan item to completion in `cwd`: classify → conduct → review gate.
 *  Shared by the serial loop and the parallel scheduler. Exported for the loop
 *  integration test (driven with an injected fake SDK, zero model calls). */
export async function processItem(
  brief: Brief, cfg: DriverConfig, state: RunState, recent: string[],
  item: string, scenarios: string[], cwd: string, lead?: string, steer?: string,
): Promise<ItemOutcome> {
  const klass = cfg.smartRouting
    ? await smartRoute(cfg, brief, item, cwd)
    : classifyItem(item, brief.charter);
  logEvent(brief.leoDir, { event: "item_start", iteration: state.iteration, item, effort: klass.effort, critical: klass.critical, routed: cfg.smartRouting, reason: klass.reason, scenarios: scenarios.length });
  console.log(`\n--- ${item}  [effort=${klass.effort}${klass.critical ? ", critical" : ""}${cfg.smartRouting ? ", smart-routed" : ""}${scenarios.length ? `, ${scenarios.length} scenario(s)` : ""}] ---`);

  // Slice-scoped context (opt-in): when routing researched the item's files, point
  // the worker at that slice instead of the whole repo. Off / no file set = unchanged.
  const scope = cfg.sliceScope ? (klass.files ?? []) : [];
  const workerPrompt = buildWorkerPrompt(item, scenarios, lead, steer, scope);

  // The review gate inspects `cwd`'s diff, so it must see this item's worktree.
  const itemBrief: Brief = { ...brief, worktreeRoot: cwd };
  let escalated = false, itemDone = false, reviewRounds = 0;
  let escalation: Escalation | undefined;
  let lastSummary = "";

  await runItem({
    brief, cfg, item, workerPrompt, cwd, effort: klass.effort,
    onBlock: (tool, reason) => logEvent(brief.leoDir, { event: "guard_block", tool, reason }),
    onCost: (usd) => {
      state.spent_usd = (state.spent_usd ?? 0) + usd;
      logEvent(brief.leoDir, { event: "cost", item, usd, spent_usd: state.spent_usd });
    },
    onTurn: async (status: WorkerStatus): Promise<string | null> => {
      lastSummary = `${status.kind}: ${status.summary}${status.evidence ? `\nEVIDENCE: ${status.evidence}` : ""}`.slice(0, 800);
      logEvent(brief.leoDir, { event: "worker_turn", kind: status.kind, item: status.item || item });
      const verdict = await decide(cfg, brief, status, recent.slice(-5).join("\n"));
      logDecision(brief.leoDir, state.iteration, status, verdict);
      if (verdict.logTitle) recent.push(`${verdict.logTitle}: ${verdict.reply ?? "(finish)"}`);

      if (verdict.action === "finish") {
        // Review gate: an independent pass over the item's diff before it closes.
        if (cfg.review && reviewRounds < cfg.maxReviewRounds) {
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
        escalated = true;
        escalation = { item, question: status.decisionNeeded ?? status.summary, why: verdict.escalationReason ?? "" };
        return null;
      }
      console.log(`  conductor -> ${verdict.reply}`);
      return verdict.reply ?? "Proceed using your best judgment per the charter, then report status.";
    },
  });

  return { done: itemDone, escalated, escalation, detail: lastSummary };
}

/** Run one item, escalating to a best-of-k tournament (R3) when it is critical/max
 *  and the toggle is on. Isolated runs only — the winner is applied with restoreTree,
 *  which never touches the user's live repo. Falls back to a single attempt when
 *  best-of-k is off, the item is ordinary, the run isn't isolated, or no attempt wins.
 *  Each attempt is a full processItem (so the winner already passed the review gate). */
async function runItemOrTournament(
  brief: Brief, cfg: DriverConfig, state: RunState, recent: string[],
  item: string, scenarios: string[], cwd: string, isolated: boolean,
  lead?: string, steer?: string,
): Promise<ItemOutcome> {
  const single = (): Promise<ItemOutcome> => processItem(brief, cfg, state, recent, item, scenarios, cwd, lead, steer);
  const klass = classifyItem(item, brief.charter);
  if (!tournamentEligible({ bestOfK: cfg.bestOfK, isolated, critical: klass.critical, maxEffort: klass.effort === "max" })) {
    return single();
  }

  // Seed each attempt with the current accumulated state (prior items' work).
  const basePatch = snapshotTree(cwd);
  const runAttempt: RunAttempt = async (attemptCwd) => {
    const o = await processItem(brief, cfg, state, recent, item, scenarios, attemptCwd, lead, steer);
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

export async function runDriver(cwd: string, argv: string[]): Promise<void> {
  const brief = loadBrief(cwd);
  // Config honors the brief's GUARDRAILS.md for its toggles (review, hypotheses,
  // smart_routing, learn_on_finish), with CLI/env taking precedence.
  const cfg = loadConfig(argv, brief.guardrails);

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

  if (cfg.parallel > 1) {
    await runParallel(brief, cfg, state, recent, stop);
    return;
  }

  // --- Serial loop -----------------------------------------------------------
  // When an item is retried after a failure, the root-cause panel investigates
  // first and hands the next attempt a concrete lead instead of "try again".
  let lastFailed: { item: string; detail: string } | null = null;
  // Pre-first-attempt tree snapshot for the literal fresh restart (R2). Captured
  // before an item's first attempt in an isolated run; restored on a retry.
  let snapshot: { item: string; patch: string } | null = null;
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
      stop("repeated_failure");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs you", "Too many consecutive failures; stopping.");
      return;
    }

    // Steer channel: apply any canvas commands (redirect/inject/kill/rerun) at this
    // turn boundary, exactly where STOP is honored. Git stays locked (commands only
    // log + flip PLAN.md checkboxes). redirect/inject return guidance for this item.
    const steer = drainCommands(brief);

    const item = nextOpenItem(brief.planPath);
    if (!item) {
      const learnNote = await maybeLearn(cfg, brief);
      stop("plan_complete");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold finished",
        `Plan complete for ${brief.root}. Everything is staged for your review; nothing was committed.${learnNote}`);
      return;
    }

    state.iteration += 1;
    writeState(brief.leoDir, state);

    const cwd = brief.worktreeRoot ?? brief.root;
    const isolated = cwd !== brief.root;
    const isRetry = lastFailed !== null && lastFailed.item === item;

    // Literal fresh restart (R2): on a retry in an isolated worktree, restore the
    // pre-item snapshot so the failed diff is truly discarded (not just reframed),
    // while prior items' staged work survives. Non-isolated or toggle-off falls back
    // to the retryLead framing below. Snapshot the tree on an item's first attempt.
    if (shouldLiteralReset({ isRetry, literalReset: cfg.literalReset, isolated, haveSnapshot: snapshot?.item === item })) {
      const r = restoreTree(cwd, snapshot!.patch);
      logEvent(brief.leoDir, { event: "literal_reset", item, ok: r.ok, err: r.ok ? null : r.err.slice(0, 200) });
      console.log(r.ok
        ? "  literal reset: failed diff discarded, pre-item tree restored."
        : `  literal reset failed (${r.err.slice(0, 120)}) — tree kept, framing fallback.`);
    } else if (!isRetry && cfg.literalReset && isolated) {
      snapshot = { item, patch: snapshotTree(cwd) };
    }

    // On a retry, frame the failed approach as a dead end (retryLead) with the
    // root-cause panel's lead — still right after a literal reset (take a NEW path).
    const lead = isRetry
      ? retryLead(await leadForRetry(brief, cfg, item, cwd, lastFailed!.detail))
      : undefined;
    // The current item is the first open one — carry its @scenario acceptance lines
    // into the worker prompt + review gate (empty for a scenario-less item).
    const scenarios = parsePlanFile(brief.planPath).find((i) => !i.done)?.scenarios ?? [];
    const outcome = await runItemOrTournament(brief, cfg, state, recent, item, scenarios, cwd, isolated, lead, steer);

    if (outcome.escalated) {
      const e = outcome.escalation;
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs a call from you",
        `Item: ${e?.item}\nWorker: ${e?.question}\nWhy escalated: ${e?.why}\n\n` +
        `The run is paused. Make the call, adjust PLAN.md or CHARTER.md if needed, then re-run leopold-driver.`);
      stop("escalation");
      return;
    }
    if (outcome.done) {
      const left = markItemDone(brief.planPath, item);
      state.consecutive_failures = 0;
      lastFailed = null;
      writeState(brief.leoDir, state);
      logEvent(brief.leoDir, { event: "item_done", item, open_left: left });
      console.log(`  done. ${left} items left.`);
    } else {
      state.consecutive_failures += 1;
      lastFailed = { item, detail: outcome.detail ?? "" };
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
  stop: (reason: string) => void,
): Promise<void> {
  const baseRoot = brief.root;
  const runShort = randomUUID().slice(0, 6);
  const inFlight = new Set<number>();
  const running = new Map<number, Promise<void>>();
  // Items that already failed once, with what the failed attempt reported —
  // a re-dispatch runs the root-cause panel first (same lead mechanic as serial).
  const failedDetail = new Map<number, string>();
  let stopReason: string | null = null;
  let escalation: Escalation | undefined;
  let conflicts = 0;

  // Patch application onto the shared main tree must be serialized.
  let applyChain: Promise<void> = Promise.resolve();
  const serialize = (fn: () => void): Promise<void> => {
    applyChain = applyChain.then(() => { fn(); }, () => { fn(); });
    return applyChain;
  };

  async function dispatch(pi: PlanItem, steer?: string): Promise<void> {
    inFlight.add(pi.index);
    const wt = createWorktree(baseRoot, brief.leoDir, `${runShort}-i${pi.index}`);
    const cwd = wt?.path ?? baseRoot;
    const base = headSha(cwd) || "HEAD";
    try {
      const prior = failedDetail.get(pi.index);
      const lead = prior !== undefined
        ? await leadForRetry(brief, cfg, pi.text, cwd, prior)
        : undefined;
      const outcome = await processItem(brief, cfg, state, recent, pi.text, pi.scenarios, cwd, lead, steer);
      if (outcome.escalated) {
        stopReason ??= "escalation";
        escalation ??= outcome.escalation;
        return;
      }
      if (!outcome.done) {
        state.consecutive_failures += 1;
        failedDetail.set(pi.index, outcome.detail ?? "");
        logEvent(brief.leoDir, { event: "item_incomplete", item: pi.text, fails: state.consecutive_failures });
        return;
      }
      failedDetail.delete(pi.index);
      // Replay the item's diff onto the main tree (staged), serialized.
      let applied = true;
      await serialize(() => {
        const patch = diffAgainst(cwd, base);
        const res = applyStaged(baseRoot, patch);
        if (!res.ok) {
          applied = false;
          conflicts += 1;
          logEvent(brief.leoDir, { event: "merge_conflict", item: pi.text, worktree: cwd, err: res.err.slice(0, 300) });
          console.warn(`  ⚠ "${pi.text}" did not apply cleanly onto the main tree — worktree kept at ${cwd} for manual integration.`);
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
    if (state.consecutive_failures >= state.max_failures) { stopReason = "repeated_failure"; break; }

    // Steer channel at the boundary: kill/rerun mutate PLAN.md before we read it;
    // redirect/inject guidance rides along with items dispatched this round.
    const steer = drainCommands(brief);

    const items = parsePlanFile(brief.planPath);
    if (allDone(items)) { stopReason = "plan_complete"; break; }

    const ready = readyItems(items, inFlight);
    while (running.size < cfg.parallel && ready.length && state.iteration < state.max_iterations && !stopReason) {
      const pi = ready.shift()!;
      state.iteration += 1;
      writeState(brief.leoDir, state);
      const p = dispatch(pi, steer).finally(() => running.delete(pi.index));
      running.set(pi.index, p);
    }

    if (running.size === 0) {
      // Nothing ready and nothing running: either done, or a dependency deadlock.
      stopReason = allDone(parsePlanFile(brief.planPath)) ? "plan_complete" : "deadlock";
      break;
    }
    await Promise.race(running.values());
  }

  // Let in-flight items settle before tearing down.
  await Promise.allSettled(running.values());

  // Mine the run BEFORE stop() — on_finish:archive moves DECISIONS.md out of place.
  const learnNote = stopReason === "plan_complete" ? await maybeLearn(cfg, brief) : "";
  stop(stopReason ?? "plan_complete");

  const tail = conflicts ? ` ${conflicts} item(s) need manual merge (worktrees kept).` : "";
  if (stopReason === "escalation") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs a call from you",
      `Item: ${escalation?.item}\nWorker: ${escalation?.question}\nWhy escalated: ${escalation?.why}\n\n` +
      `The run is paused. Make the call, adjust PLAN.md or CHARTER.md, then re-run.${tail}`);
  } else if (stopReason === "plan_complete") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold finished",
      `Plan complete for ${brief.root}. Everything is staged for your review; nothing was committed.${tail}${learnNote}`);
  } else if (stopReason === "budget_exceeded") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped",
      `Budget reached: $${(state.spent_usd ?? 0).toFixed(2)} of $${cfg.budgetUsd?.toFixed(2)}. Work so far is staged.${tail}`);
  } else {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped", `Run stopped: ${stopReason}.${tail}`);
  }
}
