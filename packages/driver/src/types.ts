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
}
