// The decision event vocabulary, in its own module so a provider can emit without importing
// `ask.ts` (which imports providers — the cycle this file breaks).
//
// These six names are what `leopold watch` renders and what item 16's ledger reads, so the
// union is the contract between the seam, the dashboard and the calibration loop.

export type DecisionEventName =
  | "decision_asked"
  | "decision_answered"
  | "decision_failed"
  | "decision_retry"
  | "decision_timeout"
  /** hooks/permission-policy.sh only: the semantic axis turned a lexical allow into a deny. */
  | "decision_denied";

export interface DecisionEvent {
  event: DecisionEventName;
  provider: string;
  model?: string;
  questions?: string[];
  question?: string;
  reason?: string;
  detail?: string;
  probabilities?: Record<string, number>;
  confidence?: number | null;
  certainty?: number | null;
  threshold_fired?: "act" | "escalate" | "floor";
  elapsed_ms?: number;
  source?: string;
  /** decision_retry only: which attempt just failed, and how long until the next one. */
  attempt?: number;
  delay_ms?: number;
  status?: number;
}
