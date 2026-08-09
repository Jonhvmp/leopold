// Observability: the decision trail (DECISIONS.md), the event stream
// (events.jsonl), and plan bookkeeping (PLAN.md checkboxes).

import fs from "node:fs";
import path from "node:path";
import { personaDecisionFields, DEFAULT_REVERSAL, DEFAULT_WHY } from "./persona.js";
import type { DecisionContext, Persona, PersonaDecision } from "./persona.js";
import type { WorkerStatus, ConductorVerdict } from "./types.js";

export function logEvent(leoDir: string, event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(path.join(leoDir, "events.jsonl"), line + "\n");
}

let decisionCounter = 0;

/** The width the trail's field names are padded to (`Fork:` + 8 spaces). */
const FIELD_WIDTH = 13;

/** Append one block to DECISIONS.md. ONE WRITER for that file: the conductor's calls
 *  and a `@feedback` node's plan amendments both land here, so the audit trail cannot
 *  end up with two shapes depending on who wrote the entry. */
export function appendDecisionBlock(
  leoDir: string,
  heading: string,
  fields: Array<[string, string]>,
): void {
  const block =
    ["", `## ${heading}`, ...fields.map(([k, v]) => `${`${k}:`.padEnd(FIELD_WIDTH)}${v}`), ""].join("\n") + "\n";
  fs.appendFileSync(path.join(leoDir, "DECISIONS.md"), block);
}

export function logDecision(
  leoDir: string,
  iteration: number,
  status: WorkerStatus,
  v: ConductorVerdict,
): void {
  if (!v.logTitle) return; // mechanical calls are not logged as blocks
  decisionCounter += 1;
  appendDecisionBlock(
    leoDir,
    `D${decisionCounter} — ${v.logTitle}   (turn ${iteration}, ${new Date().toISOString()})`,
    [
      ["Fork", status.decisionNeeded ?? status.summary],
      ["Class", v.classification],
      ["Charter", v.charterBasis],
      ["Decision", v.reply ?? "(finish item)"],
      ["Why", v.logWhy ?? ""],
      ["Reversal", v.reversal ?? ""],
    ],
  );
}

/** What bound the role that decided, for the trail's `Charter:` line — the count is what
 *  an auditor checks first ("was it bound at all?"), the first rule is what they read. */
function charterBasisOf(persona?: Persona): string {
  if (!persona) return "no persona was synthesized; the default worker rules applied";
  const n = persona.constraints.length;
  if (n === 0) return `no binding rule found in CHARTER.md — ${persona.role} decided on the mission alone`;
  return `${n} charter rule(s) bind ${persona.role}; first: ${persona.constraints[0]}`;
}

/** Write a PERSONA's decision to the trail, through the same one writer the conductor's
 *  calls go through — same six fields, same numbering, so an auditor reading DECISIONS.md
 *  cannot tell which engine wrote an entry, only who decided and why.
 *
 *  THIS IS THE ONLY WAY A PERSONA PATH LEAVES A TRAIL, and every one of the four goes
 *  through it: `@human` (loop.ts), escalation (loop.ts), graph and deadlock repair
 *  (repair.ts), repeated failure (rescue.ts). A second writer is how two shapes of entry
 *  end up in one file, so there is not one.
 *
 *  SIX FIELDS, ALWAYS, AND NONE OF THEM BLANK. `ctx` carries the fork and the work so an
 *  entry stays whole even when synthesis produced no role (it is best-effort by design):
 *  Persona falls back to `NO_PERSONA`, Why to `DEFAULT_WHY`, Reversal to
 *  `DEFAULT_REVERSAL`. An autonomous call with no way back — or with no record of what it
 *  was even deciding — is the failure mode this whole capability sits one step away
 *  from. */
export function logPersonaDecision(
  leoDir: string,
  iteration: number,
  persona: Persona | undefined,
  d: PersonaDecision,
  ctx?: DecisionContext,
): void {
  decisionCounter += 1;
  const title = persona ? `${persona.name} decided: ${persona.role}` : "Leopold decided (no persona synthesized)";
  appendDecisionBlock(
    leoDir,
    `D${decisionCounter} — ${title}   (turn ${iteration}, ${new Date().toISOString()})`,
    [
      ...personaDecisionFields(persona, ctx),
      ["Class", "n/a"],
      ["Charter", charterBasisOf(persona)],
      ["Decision", d.decision],
      ["Why", d.why || DEFAULT_WHY],
      ["Reversal", d.reversal || DEFAULT_REVERSAL],
    ],
  );
}

export function openItems(planPath: string): number {
  const text = fs.readFileSync(planPath, "utf8");
  return (text.match(/^[ \t]*- \[ \]/gm) ?? []).length;
}

export function nextOpenItem(planPath: string): string | null {
  const text = fs.readFileSync(planPath, "utf8");
  const m = text.match(/^[ \t]*- \[ \] (.*)$/m);
  return m ? m[1].trim() : null;
}

/** Mark the open item whose text matches `itemText` as done; fall back to the
 *  first open item. Returns the number of open items remaining. */
export function markItemDone(planPath: string, itemText: string): number {
  const lines = fs.readFileSync(planPath, "utf8").split("\n");
  const needle = itemText.trim().slice(0, 40);
  let marked = false;
  for (let i = 0; i < lines.length && !marked; i++) {
    if (/^[ \t]*- \[ \]/.test(lines[i]) && (needle === "" || lines[i].includes(needle))) {
      lines[i] = lines[i].replace("- [ ]", "- [x]");
      marked = true;
    }
  }
  if (!marked) {
    for (let i = 0; i < lines.length && !marked; i++) {
      if (/^[ \t]*- \[ \]/.test(lines[i])) {
        lines[i] = lines[i].replace("- [ ]", "- [x]");
        marked = true;
      }
    }
  }
  fs.writeFileSync(planPath, lines.join("\n"));
  return openItems(planPath);
}
