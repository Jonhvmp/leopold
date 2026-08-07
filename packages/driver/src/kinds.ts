// What the engine DOES with each node kind.
//
// plan.ts parses `@node work|gate|human|tool|verify` (and the shorthands); graph.ts
// routes on the edges between nodes. This module is the third piece: the behavior a
// kind BUYS. A kind with no distinct behavior does not ship, so each one here is a
// different execution path in the scheduler:
//
//   work    the default — a fresh worker session that edits the repo. Unchanged, and
//           it is what every plan written before this grammar existed compiles to.
//   gate    a REVIEW-ONLY worker: it reads the uncommitted diff and returns a verdict.
//   verify  the same review-only node, aimed at proof instead of judgement: it re-runs
//           the build/lint/tests read-only and says whether the work actually holds.
//   tool    a COMMAND. No model turn is spent: the driver runs it, and its exit status
//           becomes the `exit` signal on the state channel.
//   human   a PERSON decides. The run stops (`awaiting_human`), names the item, and
//           stages everything for whoever picks it up.
//   feedback the run READS ITSELF: a review-only session over `.leopold/events.jsonl`
//           and the run metrics that may propose plan amendments. It cannot apply one —
//           it returns proposals, amend.ts enforces the bounds, and the driver writes
//           what survives. See amend.ts for the bounds and why they live in code.
//
// Pure on purpose — every rule below is a function of the item's text and kind, so the
// scheduler's behavior is unit-testable without a model, a repo or a clock.

import { MAX_ADDED_ITEMS, MAX_ITEM_TEXT } from "./amend.js";
import type { PlanNodeKind } from "./plan.js";

/** The tools a review-only node may never call. Denied twice — as `disallowedTools`
 *  on the session and in the driver's own guard — because "no edits" is a promise the
 *  gate makes to the diff it is judging. */
export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

/** The signal a `@tool` node always puts on the channel: its command's exit status, as
 *  a string (`"0"`). Implicitly declared — a tool node need not write `@emit exit` for
 *  `@on exit=0 -> 5` to work, because the exit status is not a choice the node makes. */
export const TOOL_EXIT_SIGNAL = "exit";

/** Exit status recorded when the command was killed by the timeout (the shell's
 *  convention for "timed out"), so `@on exit=124` is a writable rule. */
export const TOOL_TIMEOUT_EXIT = 124;

/** How long a `@tool` command may run before the driver kills it. Long enough for a
 *  full test suite, short enough that a hung command cannot hold a run forever. */
export const TOOL_TIMEOUT_MS = 30 * 60_000;

/** gate / verify — the node judges the work; it never edits it. */
export function isReviewOnly(kind: PlanNodeKind): boolean {
  return kind === "gate" || kind === "verify";
}

/** human — the run stops here and asks. */
export function haltsRun(kind: PlanNodeKind): boolean {
  return kind === "human";
}

/** tool — a command, run by the driver, with no model turn. */
export function isTool(kind: PlanNodeKind): boolean {
  return kind === "tool";
}

/** feedback — the run reads its own evidence and may propose plan amendments. */
export function isFeedback(kind: PlanNodeKind): boolean {
  return kind === "feedback";
}

/** Every kind that runs a session which must NOT touch the working tree: the two
 *  judging kinds and the feedback node. One predicate, because "no edits" is enforced
 *  the same way for all three — `disallowedTools` on the session AND the guard. */
export function isReadOnlyNode(kind: PlanNodeKind): boolean {
  return isReviewOnly(kind) || isFeedback(kind);
}

/** The command a `@tool` node runs: the first backticked span in the item's text, or
 *  the whole text when it has none. Both forms read naturally in a checklist —
 *  `- [ ] @tool make test` and ``- [ ] @tool run the suite: `make test` `` — and the
 *  backticks are what a human already reaches for when quoting a command in markdown.
 *  Empty string when the item declares nothing to run; the caller refuses it by name. */
export function toolCommand(text: string): string {
  const m = text.match(/`([^`]+)`/);
  return (m ? m[1] : text).trim();
}

/** The system prompt a review-only node runs under. Same status-block contract as a
 *  worker (the driver parses one protocol), opposite authority: read, judge, report. */
export function reviewNodeAppend(kind: PlanNodeKind, label = ""): string {
  const focus =
    kind === "verify"
      ? `This is a VERIFY node: prove the work actually holds. Re-run what the item needs (build, lint, tests) READ-ONLY and judge the evidence, not the claim. "It should work" is a fail; a green run you executed yourself is a pass.`
      : `This is a GATE node${label ? ` labelled "${label}"` : ""}: judge the uncommitted diff against the concern this item states. Be specific and conservative — name the file and the defect, and pass a clean diff instead of inventing work.`;
  return `You are a Leopold ${kind.toUpperCase()} node, conducted by an autonomous orchestrator. No human is watching live. This node JUDGES; it never edits.
- ${focus}
- You have NO write access. Edit/Write/MultiEdit/NotebookEdit are denied, the guard refuses them, and your shell may not write under \`.leopold/\` either: do not try to fix what you find. Report it — the plan decides who fixes it.
- Start from the change itself: \`git --no-pager diff HEAD\` (and \`--stat\` for the file list). Read surrounding code with Read/Grep as needed. Read-only shell is yours; anything that writes to the repo is not.
- Do NOT ask the human anything, and never git commit or git push.
- Close EVERY turn with a fenced status block, then stop:

\`\`\`leopold-status
STATUS: done | needs-decision | blocked
ITEM: <the item you are judging>
SUMMARY: <your verdict, 1-3 lines>
DECISION-NEEDED: <if needs-decision: the exact question + options A/B + the tradeoff; else empty>
NEXT: <what you think comes next>
EVIDENCE: <what you read or ran>
\`\`\`

STATUS: done means THE GATE PASSES. STATUS: blocked means it does not — put exactly what fails in SUMMARY; the plan routes on that outcome. Use needs-decision only for a genuine fork the charter cannot settle.`;
}

/** The system prompt a `@feedback` node runs under. Same read-only authority as a gate,
 *  aimed at the RUN instead of the diff — and it states the bounds so the node argues
 *  inside them. The bounds do not depend on it reading this: amend.ts enforces every
 *  one in code, and a proposal that breaks one is refused by name, not by persuasion. */
export function feedbackNodeAppend(label = ""): string {
  return `You are a Leopold FEEDBACK node${label ? ` labelled "${label}"` : ""}, conducted by an autonomous orchestrator. No human is watching live. This node READS THE RUN and may propose changes to the plan; it never makes them.
- Your evidence is the run itself: \`.leopold/events.jsonl\` (every item start, gate verdict, route taken, signal, cost and failure), \`.leopold/state.json\` (iteration, failures, spend), \`.leopold/PLAN.md\` and \`.leopold/DECISIONS.md\`. Read them. An opinion with no line from the log behind it is not feedback.
- You have NO write access. Edit/Write/MultiEdit/NotebookEdit are denied, and your shell may READ everything under \`.leopold/\` but write none of it — the guard refuses a command that would. Do NOT try to edit PLAN.md: proposing is your whole job, and the driver applies what clears the bounds.
- Propose only what the EVIDENCE demands. The strongest feedback is usually "the plan is right, change nothing" — say that and propose nothing rather than inventing work.
- Do NOT ask the human anything, and never git commit or git push.

THE BOUNDS, enforced in code by the driver (a proposal that breaks one is refused and logged, not applied):
- At most ${MAX_ADDED_ITEMS} items may be added to the plan per RUN, appended at the end.
- An item is NEVER deleted, and an item already marked [x] is NEVER touched.
- GUARDRAILS.md is NEVER amended — that boundary is the human's.
- An added item is a plain work item: one line of at most ${MAX_ITEM_TEXT} characters, no \`@gate\`/\`@tool\`/\`@human\`/\`@verify\`/\`@feedback\` marker, and any \`(after: N)\` must point at an item that already exists.

To propose, emit ONE fenced block before your status block — omit it entirely when you propose nothing:

\`\`\`leopold-amend
ADD: <the item, exactly as it should read in PLAN.md>
ADD: <another, most important first — if more are proposed than the budget allows, the later ones are refused>
\`\`\`

Then close EVERY turn with a fenced status block, and stop:

\`\`\`leopold-status
STATUS: done | needs-decision | blocked
ITEM: <this feedback item>
SUMMARY: <what the run's own evidence shows, 1-3 lines>
DECISION-NEEDED: <if needs-decision: the exact question + options A/B + the tradeoff; else empty>
NEXT: <what you think comes next>
EVIDENCE: <the events/metrics you read>
\`\`\`

STATUS: done means you finished reading and reported — whether or not you proposed anything. Use blocked only if you could not read the run at all.`;
}

/** The instruction a `@feedback` node opens with. */
export function buildFeedbackPrompt(
  item: string,
  scenarios: string[] = [],
  steer?: string,
  signals = "",
): string {
  return (
    (steer ? `${steer}\n\n` : "") +
    `Run this feedback item now — read the run's own evidence and report. You may read and run read-only commands; you may NOT edit anything:\n\n${item}\n\n` +
    (scenarios.length
      ? `The item promised this. Check EVERY one against what the run actually did (given→when→then):\n` +
        scenarios.map((s, i) => `  ${i + 1}. ${s}`).join("\n") + `\n\n`
      : "") +
    signals +
    `If — and only if — the evidence shows the plan is missing work, propose it in a \`leopold-amend\` block (ADD lines, most important first). Then report in the leopold-status block.`
  );
}

/** The instruction a review-only node opens with. Deliberately not the worker's
 *  prompt: nothing here asks for edits, and its definition of done is a verdict. */
export function buildReviewNodePrompt(
  kind: PlanNodeKind,
  item: string,
  scenarios: string[] = [],
  steer?: string,
  signals = "",
): string {
  return (
    (steer ? `${steer}\n\n` : "") +
    `${kind === "verify" ? "Verify" : "Review"} this plan item now — you may read and run read-only commands, but you may NOT edit anything:\n\n${item}\n\n` +
    (scenarios.length
      ? `The item promised this behavior. Check EVERY one against the current uncommitted diff (given→when→then, observable from the caller/user's side):\n` +
        scenarios.map((s, i) => `  ${i + 1}. ${s}`).join("\n") + `\n\n`
      : "") +
    signals +
    `Return your verdict in the leopold-status block: STATUS: done if it passes, STATUS: blocked with the exact failures if it does not.`
  );
}
