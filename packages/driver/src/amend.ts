// Plan amendments: how a run may improve its own plan, and everything it may not do.
//
// A `@feedback` node reads the run's own evidence — `.leopold/events.jsonl` plus the
// run metrics — and PROPOSES amendments. It never writes the plan itself: the node is
// read-only (every editing tool denied by the session AND by the guard), it returns
// proposals in a fenced `leopold-amend` block, and THIS module decides which of them
// survive. That separation is the whole design: the model may argue for a change; only
// code applies one.
//
// THE BOUNDS. Enforced here, in code, never merely instructed — an instruction is a
// suggestion to a model, and the difference between a loop that improves its plan and
// one that runs away with it is exactly which of these it can talk its way past:
//
//   add-budget     at most 3 items added per RUN (not per node — the counter lives in
//                  state.json, so a resumed run inherits what it already spent)
//   no-delete      an item is never removed. The plan is the record of what was asked
//   no-touch-done  an item already `[x]` is never rewritten. History is not editable
//   no-guardrails  GUARDRAILS.md is never amended. The autonomy boundary is the
//                  human's, and a run that could widen it has no boundary at all
//   add-only       ADD is the only verb that ever applies
//   work-only      an added item is a plain work item. A feedback node may not author
//                  a `@tool` (a command the driver would then run with no model in the
//                  loop), a `@human`, a gate, or another feedback node
//   malformed      one checkbox line of real text, and any `(after: N)` it carries
//                  must point at an item that exists
//
// APPEND-ONLY, ALWAYS. Accepted items go at the END of PLAN.md, so every existing
// item's 1-based index — which is what `(after:)`, `@on` routes and the scheduler's
// bookkeeping all speak in — is unchanged by an amendment. That is what makes an
// amendment safe to apply mid-run and trivial to reverse.
//
// THE TRAIL. Every accepted amendment appends a DECISIONS.md block with the same
// Fork/Class/Charter/Decision/Why/Reversal shape the conductor writes (one writer:
// log.ts owns that file), and its Reversal line names the exact line to delete. Every
// refusal is logged to events.jsonl with the BOUND that refused it, so an attempt to
// widen the run's own authority leaves a record of the attempt.
//
// A plan with no `@feedback` node never reaches this module: nothing here runs, and
// PLAN.md is not opened, let alone written.

import fs from "node:fs";
import { parsePlan } from "./plan.js";
import { logEvent, appendDecisionBlock } from "./log.js";

/** The run-wide ceiling on added items. */
export const MAX_ADDED_ITEMS = 3;
/** An amendment is a checkbox line, not a document. */
export const MAX_ITEM_TEXT = 300;

/** What a proposal asks for. Everything but `add` exists so it can be REFUSED BY NAME —
 *  a silent drop teaches nobody which bound stopped it. */
export type AmendOp = "add" | "delete" | "edit" | "guardrails" | "unknown";

/** One line of a feedback node's `leopold-amend` block, exactly as it was written. */
export interface AmendProposal {
  op: AmendOp;
  /** The item text for `add`, the replacement text for `edit`, "" otherwise. */
  text: string;
  /** 1-based plan index the proposal points at, when it named one. */
  target?: number;
  /** The proposal line as written, for the log. */
  raw: string;
}

/** The bound that refused an amendment. One code per rule, so a caller (or a test) can
 *  assert on the rule rather than on prose. */
export type AmendBound =
  | "add-budget" | "no-delete" | "no-touch-done" | "no-guardrails"
  | "add-only" | "work-only" | "malformed";

/** The rule each bound states, in the words the log and the console use. */
export const BOUND_RULE: Record<AmendBound, string> = {
  "add-budget": `a feedback node may add at most ${MAX_ADDED_ITEMS} items per run`,
  "no-delete": "a feedback node may never delete a plan item",
  "no-touch-done": "a feedback node may never touch an item already marked done",
  "no-guardrails": "a feedback node may never edit GUARDRAILS.md",
  "add-only": "a feedback node may only ADD items",
  "work-only": "a feedback node may only add a plain work item, never a node kind it would then execute",
  malformed: `an added item is one checkbox line of text (at most ${MAX_ITEM_TEXT} characters) whose (after: N) points at an item that exists`,
};

export interface AmendRefused {
  proposal: AmendProposal;
  bound: AmendBound;
  /** The rule, plus what this particular proposal did to hit it. */
  reason: string;
}

/** An amendment that survived every bound. */
export interface AmendAccepted {
  proposal: AmendProposal;
  /** 1-based index the added item will have — always past every existing item. */
  index: number;
  /** The item's text, normalized (markers stripped, whitespace collapsed). */
  text: string;
  /** The exact line appended to PLAN.md, which is also the line the Reversal names. */
  line: string;
}

/** The verdict on a batch of proposals, and the plan text that carries the accepted
 *  ones. Pure — `applyAmendments` is the half that touches the disk. */
export interface AmendJudgment {
  accepted: AmendAccepted[];
  refused: AmendRefused[];
  /** The amended plan text. Identical to the input when nothing was accepted. */
  planText: string;
}

// The verbs a proposal may open with. Tolerant of `- ADD: …` and `ADD …` because a
// model writes these by hand and the grammar is not the point — the bounds are.
const BULLET = /^[-*+][ \t]+/;
const VERB = /^(add|append|new|delete|remove|drop|edit|change|rewrite|update|guardrails?)\b[ \t]*:?[ \t]*/i;
const TARGET = /^(?:item[ \t]+)?#?(\d+)\b[ \t]*:?[ \t]*/i;
const NOTHING = /^(none|n\/a|no changes?|nothing|\(none\)|-{1,3})$/i;
const DEP_MARKER = /^\((?:after|deps)\s*:\s*([0-9,\s]+)\)\s*/i;
const CHECKBOX_PREFIX = /^-?[ \t]*\[[ xX]\][ \t]*/;

const OP_OF: Record<string, AmendOp> = {
  add: "add", append: "add", new: "add",
  delete: "delete", remove: "delete", drop: "delete",
  edit: "edit", change: "edit", rewrite: "edit", update: "edit",
  guardrail: "guardrails", guardrails: "guardrails",
};

/** Parse the LAST fenced `leopold-amend` block out of a feedback node's turn.
 *
 *  Last, not all, for the same reason `parseStatus` keeps the last status block: a node
 *  that restates its proposals after thinking again must not have both versions applied.
 *  No block at all — the overwhelmingly common case, since most feedback nodes conclude
 *  the plan is fine — parses to zero proposals and touches nothing.
 *
 *      ```leopold-amend
 *      ADD: Add a regression test for the routing latch
 *      DELETE: 4
 *      ```
 */
export function parseAmendments(text: string): AmendProposal[] {
  const fence = /```leopold-amend\s*([\s\S]*?)```/gi;
  let body: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) body = m[1];
  if (body === null) return [];

  const out: AmendProposal[] = [];
  for (const rawLine of body.split("\n")) {
    const raw = rawLine.trim();
    if (!raw || NOTHING.test(raw)) continue;
    const line = raw.replace(BULLET, "");
    const v = line.match(VERB);
    if (!v) {
      out.push({ op: "unknown", text: line, raw });
      continue;
    }
    const op = OP_OF[v[1].toLowerCase()] ?? "unknown";
    let rest = line.slice(v[0].length).trim();
    let target: number | undefined;
    const t = rest.match(TARGET);
    // Only a proposal ABOUT an existing item takes a leading number as its target; an
    // added item may legitimately start with a digit ("2 more tests for the parser").
    if (t && (op === "delete" || op === "edit")) {
      target = parseInt(t[1], 10);
      rest = rest.slice(t[0].length).trim();
    }
    out.push({ op, text: rest, raw, ...(target !== undefined ? { target } : {}) });
  }
  return out;
}

/** Strip what a model tends to wrap an item in — a bullet, a checkbox, a heading mark,
 *  surrounding quotes — and collapse it to the single line PLAN.md carries. */
function normalizeItemText(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  t = t.replace(BULLET, "").replace(CHECKBOX_PREFIX, "").replace(/^#+[ \t]*/, "");
  const q = t.match(/^"([\s\S]*)"$|^'([\s\S]*)'$/);
  if (q) t = (q[1] ?? q[2] ?? "").trim();
  return t.trim();
}

/** Judge a batch of proposals against the bounds. PURE: no file is read or written, no
 *  event is logged, so every bound is testable without a filesystem, a model or a clock.
 *
 *  `remaining` is how many items this run may still add. Proposals are judged in the
 *  order written, so "the first 3 are applied, the rest refused" is exactly what a plan
 *  that proposes 5 gets — the node's own priority order decides which 3 survive. */
export function judgeAmendments(
  planText: string,
  proposals: AmendProposal[],
  remaining: number,
): AmendJudgment {
  const items = parsePlan(planText);
  const done = new Set(items.filter((i) => i.done).map((i) => i.index));
  let count = items.length;
  let budget = Math.max(0, remaining);
  const accepted: AmendAccepted[] = [];
  const refused: AmendRefused[] = [];
  // Every accepted line is appended at the end, so no existing index moves.
  let text = planText.replace(/\n*$/, "\n");

  const refuse = (proposal: AmendProposal, bound: AmendBound, detail = ""): void => {
    refused.push({ proposal, bound, reason: detail ? `${BOUND_RULE[bound]} — ${detail}` : BOUND_RULE[bound] });
  };

  for (const p of proposals) {
    if (p.op === "guardrails") {
      refuse(p, "no-guardrails");
      continue;
    }
    if (p.op === "delete") {
      const which = p.target ? `item ${p.target}` : "an item";
      refuse(p, "no-delete", `it asked to delete ${which}`);
      continue;
    }
    if (p.op === "edit") {
      // A done item gets the bound that is actually about it; anything else is refused
      // as "not an ADD", which is the rule that covers every remaining verb.
      if (p.target !== undefined && done.has(p.target)) {
        refuse(p, "no-touch-done", `item ${p.target} is already marked done`);
      } else {
        refuse(p, "add-only", `it asked to edit ${p.target ? `item ${p.target}` : "an item"}`);
      }
      continue;
    }
    if (p.op !== "add") {
      refuse(p, "add-only", `"${p.raw.slice(0, 60)}" is not an ADD`);
      continue;
    }

    const clean = normalizeItemText(p.text);
    if (!clean) {
      refuse(p, "malformed", "it added no text");
      continue;
    }
    if (clean.length > MAX_ITEM_TEXT) {
      refuse(p, "malformed", `it is ${clean.length} characters`);
      continue;
    }
    const dep = clean.match(DEP_MARKER);
    if (dep) {
      const bad = dep[1].split(",").map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && (n < 1 || n > count));
      if (bad.length) {
        refuse(p, "malformed", `it depends on item ${bad.join(", ")}, which does not exist`);
        continue;
      }
    }
    if (/^@/.test(dep ? clean.slice(dep[0].length) : clean)) {
      refuse(p, "work-only", `it declares "${clean.slice(0, 40)}"`);
      continue;
    }
    if (budget <= 0) {
      refuse(p, "add-budget", `${MAX_ADDED_ITEMS - Math.max(0, remaining) + accepted.length} already added this run`);
      continue;
    }

    count += 1;
    budget -= 1;
    const line = `- [ ] ${clean}`;
    text += `\n${line}\n`;
    accepted.push({ proposal: p, index: count, text: clean, line });
  }

  return { accepted, refused, planText: accepted.length ? text : planText };
}

/** Everything `applyAmendments` needs to know about who is proposing and how much of
 *  the run's amendment budget is already spent. */
export interface AmendContext {
  leoDir: string;
  planPath: string;
  /** 1-based plan index of the `@feedback` node proposing. */
  by: number;
  /** That node's item text, for the decision trail. */
  byText: string;
  /** Items already added by THIS run (state.json), so the budget is run-wide. */
  alreadyAdded: number;
  /** The run's turn number, for the DECISIONS.md heading. */
  iteration?: number;
}

export interface AmendResult {
  accepted: AmendAccepted[];
  refused: AmendRefused[];
  /** How many items were appended — what the caller adds to the run's counter. */
  added: number;
}

/** Judge the proposals, write the survivors to PLAN.md, and log both halves.
 *
 *  PLAN.md is opened for writing ONLY when at least one amendment survives every bound,
 *  so a batch that is entirely refused leaves the file byte-identical on disk. */
export function applyAmendments(ctx: AmendContext, proposals: AmendProposal[]): AmendResult {
  if (proposals.length === 0) return { accepted: [], refused: [], added: 0 };

  const planText = fs.readFileSync(ctx.planPath, "utf8");
  const j = judgeAmendments(planText, proposals, MAX_ADDED_ITEMS - ctx.alreadyAdded);
  if (j.accepted.length) fs.writeFileSync(ctx.planPath, j.planText);

  for (const a of j.accepted) {
    logEvent(ctx.leoDir, {
      event: "amendment", item: ctx.by, added: a.index, text: a.text,
    });
    appendDecisionBlock(
      ctx.leoDir,
      `Plan amended — item ${a.index} added by the @feedback node at item ${ctx.by}` +
      `   (turn ${ctx.iteration ?? 0}, ${new Date().toISOString()})`,
      [
        ["Fork", `add "${a.text}" to the plan vs leave the plan as the human wrote it`],
        ["Class", "reversible"],
        ["Charter", BOUND_RULE["add-budget"] + ", never delete, never touch a done item, never edit GUARDRAILS"],
        ["Decision", `appended item ${a.index}: ${a.line}`],
        ["Why", `the @feedback node at item ${ctx.by} ("${ctx.byText.slice(0, 80)}") proposed it from the run's own events.jsonl and metrics, and it clears every bound`],
        ["Reversal", `delete the line "${a.line}" at the end of ${ctx.planPath} — items are appended, so no existing item's index moved`],
      ],
    );
  }
  for (const r of j.refused) {
    logEvent(ctx.leoDir, {
      event: "amendment_refused", item: ctx.by, op: r.proposal.op,
      bound: r.bound, reason: r.reason, proposal: r.proposal.raw.slice(0, 200),
    });
  }

  return { accepted: j.accepted, refused: j.refused, added: j.accepted.length };
}
