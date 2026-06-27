// The orchestration loop: the conductor burns down the plan, one fresh worker
// per item, deciding from the charter, with git locked, until the plan is done
// or a stop condition fires. It notifies the human on completion or escalation.

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
import { reviewItem, diffIsSensitive } from "./review.js";
import type { WorkerStatus } from "./types.js";

/** The item's uncommitted change set (file list), for sensitivity detection. */
function diffStat(cwd: string): string {
  const r = spawnSync("git", ["--no-pager", "diff", "--stat", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

export async function runDriver(cwd: string, argv: string[]): Promise<void> {
  const cfg = loadConfig(argv);
  const brief = loadBrief(cwd);

  if (cfg.dryRun) {
    console.log("DRY RUN — brief loaded, no workers will run.\n");
    console.log("Mission:\n" + brief.mission.split("\n").slice(0, 10).join("\n"));
    console.log(`\nOpen plan items: ${openItems(brief.planPath)}`);
    console.log("Next item: " + (nextOpenItem(brief.planPath) ?? "(none)"));
    return;
  }

  // Preflight: reap a prior run that crashed leaving state.active === true.
  reapOrphan(brief.root, brief.leoDir);

  // Optional isolation: run inside a dedicated git worktree (the worker's cwd).
  let worktree: Worktree | null = null;
  if (cfg.worktree) {
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
  console.log(`Leopold is conducting "${brief.root}". Git is locked. ${gate} touch .leopold/STOP to halt.\n`);

  const stop = (reason: string) => {
    state.active = false;
    state.stopped_reason = reason;
    writeState(brief.leoDir, state);
    clearRunTokens(brief.leoDir);
    logEvent(brief.leoDir, { event: "stop", reason });
    if (worktree) cleanupWorktree(brief.root, worktree, brief.leoDir);
  };

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
    // Classify the item: drives the worker's reasoning effort, and whether it
    // earns a second-opinion review (the advisor analog).
    const klass = classifyItem(item, brief.charter);
    logEvent(brief.leoDir, { event: "item_start", iteration: state.iteration, item, effort: klass.effort, critical: klass.critical });
    console.log(`\n--- turn ${state.iteration}: ${item}  [effort=${klass.effort}${klass.critical ? ", critical" : ""}] ---`);

    const workerPrompt =
      `Work on this plan item now:\n\n${item}\n\n` +
      `Do it completely and verify it (build, lint, tests). Decide reversible or charter-clear forks yourself per the mission and charter. When the item is done, or if you hit a fork only the conductor can settle, close your turn with the leopold-status block.`;

    let escalated = false;
    let itemDone = false;
    let reviewRounds = 0;

    await runItem({
      brief,
      cfg,
      item,
      workerPrompt,
      effort: klass.effort,
      onBlock: (tool, reason) => logEvent(brief.leoDir, { event: "guard_block", tool, reason }),
      onCost: (usd) => {
        state.spent_usd = (state.spent_usd ?? 0) + usd;
        logEvent(brief.leoDir, { event: "cost", item, usd, spent_usd: state.spent_usd });
      },
      onTurn: async (status: WorkerStatus): Promise<string | null> => {
        logEvent(brief.leoDir, { event: "worker_turn", kind: status.kind, item: status.item || item });
        const verdict = await decide(cfg, brief, status, recent.slice(-5).join("\n"));
        logDecision(brief.leoDir, state.iteration, status, verdict);
        if (verdict.logTitle) recent.push(`${verdict.logTitle}: ${verdict.reply ?? "(finish)"}`);

        if (verdict.action === "finish") {
          // Review gate: an independent pass over the item's diff before it closes.
          // Blocking findings are handed back to the worker (up to maxReviewRounds).
          if (cfg.review && reviewRounds < cfg.maxReviewRounds) {
            const cwd = brief.worktreeRoot ?? brief.root;
            const sensitive = klass.critical || diffIsSensitive(diffStat(cwd));
            const r = await reviewItem(cfg, brief, { sensitive, secondOpinion: klass.critical });
            logEvent(brief.leoDir, { event: "review", item, round: reviewRounds + 1, ok: r.ok, blocking: r.blocking.length, sensitive, second_opinion: klass.critical });
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
          await notify(brief.leoDir, cfg.webhookUrl, "Leopold needs a call from you",
            `Item: ${item}\nWorker: ${status.decisionNeeded ?? status.summary}\nWhy escalated: ${verdict.escalationReason}\n\n` +
            `The run is paused. Make the call, adjust PLAN.md or CHARTER.md if needed, then re-run leopold-driver.`);
          return null;
        }
        console.log(`  conductor -> ${verdict.reply}`);
        return verdict.reply ?? "Proceed using your best judgment per the charter, then report status.";
      },
    });

    if (escalated) {
      stop("escalation");
      return;
    }
    if (itemDone) {
      const left = markItemDone(brief.planPath, item);
      state.consecutive_failures = 0;
      writeState(brief.leoDir, state);
      logEvent(brief.leoDir, { event: "item_done", item, open_left: left });
      console.log(`  done. ${left} items left.`);
    } else {
      state.consecutive_failures += 1;
      writeState(brief.leoDir, state);
      logEvent(brief.leoDir, { event: "item_incomplete", item, fails: state.consecutive_failures });
    }
  }
}
