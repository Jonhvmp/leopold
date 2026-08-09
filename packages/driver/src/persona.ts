// Personas: the role Leopold assumes when it reaches work that used to wait for a person.
//
// A `@human` node, an escalation, a graph the validator refuses, a third failure of the
// same kind — every one of those is the run saying "a person should decide this" about a
// decision a well-framed agent can make. Instead of halting, the engine SYNTHESIZES the
// role the work needs, assumes it, does the work, and records what it decided.
//
// THE PERSONA IS SYNTHESIZED, NEVER AUTHORED. The plan says WHAT needs doing; who should
// do it is derived from the item text plus MISSION and CHARTER — the charter already
// holds the taste, the priorities and the hard rules. A plan that had to name its own
// experts would just be a second to-do list.
//
// TWO HALVES, AND ONLY ONE OF THEM IS A MODEL CALL:
//
//   the fit          synthesized — a name, the expertise the item actually needs, what
//                    the role optimizes for, and why it fits. One turn, no tools, through
//                    the sdk.ts seam like every other model call in the driver.
//   the constraints  NOT synthesized, and not even asked for. `charterHardRules` lifts
//                    the charter's binding lines VERBATIM and those ARE the persona's
//                    binding rules. "The persona carries the charter's hard rules" is
//                    therefore a property of the code, not a hope about a prompt — a
//                    model that forgot them cannot produce a persona without them, a
//                    model that paraphrased one cannot soften it, and the same item +
//                    charter yields byte-identical binding rules every time.
//
// A PERSONA DECIDES; IT EXECUTES NOTHING NEW. It may conclude "ship the cutover" and
// record that decision — the guard still denies the `git push` that would carry it out,
// and it may never raise a budget, clear the kill switch or edit GUARDRAILS.md. That seam
// is what makes "nothing halts" safe rather than reckless, and nothing here touches it.
// Only the first of those three is machine-enforced (see NO_EXECUTION_CLAUSE): the guard's
// scope is `git commit` and `git push`, so the rest is a rule the role has to keep, and
// the prompt says so rather than promising a hook that is not there.
//
// FAILURE IS NOT FATAL. Synthesis is best-effort by construction: an unparseable answer,
// a generic role ("an assistant" is not a persona), a harness error or an empty response
// all return `undefined`, and the caller runs the item under the default worker prompt.
// A run must never die because it could not decide who it was.

import { query } from "./sdk.js";
import type { Brief, DriverConfig } from "./types.js";

/** Which stop path asked for a persona. Recorded with the decision, so the trail says
 *  what the run would have done instead of deciding. */
export type PersonaFork = "human" | "escalation" | "repair" | "deadlock" | "repeated-failure";

/** What each fork is, in the words the synthesis prompt and the decision trail use. */
export const FORK_SITUATION: Record<PersonaFork, string> = {
  human: "a @human node — the plan asked a person to decide this, and no person is coming",
  escalation: "an escalation — the worker hit a fork it could not settle from the charter",
  repair: "a broken plan graph — a route points nowhere, or the graph will not validate",
  deadlock: "a deadlock — items are open, nothing is dispatchable, and the run is waiting on a decision nobody made",
  "repeated-failure": "repeated failure — the same kind of failure has now happened three times",
};

/** A synthesized role, as DATA — so it can be handed to a prompt AND written into
 *  DECISIONS.md with the decision it produced. A decision whose persona is not recorded
 *  is not auditable, and this is the shape that makes recording it trivial. */
export interface Persona {
  /** A person's name. A role with no name reads as a costume. */
  name: string;
  /** The role title: "Release Engineer", "Interaction Designer". */
  role: string;
  /** A stable key for the role — significant words, normalized and sorted. Two
   *  syntheses that produce "Staff Interaction Designer" and "interaction designer,
   *  senior" share a key: the FIT is what must be stable, not the wording. */
  roleKey: string;
  /** The expertise the item actually needs, most relevant first. */
  expertise: string[];
  /** What this role optimizes for when it decides. */
  optimizesFor: string[];
  /** The charter lines binding it — verbatim, deterministic, never invented. */
  constraints: string[];
  /** Why this role fits this item. One or two lines. */
  rationale: string;
  /** The stop path this persona was synthesized for. */
  fork: PersonaFork;
  /** The item (or blocked work) it was synthesized from, trimmed for the record. */
  item: string;
}

/** What the caller knows about the blocked work. */
export interface PersonaInput {
  fork: PersonaFork;
  /** The plan item text, or a description of the blocked work. */
  item: string;
  /** The fork itself: the question asked, the validator diagnostic, the failure history. */
  detail?: string;
}

/** Ceilings. A persona is a frame for one decision, not a document. */
export const MAX_LIST = 6;
export const MAX_FIELD = 240;
/** A charter rule keeps more room than a persona field: it is lifted verbatim, and a
 *  binding rule cut off mid-clause is a different rule. */
export const MAX_RULE = 320;
/** How many charter rules may bind a persona. High enough that a real charter's `Always`
 *  and `Never` sections fit whole — a cap that silently drops the prohibitions and keeps
 *  the style preferences is worse than no cap. When it does bite, what it drops first is
 *  prose matched heuristically, never a line under a heading that declares rules. */
export const MAX_CHARTER_RULES = 32;

/** Roles that are not personas. "An agent" with a hat on answers exactly what the
 *  default worker would, so it is refused and the default worker prompt stands. */
const GENERIC_ROLES = new Set([
  "assistant", "ai assistant", "ai", "agent", "ai agent", "an agent", "helper", "bot",
  "model", "llm", "worker", "generalist", "expert", "specialist", "professional",
  "engineer", "developer", "software engineer", "leopold", "claude", "persona",
]);

/** Normalize a role before asking whether it is generic. The bare lookup missed the exact
 *  strings `personaSystemPrompt` names as not-a-persona: it held "an agent" but not
 *  "an assistant", and nothing stripped a leading article or a plural, so "An Engineer",
 *  "the assistant" and "assistants" all sailed through as if they were a fit. */
function genericKey(role: string): string {
  return String(role ?? "")
    .toLowerCase()
    .replace(/[.\s]+$/, "")
    .replace(/^(?:an?|the)\s+/, "")
    .replace(/s$/, "");
}

/** Words that describe seniority or flavor rather than the role, dropped from `roleKey`
 *  so "Senior Release Engineer" and "Release Engineer" are recognized as the same fit. */
const ROLE_NOISE = new Set([
  "senior", "staff", "principal", "lead", "chief", "head", "junior", "expert",
  "specialist", "professional", "experienced", "seasoned", "a", "an", "the", "of", "and",
]);

// A charter rule that binds. Either it sits under a heading that declares rules, or it
// states one in the words people actually write them in.
const RULE_HEADING = /^#{1,6}\s*(never|always|hard rules?|rules?|constraints?|non-?goals?|must|do not|don'?t|guardrails?|boundaries)\b/i;
const OTHER_HEADING = /^#{1,6}\s+/;
// `did not` is deliberately NOT here. It is past tense — a statement about what already
// happened, never a rule — and it turned charter prose like "The first attempt did not use
// a worktree, which cost a day" into a line injected under "YOU ARE BOUND BY THESE RULES…
// a decision that breaks one is wrong however well argued". A history lesson laundered as
// a constraint is worse than a missing constraint. The declared-heading path (`## Never`,
// `## Always`) is unaffected: a line under one of those is a rule because the author said
// so, tense included.
const RULE_WORDS = /\b(never|always|must not|must never|may never|cannot|can not|does? not|will not|shall not|don'?t|no new|not negotiable|non-negotiable|forbidden|is locked|stays locked|only ever|at most|refuse)\b/i;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])[ \t]+/;

// A rule heading's POLARITY, carried onto every rule under it. `## Never` contributes
// lines like "Run git push, git tag or npm publish." — read bare, under a heading that
// says "you are bound by these", that instructs the persona to do the very thing the
// charter forbids. The heading is half the rule, so it travels with it.
const HEADING_POLARITY: Array<[RegExp, string]> = [
  [/^#{1,6}\s*(never|must not|must never|do not|don'?t)\b/i, "Never: "],
  [/^#{1,6}\s*(always|must)\b/i, "Always: "],
  [/^#{1,6}\s*non-?goals?\b/i, "Non-goal: "],
];

function headingPrefix(heading: string): string {
  for (const [re, prefix] of HEADING_POLARITY) if (re.test(heading)) return prefix;
  return "";
}

/** One candidate rule, with where it came from — the cap needs to tell a line that sits
 *  under `## Never` from a prose line that merely sounded like a rule. */
interface RuleCandidate {
  text: string;
  /** True when a heading declared it a rule, rather than RULE_WORDS guessing. */
  declared: boolean;
}

function clip(s: string, max = MAX_FIELD): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

function list(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/\s*[;\n]\s*/) : [];
  const out: string[] = [];
  for (const x of raw) {
    const t = clip(typeof x === "string" ? x : JSON.stringify(x));
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** The charter's binding rules, VERBATIM and in the order the charter writes them.
 *
 *  Pure, deterministic and model-free on purpose: this is the half of a persona that
 *  must be provable. A rule qualifies when it sits under a heading that declares rules
 *  (`## Never`, `## Always`, `## Constraints`, …) or when it states a rule in its own
 *  words ("no new infrastructure for the MVP", "the git lock does not move"). The text is
 *  carried across unchanged apart from the list marker it was written with and, under a
 *  heading whose polarity is the other half of the rule, that heading's label — a
 *  paraphrased constraint is a different constraint.
 *
 *  Three things a naive line-by-line scan gets wrong, and this does not:
 *  - A WRAPPED BULLET IS ONE RULE, not a rule and an orphan fragment. Real charters wrap
 *    at 90 columns; matching physical lines binds the persona by sentence halves.
 *  - A `## Never` RULE IS NOT ITS TEXT ALONE. Lifted bare under "you are bound by these",
 *    "Run `git push`" reads as an instruction to run it.
 *  - THE CAP MAY NOT DROP THE PROHIBITIONS. Truncating in document order on a charter
 *    that puts `## Always` and `## Never` last keeps the style notes and loses the hard
 *    rules, which is exactly backwards. */
export function charterHardRules(charter: string): string[] {
  const candidates: RuleCandidate[] = [];
  let declaredSection = false;
  let sectionPrefix = "";
  let fenced = false;
  // The block currently being accumulated: a bullet or paragraph plus its wrapped
  // continuation lines, and the section state it opened under.
  let block = "";
  let blockDeclared = false;
  let blockPrefix = "";

  const flush = (): void => {
    const text = clip(block.replace(LIST_MARKER, "").trim(), MAX_RULE);
    block = "";
    if (text.length < 4) return;
    if (!blockDeclared && !RULE_WORDS.test(text)) return;
    candidates.push({ text: blockDeclared ? blockPrefix + text : text, declared: blockDeclared });
  };
  const open = (line: string): void => {
    block = line;
    blockDeclared = declaredSection;
    blockPrefix = sectionPrefix;
  };

  for (const raw of String(charter ?? "").split("\n")) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line || /^[-=]{3,}$/.test(line)) {
      flush();
      continue;
    }
    if (OTHER_HEADING.test(line)) {
      flush();
      declaredSection = RULE_HEADING.test(line);
      sectionPrefix = declaredSection ? headingPrefix(line) : "";
      continue;
    }
    if (LIST_MARKER.test(line)) {
      flush();
      open(line);
      continue;
    }
    // Anything else continues the block it wraps out of, or opens a paragraph.
    if (block) block += " " + line;
    else open(line);
  }
  flush();

  const seen = new Set<string>();
  const unique = candidates.filter((c) => !seen.has(c.text) && (seen.add(c.text), true));
  if (unique.length <= MAX_CHARTER_RULES) return unique.map((c) => c.text);

  // Over the cap: keep every heading-declared rule, then fill with heuristic prose — and
  // emit the survivors in document order, because a charter's order is its priority.
  const keep = new Set<number>();
  for (const pass of [true, false]) {
    unique.forEach((c, i) => {
      if (c.declared === pass && keep.size < MAX_CHARTER_RULES) keep.add(i);
    });
  }
  return unique.filter((_, i) => keep.has(i)).map((c) => c.text);
}

/** Normalize a role title to the fit underneath its wording. */
export function roleKeyOf(role: string): string {
  return String(role ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !ROLE_NOISE.has(w))
    .sort()
    .join("-");
}

/** The system prompt the synthesis call runs under. Pure — no model, no I/O — so the
 *  framing is inspectable in a test. */
export function personaSystemPrompt(brief: Brief): string {
  return `You are Leopold, an autonomous orchestrator. A plan item has reached a point that used to wait for a human being. No human is coming: you decide who should do this work, and that role then does it.

Your job right now is ONE thing: synthesize the ROLE this specific item needs. Not the answer — the person.

What makes a real persona:
- A NAME and a specific role title. "An assistant", "an agent", "an engineer" is not a persona, it is the same generic answer with a hat on. If the item is about visual hierarchy, the role is a designer. If it is about a database cutover, the role is a release/data engineer. Fit the role to THIS item's actual subject matter.
- The EXPERTISE this item genuinely needs, concretely (2-4 items). Name real skills, not adjectives.
- What this role OPTIMIZES FOR when it decides (2-4 items), consistent with the mission and the charter below.
- WHY this role fits this item, in one or two lines.

What this role may NOT do, ever, whatever it concludes: git commit, git push, git tag, publish, open an external PR, raise or route around any budget or iteration limit, clear a kill switch, or edit GUARDRAILS.md. It DECIDES; the human ships. A decision it cannot execute is still a decision worth recording.

Do not restate the charter's rules: they are attached to the role in code, verbatim, whatever you write.

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"name":"...","role":"...","expertise":["..."],"optimizesFor":["..."],"rationale":"..."}

=== MISSION ===
${brief.mission}

=== CHARTER (this is how this project decides; the role you synthesize is bound by it) ===
${brief.charter}`;
}

/** The user turn of the synthesis call. Pure. */
export function personaUserPrompt(input: PersonaInput): string {
  return `The run reached this and would previously have stopped for a human.

SITUATION: ${FORK_SITUATION[input.fork] ?? input.fork}
ITEM: ${clip(input.item, 600)}
WHAT IS ACTUALLY BEING DECIDED: ${clip(input.detail ?? "", 900) || "(the item as written)"}

Synthesize the role that should take this. Return the JSON object now.`;
}

/** Parse a synthesis answer into a Persona. PURE, and the place the charter's rules are
 *  merged in — so no path exists that produces a persona without them.
 *
 *  Returns undefined when there is no usable role, which is the signal to run the item
 *  under the default worker prompt instead of dying. */
export function parsePersona(text: string, input: PersonaInput, charter: string): Persona | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const role = clip(typeof obj.role === "string" ? obj.role : "", 80);
  const name = clip(typeof obj.name === "string" ? obj.name : "", 80);
  const expertise = list(obj.expertise);
  if (!role || !name || expertise.length === 0) return undefined;
  if (GENERIC_ROLES.has(genericKey(role))) return undefined;

  // The binding rules are the CHARTER'S, lifted in code. Nothing the model wrote is
  // consulted here — a quoted constraint would vary between two syntheses of the same
  // item, and the whole point is that the fit may be worded differently while what binds
  // the role may not. This is the guarantee the feature rests on.
  return {
    name,
    role,
    roleKey: roleKeyOf(role),
    expertise,
    optimizesFor: list(obj.optimizesFor),
    constraints: charterHardRules(charter),
    rationale: clip(typeof obj.rationale === "string" ? obj.rationale : "", 400),
    fork: input.fork,
    item: clip(input.item, 300),
  };
}

/** Synthesize the role this blocked item needs. ONE model call through the sdk.ts seam,
 *  no tools, one turn — and it never throws: every failure path returns undefined so the
 *  caller falls back to the default worker prompt. */
export async function synthesizePersona(
  cfg: DriverConfig,
  brief: Brief,
  input: PersonaInput,
): Promise<Persona | undefined> {
  let text = "";
  try {
    const q = query({
      prompt: personaUserPrompt(input),
      options: {
        ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
        leopoldRole: "conductor",
        systemPrompt: personaSystemPrompt(brief),
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        permissionMode: "default",
      } as never,
    });
    for await (const msg of q as AsyncIterable<{
      type: string;
      message?: { content?: Array<{ type: string; text?: string }> };
      result?: string;
    }>) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
      } else if (msg.type === "result") {
        if (!text && typeof msg.result === "string") text = msg.result;
      }
    }
  } catch {
    return undefined;
  }
  if (!text.trim()) return undefined;
  return parsePersona(text, input, brief.charter);
}

/** What a persona may never do, whatever it concludes — ONE writer for the clause, so the
 *  node prompt that assumes a role and the conductor prompt that settles an escalation
 *  cannot drift on where the trust boundary sits.
 *
 *  IT SAYS WHAT IS ENFORCED AND WHAT IS NOT, AND THE DIFFERENCE IS THE POINT.
 *  hooks/guard-irreversible.sh denies exactly two things — `git commit` and `git push`
 *  (force-push unconditionally) — and its own header calls that "the ENTIRE scope";
 *  scripts/test-guard.sh asserts `gh pr create`, `gh release create`, `npm publish` and
 *  `cargo publish` are ALLOWED, and that edits (GUARDRAILS.md included) are never guarded.
 *  A role told a hook will catch `npm publish` has no reason to hold back and nothing
 *  would stop it, so the clause names the two real denials as enforced and everything else
 *  as a rule the role itself has to keep. packages/driver/test/trust-boundary.test.ts runs
 *  the real guard and fails if this sentence ever over-claims again. */
export const NO_EXECUTION_CLAUSE =
  "You DECIDE; you do not ship. Two things are enforced for you: the Leopold guard denies `git commit` and `git push` (force-push always), and that is its entire scope — stage the work and say what you decided. EVERYTHING ELSE IS ON YOU, because nothing blocks it: do not run git tag, do not publish a package, do not cut a release, do not open an external PR, and never raise a budget or iteration limit, clear a kill switch, or edit GUARDRAILS.md. Treat those as hard denials even though no hook will stop you.";

/** The system-prompt append that ASSUMES the role, in the same shape as the other node
 *  appends (kinds.ts owns those; this one is the persona's).
 *
 *  Empty string for an unsynthesized persona, so `append + personaAppend(p)` is exactly
 *  the default prompt when synthesis failed. */
export function personaAppend(persona?: Persona): string {
  if (!persona) return "";
  const bullets = (xs: string[]): string => xs.map((x) => `  - ${x}`).join("\n");
  return `

YOU ARE ${persona.name.toUpperCase()} — ${persona.role}.
This item reached ${FORK_SITUATION[persona.fork] ?? persona.fork}. No human is coming; you have the seat, and you make this call yourself.

- Your expertise:
${bullets(persona.expertise)}
${persona.optimizesFor.length ? `- You optimize for:\n${bullets(persona.optimizesFor)}\n` : ""}- ${persona.rationale || "This role is what the item needs."}
${persona.constraints.length
    ? `- YOU ARE BOUND BY THESE RULES. They come from the project's charter, they are not advice, and a decision that breaks one is wrong however well argued:
${bullets(persona.constraints)}`
    // A charter of plain prose yields no hard rules — a state the suite itself asserts is
    // reachable — and the header used to print anyway, over nothing. "You are bound by
    // these rules:" followed by a blank line is a worse frame than saying there are none:
    // it tells the role something binds it and then refuses to say what. Same wording the
    // conductor already uses for the same situation.
    : "- The charter states no binding rule for this call; decide on the mission alone."}

${NO_EXECUTION_CLAUSE}

Do the work this item asks for, completely, and state the call you made, why the charter supports it, and how to undo it.`;
}

/** What a persona is asked to state once it has decided. One writer for the format:
 *  every prompt that expects a decision block uses THIS string, and `parseDecisionBlock`
 *  is the only thing that reads one — so the contract cannot drift between the two. */
export const DECISION_BLOCK_INSTRUCTION = `Before your status block, state the call you made in ONE fenced block (exactly this shape):

\`\`\`leopold-decision
DECISION: <the call you made, in one line>
WHY: <the charter/mission basis for it>
REVERSAL: <how a human undoes this, concretely — the file to revert, the flag to flip>
\`\`\``;

/** A decision a persona made, as the trail records it. */
export interface PersonaDecision {
  decision: string;
  why: string;
  reversal: string;
}

/** How a persona's work is undone when it stated no reversal of its own. Always TRUE of
 *  a Leopold run — git is locked, so everything a persona did is unstaged/staged work in
 *  the tree and nothing has been shipped. A default is not a nicety here: a decision with
 *  an empty Reversal line is not done, so there must be no path that produces one. */
export const DEFAULT_REVERSAL =
  "Nothing was committed: discard this item's staged work (`git restore --staged --worktree .`) and the decision is undone.";

/** What the trail says when a persona stated no reasoning of its own. The charter rules
 *  bound to the role are always the basis of last resort — they applied whether the role
 *  cited them or not — and saying so beats a blank `Why:` line that reads like a bug. */
export const DEFAULT_WHY =
  "no separate reasoning was stated; the charter rules binding this role are the basis.";

/** Read the `leopold-decision` block out of a persona's turns. Pure, tolerant of the
 *  ways a model bends a format (missing fence, lower-case keys, a wrapped line), and it
 *  never returns an entry with an empty Reversal — `DEFAULT_REVERSAL` fills that in.
 *
 *  `undefined` only when there is no decision at all to record; the caller then falls
 *  back to the worker's own summary, because the entry is the feature. */
export function parseDecisionBlock(text: string, fallbackDecision = ""): PersonaDecision | undefined {
  // The LAST block wins: a node may take several turns, and the call it ends on is the
  // call it made. Falling back to the whole text keeps a persona that dropped the fence
  // (but wrote the fields) on the record rather than off it.
  const blocks = [...String(text ?? "").matchAll(/```leopold-decision\s*([\s\S]*?)```/gi)];
  const body = blocks.length ? blocks[blocks.length - 1][1] : String(text ?? "");
  const field = (key: string): string => {
    // `m` stays — `^` must match at the start of each FIELD line. But the end of the
    // lookahead must not be `$`, which under `m` matches at every end-of-LINE: the lazy
    // `[\s\S]*?` then stopped at the first newline and silently cut every wrapped field in
    // half. A REVERSAL is the one field the whole trail exists for, and half a Reversal
    // reads complete while telling a human nothing. `(?![\s\S])` is end-of-INPUT, which is
    // what was meant. The rendered block stays one line per field either way, because
    // `clip` collapses whitespace before it is written.
    const m = body.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*(?:DECISION|WHY|REVERSAL)[ \\t]*:|\\n\\s*\`\`\`|(?![\\s\\S]))`, "im"));
    return clip(m ? m[1] : "", MAX_FIELD);
  };
  const decision = field("DECISION") || clip(fallbackDecision, MAX_FIELD);
  if (!decision) return undefined;
  return { decision, why: field("WHY"), reversal: field("REVERSAL") || DEFAULT_REVERSAL };
}

/** Where a decision was made, when no persona was synthesized to carry it. Synthesis is
 *  best-effort by design (see the header), so the fork and the work are passed alongside
 *  it — the trail must say WHAT was decided and WHERE even on the path where nobody could
 *  be named for it. */
export interface DecisionContext {
  fork: PersonaFork;
  /** The item, or a description of the blocked work the fork came up in. */
  item: string;
}

/** How the trail names the decider when synthesis produced no usable role. Never blank:
 *  "nobody in particular" is still an answer an auditor can act on; a missing line is not. */
export const NO_PERSONA = "Leopold — no role was synthesized; the default worker rules applied";

/** The persona, as DECISIONS.md fields — so the role that made a call is recorded WITH
 *  the call and the entry can be audited later.
 *
 *  ALWAYS SIX FIELDS WHEN THE CALLER KNOWS ITS FORK. With a persona these read off the
 *  persona; with none, `ctx` supplies the fork and the work so the entry is still whole.
 *  Only a caller that passes neither gets nothing back — that is what keeps the old
 *  "no persona, no context" shape for anything that has not been taught the fork yet. */
export function personaDecisionFields(persona?: Persona, ctx?: DecisionContext): Array<[string, string]> {
  const fork = persona?.fork ?? ctx?.fork;
  const item = persona?.item ?? clip(ctx?.item ?? "", 300);
  if (!persona && !ctx) return [];
  return [
    ["Persona", persona ? `${persona.name} — ${persona.role} (${persona.expertise.join("; ")})` : NO_PERSONA],
    ["Fork", `${(fork && FORK_SITUATION[fork]) ?? fork ?? "an autonomous fork"}${item ? `: ${item}` : ""}`],
  ];
}
