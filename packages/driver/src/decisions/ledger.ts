// The calibration ledger: what was decided, and what happened next.
//
// A threshold is only honest if it was fitted on outcomes. Item 1 could not fit any — this project
// had one archived run and no event log — so `.leopold/decisions/*.json` ships PRIORS. This file is
// how they stop being priors: every provider answer is recorded with its band, and when the
// outcome becomes knowable (the review blocked, the item was retried) that is recorded against it.
//
// APPEND-ONLY, AND TWO RECORDS, NEVER ONE. A decision is written when it is made; an outcome
// arrives turns later and is a separate line joined by `id`. Rewriting the decision line when the
// outcome lands would make the ledger a thing that changes under you — and the one property a
// calibration corpus must have is that a row means what it meant when it was written.

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIRNAME } from "./config.js";
import type { Band } from "./ask.js";

export const LEDGER_BASENAME = "ledger.jsonl";

export interface DecisionRow {
  kind: "decision";
  id: string;
  ts: string;
  consumer: string;
  question: string;
  provider: string;
  model: string;
  /** null for a noul, which has none by construction; `certainty` is the gating scalar. */
  confidence: number | null;
  certainty: number | null;
  band: Band;
  acted: boolean;
}

export interface OutcomeRow {
  kind: "outcome";
  id: string;
  ts: string;
  /** Did the decision turn out to have been right? Null when it cannot be known. */
  correct: boolean | null;
  note?: string;
}

export type LedgerRow = DecisionRow | OutcomeRow;

export function ledgerPath(leoDir: string): string {
  return path.join(leoDir, CONFIG_DIRNAME, LEDGER_BASENAME);
}

/** Append one row. Creates nothing but the file: a project without the module never gets a ledger,
 *  because nothing ever calls this. */
export function appendRow(leoDir: string, row: LedgerRow): void {
  const p = ledgerPath(leoDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + "\n");
}

export function readLedger(leoDir: string): LedgerRow[] {
  const p = ledgerPath(leoDir);
  if (!fs.existsSync(p)) return [];
  const out: LedgerRow[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerRow);
    } catch {
      // A torn last line (a crash mid-append) must not make the whole corpus unreadable.
    }
  }
  return out;
}

/** The minimum decisions-with-outcomes before a question's bars are worth touching. Below this a
 *  "fit" is noise wearing a number, and the proposal says so rather than producing one. */
export const MIN_SAMPLE = 30;

export interface Proposal {
  question: string;
  provider: string;
  samples: number;
  /** null when the sample is too small — the honest answer, not a silent skip. */
  act: number | null;
  reason: string;
}

/** Bucket certainty against observed correctness and PROPOSE a bar. Never writes a catalog.
 *
 *  The proposed `act` is the lowest certainty at which everything at or above it was correct in
 *  this corpus — the weakest bar the evidence actually supports. It is a proposal for a human to
 *  read next to the current value, not a number to apply. */
export function proposeThresholds(rows: LedgerRow[]): Proposal[] {
  const decisions = new Map<string, DecisionRow>();
  for (const r of rows) if (r.kind === "decision") decisions.set(r.id, r);

  const byQuestion = new Map<string, Array<{ certainty: number; correct: boolean }>>();
  for (const r of rows) {
    if (r.kind !== "outcome" || r.correct === null) continue;
    const d = decisions.get(r.id);
    if (!d || d.certainty === null) continue;
    const key = `${d.provider}\u0000${d.question}`;
    const list = byQuestion.get(key) ?? [];
    list.push({ certainty: d.certainty, correct: r.correct });
    byQuestion.set(key, list);
  }

  const proposals: Proposal[] = [];
  for (const [key, samples] of [...byQuestion.entries()].sort()) {
    const [provider, question] = key.split("\u0000");
    if (samples.length < MIN_SAMPLE) {
      proposals.push({
        question,
        provider,
        samples: samples.length,
        act: null,
        reason: `only ${samples.length} decision(s) with a known outcome — ${MIN_SAMPLE} is the floor for fitting a bar, so the current value stands`,
      });
      continue;
    }
    // Candidate bars are the distinct certainties, and a bar is tested by VALUE, never by index:
    // slicing a sorted array at a position cuts through a group of equal certainties and would
    // propose a bar that the rest of its own group contradicts.
    const levels = [...new Set(samples.map((s) => s.certainty))].sort((a, b) => a - b);
    let bar: number | null = null;
    for (const level of levels) {
      const at = samples.filter((s) => s.certainty >= level);
      if (at.every((s) => s.correct)) {
        bar = Number(level.toFixed(2));
        break;
      }
    }
    proposals.push({
      question,
      provider,
      samples: samples.length,
      act: bar,
      reason:
        bar === null
          ? `no certainty in ${samples.length} samples was followed only by correct outcomes — this question may not be answerable by this provider`
          : `every one of the ${samples.filter((s) => s.certainty >= bar!).length} decisions at or above ${bar} was correct, across ${samples.length} samples`,
    });
  }
  return proposals;
}

/** Record what happened to a decision, as a SECOND row.
 *
 *  Called when the outcome becomes knowable — for a routing decision, when the review panel has
 *  closed (or blocked) the item. `correct: null` is a legitimate answer and is kept: it says the
 *  decision was made and the outcome could not be established, which is different from a decision
 *  nobody followed up on. `proposeThresholds` ignores both. */
export function recordOutcome(
  leoDir: string,
  id: string,
  correct: boolean | null,
  note?: string,
): void {
  appendRow(leoDir, {
    kind: "outcome",
    id,
    ts: new Date().toISOString(),
    correct,
    ...(note ? { note } : {}),
  });
}
