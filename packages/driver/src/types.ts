// Core types shared across the driver.

/** A worker's end-of-cycle status contract. The worker is instructed to close
 *  every turn with a fenced STATUS block; the driver parses it deterministically. */
export type WorkerStatusKind = "done" | "needs-decision" | "blocked" | "working";

export interface WorkerStatus {
  kind: WorkerStatusKind;
  item: string;
  summary: string;
  /** Present when kind === "needs-decision": the question plus options. */
  decisionNeeded?: string;
  next?: string;
  evidence?: string;
  /** Signals the node decided to put on the state channel, parsed from an optional
   *  `SIGNALS: key=value, key2=value2` line. Absent when the worker reported none —
   *  which is every turn of every plan written before the graph grammar existed, so
   *  the status contract is unchanged for them. Never work product: the loop enforces
   *  the channel's ceilings and only accepts keys the item declared with `@emit`. */
  signals?: Record<string, string>;
  /** The raw assistant text the status was parsed from (for logging/escalation). */
  raw: string;
}

/** The conductor's verdict on a worker status. */
export type ConductorAction = "answer" | "finish" | "escalate";

export interface ConductorVerdict {
  action: ConductorAction;
  /** Reply to send back into the worker session when action === "answer". */
  reply?: string;
  classification: "reversible" | "irreversible" | "n/a";
  charterBasis: string;
  /** Decision-log fields (written to DECISIONS.md for non-mechanical calls). */
  logTitle?: string;
  logWhy?: string;
  reversal?: string;
  /** Human-facing reason when action === "escalate". */
  escalationReason?: string;
}

/** How much judgment the run exercises on its own.
 *
 *  `full` (the default): nothing halts for a decision. Work that used to wait for a
 *  person — a `@human` node above all — is executed under a role Leopold synthesizes,
 *  and what it decided is recorded. `ask`: the run stops there exactly as it did before
 *  personas existed, for a plan written against that behavior.
 *
 *  It is a posture on DECISIONS, never on ACTIONS: git stays locked under both, and no
 *  autonomy setting raises a budget, clears the kill switch or edits GUARDRAILS.md. */
export type Autonomy = "full" | "ask";

/** The brief loaded from .leopold/. */
export interface Brief {
  mission: string;
  charter: string;
  guardrails: string;
  planPath: string;
  root: string;
  leoDir: string;
  /** When the run is isolated in a git worktree, the worker's cwd points here
   *  instead of `root`. Set by the driver when --worktree is on. */
  worktreeRoot?: string;
}

/** Mutable run state mirrored to .leopold/state.json.
 *  NOTE: the on-disk state.json is a superset of this — the bash skill/Stop-hook
 *  write extra fields (session_id, max_subagents, …). `writeState` merges rather
 *  than overwrites so those survive; only declare here what the driver owns. */
export interface RunState {
  active: boolean;
  iteration: number;
  max_iterations: number;
  consecutive_failures: number;
  max_failures: number;
  started_at: string;
  stopped_reason?: string;
  /** PID of the orchestrator process, for the orphan reaper's liveness probe. */
  orchestrator_pid?: number;
  /** Isolated worktree for this run (absolute path) and its throwaway branch. */
  worktree_path?: string;
  worktree_branch?: string;
  /** USD budget hard-stop: accumulated real spend and the cap (when set). */
  spent_usd?: number;
  budget_usd?: number;
  /** How many plan items `@feedback` nodes have added THIS RUN. The amendment budget
   *  is run-wide (amend.ts: at most 3), so it lives with the run, not with a node — and
   *  a resumed run inherits what it already spent instead of starting over. Absent on
   *  every run that has no feedback node, which is every run written before them. */
  amendments_added?: number;
  /** True once this run has spent its ONE persona-led change of approach on repeated
   *  failure (rescue.ts). It is a ceiling, not a budget: nothing raises `max_failures`,
   *  and a resumed run inherits that the rescue was spent instead of getting a fresh
   *  one. Absent on every run that never hit the failure ceiling. */
  failure_rescue_used?: boolean;
  /** True once this run has spent its ONE persona-led deadlock repair (repair.ts). Like
   *  the failure rescue it is a ceiling, not a budget: a second deadlock stops the run,
   *  and a resumed run inherits that the repair was spent. Absent on every run that never
   *  stranded an item. */
  deadlock_repair_used?: boolean;
  /** Per plan item (keyed by its text), how many escalations this RUN has settled with a
   *  persona. It lives here and not in `processItem` because `processItem` is re-entered
   *  for EVERY attempt at an item — the serial retry, the parallel re-dispatch, each
   *  best-of-k round — so a local counter reset itself each time and `MAX_ESCALATIONS_SETTLED`
   *  silently meant "two per attempt". An item retried three times could have six forks
   *  decided for it while the CHANGELOG promised a third would stop the run. Absent on
   *  every run that never settles an escalation. */
  escalations_settled?: Record<string, number>;
  /** Set when the run stopped at a `@human` node (`stopped_reason: awaiting_human`):
   *  which plan item is waiting on a person, and what it says. Absent otherwise. */
  awaiting_item?: number;
  awaiting_text?: string;
}

export interface DriverConfig {
  conductorModel?: string;
  workerModel?: string;
  maxTurnsPerItem: number;
  webhookUrl?: string;
  dryRun: boolean;
  /** Isolate the run in a dedicated git worktree (opt-in). */
  worktree: boolean;
  /** USD hard-stop: stop the run once accumulated spend reaches this. */
  budgetUsd?: number;
  /** Review gate: run an independent /code-review pass before an item closes. */
  review: boolean;
  /** Max review→fix rounds per item before the item is allowed to close anyway. */
  maxReviewRounds: number;
  /** Parallel scheduler: run this many independent plan items concurrently
   *  (each in its own worktree). 1 = the default serial loop. */
  parallel: number;
  /** Root-cause hypothesis panel when an item is retried after a failure:
   *  disjoint-evidence investigators + refuters hand the next attempt a lead. */
  hypotheses: boolean;
  /** LLM router that researches the repo before setting an item's effort and
   *  criticality (falls back to the deterministic keyword classifier). */
  smartRouting: boolean;
  /** On a clean finish, mine the run's decisions + git history into proposed
   *  charter amendments (.leopold/CHARTER-amendments.md). Never edits the charter. */
  learnOnFinish: boolean;
  /** Verify the diff against an item's @scenario acceptance lines (R1). Active only
   *  when the item declares scenarios, so scenario-less briefs are unchanged. */
  conformance: boolean;
  /** On a retry in a worktree-isolated run, restore the pre-item snapshot (discard
   *  the failed diff) instead of only reframing the next attempt (R2). Ignored when
   *  the run is not isolated in a worktree — a live repo is never hard-reset. */
  literalReset: boolean;
  /** Best-of-k on a critical/max-effort item: fan out this many attempts in parallel
   *  worktrees, judge, keep the winner. 1 = off (the default single-attempt path). */
  bestOfK: number;
  /** Feed smart_routing's researched file set to the worker as an explicit scope
   *  note instead of the whole repo. No effect unless smartRouting is also on. */
  sliceScope: boolean;
  /** Judgment posture: `full` (default) executes a `@human` node under a synthesized
   *  role; `ask` stops the run at it, as it did before personas. Decisions only — the
   *  git lock, the budgets and the kill switch are identical under both. */
  autonomy: Autonomy;
}
