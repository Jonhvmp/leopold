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
}

/** Mutable run state mirrored to .leopold/state.json. */
export interface RunState {
  active: boolean;
  iteration: number;
  max_iterations: number;
  consecutive_failures: number;
  max_failures: number;
  started_at: string;
  stopped_reason?: string;
}

export interface DriverConfig {
  conductorModel?: string;
  workerModel?: string;
  maxTurnsPerItem: number;
  webhookUrl?: string;
  dryRun: boolean;
}
