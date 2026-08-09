// "What I decided for you": the run's persona decisions, riskiest first, at the end of
// the completion report.
//
// Four stop paths now decide instead of halting, and each one writes a whole block to
// DECISIONS.md. That file is the audit trail and it is deliberately verbose — six fields
// per entry, the charter basis, the fork in full sentences. Nobody opens it at the end of
// a run they are happy with, which means the calls Leopold made ON SOMEONE'S BEHALF are
// discovered later, if at all. So the run says them out loud: five lines at the bottom of
// the report, the riskiest first, each naming WHO decided and HOW TO UNDO IT.
//
// ONE READER FOR THE TRAIL, MIRRORING ITS ONE WRITER. log.ts writes every entry (driver)
// and the workflow script writes the identical block shape (workflow), so reading the
// file back is what makes this work on BOTH ENGINES without threading a decision list
// through two schedulers and a sandboxed script. Nothing here is engine-aware; an entry
// is an entry.
//
// RISK IS ORDERING, NOT A VERDICT. The score exists to put the decision most likely to
// need a human's eye at position 1 — it never suppresses anything, never blocks, and the
// full trail is always one line away. A run with no persona decision renders the empty
// string, so a report that had none before this existed is byte-for-byte what it was.

import fs from "node:fs";
import path from "node:path";
import { FORK_SITUATION, DEFAULT_REVERSAL, NO_PERSONA } from "./persona.js";
import type { PersonaFork } from "./persona.js";

/** One persona decision, as the trail recorded it. */
export interface DecidedEntry {
  /** The `D<n>` ordinal from the heading — how an auditor finds it in DECISIONS.md. */
  n: number;
  /** The fork this decision came up at, recovered from the `Fork:` line. */
  fork: PersonaFork | "unknown";
  /** "Mara Vance — Release Engineer", or the no-persona marker. */
  who: string;
  /** True when synthesis produced no role and the default worker rules applied. */
  noPersona: boolean;
  /** The call, one line. */
  decision: string;
  /** How a human undoes it, one line. Never blank — the writer guarantees that. */
  reversal: string;
  /** Ordering weight. Higher reads first. */
  risk: number;
}

/** How many decisions the summary prints before it defers to the file. The point is that
 *  a human reads five lines instead of hunting a file; a summary that lists twenty is the
 *  file again. Everything above the cap is counted, never hidden. */
export const MAX_SUMMARIZED = 5;

/** Base weight per fork, in the order a human should look at them.
 *
 *  An ESCALATION is first because the worker itself judged the fork beyond what the
 *  charter settles — it is the one place a persona overrode a request for a human, on a
 *  question about the work's substance. A @human node is next: an author wrote it down as
 *  a person's call. Then the two plan-shape repairs, where Leopold edited the plan it was
 *  given. A repeated-failure rescue is last: it changes an approach that was failing
 *  anyway, inside bounds, and its blast radius is one item. */
const FORK_RISK: Record<PersonaFork | "unknown", number> = {
  escalation: 50,
  human: 42,
  deadlock: 34,
  repair: 30,
  "repeated-failure": 22,
  unknown: 26,
};

/** Subject matter that makes a call harder to walk back — production surfaces, data, and
 *  anything outbound. Matched against the decision text; a hit is a nudge up the list,
 *  never a judgement about the decision itself. */
const HEAVY_SUBJECT =
  /\b(prod|production|cutover|deploy|deployed|release|releasing|publish|publishing|ship|shipping|migrat\w*|schema|drop\w*|delete\w*|truncat\w*|credential\w*|secret\w*|token|security|breaking|irreversible|data loss|rollback|customer|billing|payment)\b/i;

/** Recovers the fork from the `Fork:` line, which is written as
 *  `${FORK_SITUATION[fork]}: ${item}` — one reader for what one writer wrote. */
const SITUATION_TO_FORK = new Map<string, PersonaFork>(
  (Object.entries(FORK_SITUATION) as Array<[PersonaFork, string]>).map(([k, v]) => [v, k]),
);

function clip(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

function forkOf(forkLine: string): PersonaFork | "unknown" {
  for (const [situation, fork] of SITUATION_TO_FORK) if (forkLine.startsWith(situation)) return fork;
  return "unknown";
}

/** Where a decision lands in the list. Pure and small on purpose: the ordering has to be
 *  explainable in one sentence ("the fork it came up at, plus what it touches"), because
 *  a ranking nobody can predict is noise with a number on it. */
export function riskOf(e: Omit<DecidedEntry, "risk">): number {
  let risk = FORK_RISK[e.fork] ?? FORK_RISK.unknown;
  // Nobody was synthesized for it: the call was still made, under the default rules.
  // That is exactly the entry a human wants to see before the well-fitted ones.
  if (e.noPersona) risk += 14;
  if (HEAVY_SUBJECT.test(e.decision)) risk += 12;
  // The role stated no reversal of its own and took the default. The default is TRUE —
  // git is locked, so discarding the staged work undoes it — but "how do I undo this
  // specifically" went unanswered, and that is worth a look.
  if (e.reversal === DEFAULT_REVERSAL) risk += 6;
  return risk;
}

/** Read the persona decisions out of a DECISIONS.md body.
 *
 *  A PERSONA ENTRY IS ONE WITH A `Persona:` FIELD. The conductor's own calls
 *  (`logDecision`) and a `@feedback` node's amendments share the file and the block
 *  shape but carry no persona — they are not decisions taken on a human's behalf at a
 *  stop path, so they are not what this summarizes. Tolerant by design: a hand-edited
 *  trail, an entry from an older release, or a block missing a field is skipped, never
 *  thrown over. */
export function parseDecisionTrail(text: string): DecidedEntry[] {
  const out: DecidedEntry[] = [];
  let n = 0;
  let fields: Record<string, string> | null = null;
  let lastKey = "";

  const flush = (): void => {
    const f = fields;
    fields = null;
    lastKey = "";
    if (!f || !f.Persona || !f.Decision) return;
    const noPersona = f.Persona === NO_PERSONA || !f.Persona.includes(" — ");
    const base = {
      n,
      fork: forkOf(f.Fork ?? ""),
      who: clip(f.Persona.split(" (")[0], 90),
      noPersona,
      decision: clip(f.Decision, 220),
      reversal: clip(f.Reversal ?? DEFAULT_REVERSAL, 200) || DEFAULT_REVERSAL,
    };
    out.push({ ...base, risk: riskOf(base) });
  };

  for (const line of String(text ?? "").split("\n")) {
    const head = line.match(/^## D(\d+) —/);
    if (head) {
      flush();
      n = Number(head[1]);
      fields = {};
      continue;
    }
    if (!fields) continue;
    const field = line.match(/^([A-Z][A-Za-z]*):\s*(.*)$/);
    if (field) {
      lastKey = field[1];
      fields[lastKey] = field[2].trim();
      continue;
    }
    // A wrapped continuation line belongs to the field above it, not to nothing.
    if (lastKey && line.trim() && !line.startsWith("#")) fields[lastKey] += " " + line.trim();
  }
  flush();

  // Riskiest first; ties keep the order the run made them in, so two equal decisions
  // read as a story rather than shuffling between runs.
  return out.sort((a, b) => b.risk - a.risk || a.n - b.n);
}

/** The block that ends the report. Empty string when the run decided nothing on the
 *  human's behalf — that is what keeps every pre-persona report byte-identical. */
export function renderDecidedForYou(entries: DecidedEntry[], trailPath = ".leopold/DECISIONS.md"): string {
  if (entries.length === 0) return "";
  const shown = entries.slice(0, MAX_SUMMARIZED);
  const lines = shown.map((e, i) =>
    `  ${i + 1}. [${e.fork}] ${e.who} (D${e.n}): ${e.decision}\n     Reversal: ${e.reversal}`,
  );
  const more = entries.length - shown.length;
  return (
    `\n\nWhat I decided for you (${entries.length} call${entries.length === 1 ? "" : "s"}, riskiest first):\n` +
    lines.join("\n") +
    (more > 0 ? `\n  (+${more} more)` : "") +
    `\nThe full trail — charter basis and why — is in ${trailPath}.`
  );
}

/** The summary for a run, read straight off its trail. Best-effort: no trail, an
 *  unreadable one or an empty one all render nothing, because a notification is not
 *  worth failing a finished run over. */
export function decidedForYou(leoDir: string): string {
  let text = "";
  try {
    text = fs.readFileSync(path.join(leoDir, "DECISIONS.md"), "utf8");
  } catch {
    return "";
  }
  return renderDecidedForYou(parseDecisionTrail(text));
}
