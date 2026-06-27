// Per-item risk classification → reasoning effort + criticality.
//
// Cheap, deterministic, and dependency-free: no extra LLM call. The conductor
// would charge a turn to decide this; a keyword pass over the item text and the
// charter gets the same signal for free and is unit-testable. The output drives
// two things in loop.ts: the worker's SDK `effort` for the item, and whether the
// item earns a second-opinion review pass (the advisor analog — the SDK has no
// advisor, so criticality buys an independent reviewer instead).

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ItemClass {
  effort: Effort;
  /** Critical items get a second, independent review pass (advisor analog). */
  critical: boolean;
  reason: string;
}

// Touching money, identity, data integrity, or anything hard to walk back.
const CRITICAL =
  /\b(billing|payment|invoice|charge|checkout|subscription|stripe|paywall|auth|authn|authz|login|signup|session|password|credential|secret|token|api[\s-]?key|oauth|jwt|crypto|encrypt|decrypt|signing|security|permission|access[\s-]?control|rbac|migrat|schema|ddl|drop\s+table|database|destruct|irreversible|delete|deploy|release|production|infra|terraform|kubernetes|dns)\b/i;

// Cosmetic / low-blast-radius work.
const TRIVIAL =
  /\b(typo|rename|renaming|comment|comments|docs?|readme|changelog|format|formatting|lint|whitespace|wording|copy[\s-]?edit|label|spelling|punctuation|bump\s+version)\b/i;

// Within critical work, the sharpest edges deserve the deepest effort.
const SHARP = /\b(migrat|schema|ddl|drop\s+table|irreversible|destruct|payment|billing|crypto|security|auth)\b/i;

/** Classify a plan item. `charter` raises the floor when the project as a whole
 *  declares itself high-risk (e.g. a charter line mentioning billing/security). */
export function classifyItem(item: string, charter = ""): ItemClass {
  const text = item.trim();

  if (CRITICAL.test(text)) {
    const sharp = SHARP.test(text);
    return {
      effort: sharp ? "max" : "high",
      critical: true,
      reason: `critical: matches risk keyword${sharp ? " (sharp edge → max effort)" : ""}`,
    };
  }

  // A charter that flags the whole project as sensitive bumps an otherwise
  // ordinary item up to high (but not to the second-opinion "critical" tier).
  if (/\b(high[\s-]?risk|security[\s-]?critical|handles?\s+(money|payments?|pii|secrets?))\b/i.test(charter)) {
    if (TRIVIAL.test(text)) return { effort: "low", critical: false, reason: "trivial item (charter high-risk, but cosmetic)" };
    return { effort: "high", critical: false, reason: "charter flags the project high-risk" };
  }

  if (TRIVIAL.test(text)) {
    return { effort: "low", critical: false, reason: "trivial: cosmetic / low blast radius" };
  }

  return { effort: "medium", critical: false, reason: "default: ordinary change" };
}
