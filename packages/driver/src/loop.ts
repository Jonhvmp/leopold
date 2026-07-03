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
import { parsePlanFile, readyItems, allDone, setItemDone, type PlanItem } from "./plan.js";
import { headSha, diffAgainst, applyStaged } from "./git.js";
import type { Brief, DriverConfig, RunState, WorkerStatus } from "./types.js";

/** The item's uncommitted change set (file list), for sensitivity detection. */
function diffStat(cwd: string): string {
  const r = spawnSync("git", ["--no-pager", "diff", "--stat", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : "";
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

/** Run one plan item to completion in `cwd`: classify → conduct → review gate.
 *  Shared by the serial loop and the parallel scheduler. */
async function processItem(
  brief: Brief, cfg: DriverConfig, state: RunState, recent: string[],
  item: string, cwd: string, lead?: string,
): Promise<ItemOutcome> {
  const klass = cfg.smartRouting
    ? await smartRoute(cfg, brief, item, cwd)
    : classifyItem(item, brief.charter);
  logEvent(brief.leoDir, { event: "item_start", iteration: state.iteration, item, effort: klass.effort, critical: klass.critical, routed: cfg.smartRouting, reason: klass.reason });
  console.log(`\n--- ${item}  [effort=${klass.effort}${klass.critical ? ", critical" : ""}${cfg.smartRouting ? ", smart-routed" : ""}] ---`);

  const workerPrompt =
    `Work on this plan item now:\n\n${item}\n\n` +
    (lead ? `${lead}\n\n` : "") +
    `Do it completely and verify it (build, lint, tests). Decide reversible or charter-clear forks yourself per the mission and charter. When the item is done, or if you hit a fork only the conductor can settle, close your turn with the leopold-status block.`;

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
          const lenses = lensesFor({ sensitive, critical: klass.critical });
          const r = await reviewItem(cfg, itemBrief, { sensitive, critical: klass.critical });
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

export async function runDriver(cwd: string, argv: string[]): Promise<void> {
  const cfg = loadConfig(argv);
  const brief = loadBrief(cwd);

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

  logEvent(brief.leoDir, {
    event: "run_start", conductor: cfg.conductorModel,
    worktree: worktree?.path ?? null, budget_usd: cfg.budgetUsd ?? null,
    review: cfg.review, parallel: cfg.parallel,
  });
  const gate = cfg.review ? `Review gate on (${cfg.maxReviewRounds} rounds/item).` : "Review gate off.";
  const mode = cfg.parallel > 1 ? `Parallel x${cfg.parallel}.` : "";
  console.log(`Leopold is conducting "${brief.root}". Git is locked. ${gate} ${mode} touch .leopold/STOP to halt.\n`.replace(/\s+/g, " "));

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

    const item = nextOpenItem(brief.planPath);
    if (!item) {
      stop("plan_complete");
      await notify(brief.leoDir, cfg.webhookUrl, "Leopold finished",
        `Plan complete for ${brief.root}. Everything is staged for your review; nothing was committed.`);
      return;
    }

    state.iteration += 1;
    writeState(brief.leoDir, state);

    const cwd = brief.worktreeRoot ?? brief.root;
    const lead = lastFailed?.item === item
      ? await leadForRetry(brief, cfg, item, cwd, lastFailed.detail)
      : undefined;
    const outcome = await processItem(brief, cfg, state, recent, item, cwd, lead);

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

  async function dispatch(pi: PlanItem): Promise<void> {
    inFlight.add(pi.index);
    const wt = createWorktree(baseRoot, brief.leoDir, `${runShort}-i${pi.index}`);
    const cwd = wt?.path ?? baseRoot;
    const base = headSha(cwd) || "HEAD";
    try {
      const prior = failedDetail.get(pi.index);
      const lead = prior !== undefined
        ? await leadForRetry(brief, cfg, pi.text, cwd, prior)
        : undefined;
      const outcome = await processItem(brief, cfg, state, recent, pi.text, cwd, lead);
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

    const items = parsePlanFile(brief.planPath);
    if (allDone(items)) { stopReason = "plan_complete"; break; }

    const ready = readyItems(items, inFlight);
    while (running.size < cfg.parallel && ready.length && state.iteration < state.max_iterations && !stopReason) {
      const pi = ready.shift()!;
      state.iteration += 1;
      writeState(brief.leoDir, state);
      const p = dispatch(pi).finally(() => running.delete(pi.index));
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
  stop(stopReason ?? "plan_complete");

  const tail = conflicts ? ` ${conflicts} item(s) need manual merge (worktrees kept).` : "";
  if (stopReason === "escalation") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs a call from you",
      `Item: ${escalation?.item}\nWorker: ${escalation?.question}\nWhy escalated: ${escalation?.why}\n\n` +
      `The run is paused. Make the call, adjust PLAN.md or CHARTER.md, then re-run.${tail}`);
  } else if (stopReason === "plan_complete") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold finished",
      `Plan complete for ${brief.root}. Everything is staged for your review; nothing was committed.${tail}`);
  } else if (stopReason === "budget_exceeded") {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped",
      `Budget reached: $${(state.spent_usd ?? 0).toFixed(2)} of $${cfg.budgetUsd?.toFixed(2)}. Work so far is staged.${tail}`);
  } else {
    await notify(brief.leoDir, cfg.webhookUrl, "Leopold stopped", `Run stopped: ${stopReason}.${tail}`);
  }
}
