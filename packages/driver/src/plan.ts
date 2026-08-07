// PLAN.md as a dependency-aware work list for the parallel scheduler.
//
// Each markdown checkbox is one item. An item may declare dependencies on earlier
// items by 1-based position: `- [ ] (after: 1, 3) Do the thing` (or `(deps: ...)`).
// Items with no declared deps are independent and may run concurrently. The serial
// loop ignores all of this; only the --parallel scheduler reads the graph.
//
// THE GRAPH GRAMMAR — every construct below is optional. An item that uses none of
// them parses to exactly what it parsed to before they existed and runs identically:
//
//   - [ ] @gate security Review the auth diff   node kind + label, on the item line
//   - [ ] Migrate the database                  a plain work item (the default)
//         @node human ops                       ...or the kind on a line of its own
//         @needs schema_ready                   a signal this node requires
//         @emit migrated=true                   a signal this node may put on the channel
//         @on fail -> 7                         a conditional edge on the node's outcome
//         @on migrated=false -> 7               a conditional edge on a channel signal
//
// KIND — `@node <kind>` or the shorthands `@work` / `@gate` / `@human` / `@tool` /
// `@verify` / `@feedback`, either at the start of the item's text or on its own line under the
// item; when both appear, the last one wins. An optional label may follow the kind:
// `name:` (explicit, any case) or a bare lowercase word when item text follows it. So
// `@gate security Review auth` is a gate labelled "security" over the text "Review
// auth", while `@human Ask the team` has no label — "Ask" is capitalised, so it is
// text. On a marker line of its own, anything after the label is ignored.
//
// WHAT A KIND DOES (kinds.ts owns the behavior; this is the grammar's half of it):
//   work    edits the repo through a fresh worker session — the default, unchanged.
//   gate    a review-only session over the uncommitted diff; every editing tool is
//   verify  denied, and its verdict is the node's outcome (`done` → ok, `blocked` →
//           fail, which a `@on fail -> N` route can catch). `verify` aims the same
//           node at proof: re-run the build/lint/tests read-only and judge the result.
//   tool    the item's text IS a shell command (or the first backticked span in it).
//           The driver runs it — NO model turn — and its exit status lands on the
//           channel as `exit`, so `@on exit=0 -> 5` works without an `@emit` line. The
//           git lock still applies: `@tool git push` is refused, not run.
//   human   a person decides it. The run stops with `awaiting_human`, names the item
//           and stages everything; the Stop hook does the same in-session.
//   feedback a read-only node that reads the RUN's own evidence (events.jsonl + the
//           metrics) and may PROPOSE plan amendments. It never writes the plan: the
//           driver applies what survives amend.ts's bounds (at most 3 added items per
//           run, never a delete, never a done item, never GUARDRAILS) and logs every
//           accepted amendment to DECISIONS.md and every refusal to events.jsonl.
//
// EDGES — `@on <condition> -> <target>` (`->`, `=>` and `→` all work). A condition
// containing `=` or `!=` tests a key on the state channel (`migrated=false`); a bare
// word tests the node's own outcome (`fail`). The target is the 1-based index of
// another item. Routes never widen `deps`: they are edges the router may take, not
// dependencies the scheduler waits on.
//
// STATE — `@emit key=value` declares a signal this node may write (a bare `@emit key`
// means `key=true`); `@needs key` declares a signal it requires before it runs. One
// declaration per line, keys separated by commas or spaces for `@needs`. THE CHANNEL
// CARRIES DECISIONS, NEVER WORK PRODUCT: what the run built lives in git.
//
// The parser records what was written — including a route to an item that does not
// exist, or a condition that is not a word. Naming those is the graph validator's
// job, and it cannot name what the parser silently dropped.

import fs from "node:fs";

/** What the engine does with a node. `work` is the default and the only kind any
 *  plan written before this grammar existed can produce. */
export type PlanNodeKind = "work" | "gate" | "human" | "tool" | "verify" | "feedback";

/** A conditional edge declared by `@on <condition> -> <target>`. */
export interface PlanRoute {
  /** The condition exactly as written: `fail`, `migrated=false`. */
  when: string;
  /** 1-based index of the item this edge points at. `0` when the line carried no
   *  resolvable target (`@on fail` with no arrow) — invalid on purpose, so the
   *  validator can name it instead of the parser dropping it. */
  target: number;
  /** `signal` — a test against a key on the state channel; `status` — a test against
   *  the node's own outcome. */
  kind: "status" | "signal";
  /** Signal conditions only: the channel key being tested. */
  key?: string;
  /** Signal conditions only: `=` or `!=` (`==` is normalised to `=`). */
  op?: "=" | "!=";
  /** Signal conditions only: the compared value, unquoted. */
  value?: string;
}

/** A signal a node declares it may put on the state channel (`@emit key=value`). */
export interface PlanEmit {
  key: string;
  value: string;
}

export interface PlanItem {
  /** 1-based position among ALL checkboxes (open + done), stable for dep refs. */
  index: number;
  /** Display text, with any (after:/deps:) and node-kind marker stripped. */
  text: string;
  done: boolean;
  /** 1-based indices this item must wait for. */
  deps: number[];
  /** `@scenario` acceptance lines declared under this item (given→when→then), in
   *  order. Empty when the item declares none — a scenario-less item behaves exactly
   *  as before, so this field is backward compatible with every existing plan. */
  scenarios: string[];
  /** Node kind. `"work"` unless the item declares one, so every existing plan is a
   *  plan of work nodes and executes exactly as it does today. */
  kind: PlanNodeKind;
  /** The optional label after the kind marker (`@gate security` → `"security"`).
   *  Empty string when none. */
  kindLabel: string;
  /** `@on` conditional edges, in the order written. Empty for an item that declares
   *  none — the static `(after:)` order is then the only thing that moves the run. */
  routes: PlanRoute[];
  /** `@emit` signals this node may write to the state channel. */
  emits: PlanEmit[];
  /** `@needs` signal keys this node requires before it runs. */
  needs: string[];
}

const CHECKBOX = /^[ \t]*- \[( |x|X)\]\s?(.*)$/;
const DEP_MARKER = /^\((?:after|deps)\s*:\s*([0-9,\s]+)\)\s*/i;
// An acceptance line under an item: `@scenario given X → when Y → then Z`. Indented
// or not; attaches to the most recent checkbox item. Anything before the first
// checkbox is ignored.
const SCENARIO = /^[ \t]*@scenario\b[ \t:]*(.*)$/i;
// The graph markers, in the same attach-to-the-item-above position as @scenario.
const ROUTE = /^[ \t]*@on\b[ \t:]*(.*)$/i;
const EMIT = /^[ \t]*@emit\b[ \t:]*(.*)$/i;
const NEEDS = /^[ \t]*@needs\b[ \t:]*(.*)$/i;
// `@node <kind>` or a shorthand, at the head of whatever string is being parsed.
const KIND_MARKER = /^@(node|work|gate|human|tool|verify|feedback)\b[ \t]*:?[ \t]*/i;
const KIND_NAME = /^([A-Za-z]+)[ \t]*:?[ \t]*/;
// `name:` — an explicit label, any case. A bare lowercase word is also a label, but
// only when it is followed by more text (so `@human Ask the team` keeps its text) and
// never on a `@tool` node, whose text is a command word for word.
const LABEL_EXPLICIT = /^([A-Za-z][A-Za-z0-9_./-]*):(?:[ \t]+|$)[ \t]*/;
const LABEL_BARE = /^([a-z][a-z0-9_./-]*)(?:[ \t]+|$)[ \t]*/;
const ARROW_SPLIT = /^([\s\S]*)(?:->|=>|→)[ \t]*([\s\S]*)$/;
const SIGNAL_COND = /^([^\s=!]+)[ \t]*(!=|==|=)[ \t]*([\s\S]*)$/;
const KINDS = new Set<string>(["work", "gate", "human", "tool", "verify", "feedback"]);

/** Strip one layer of matching quotes off a declared value. */
function unquote(v: string): string {
  const m = v.match(/^"([\s\S]*)"$|^'([\s\S]*)'$/);
  return m ? (m[1] ?? m[2] ?? "") : v;
}

interface KindMarker { kind: PlanNodeKind; kindLabel: string; rest: string }

/** Parse a leading node-kind marker off `raw`. Returns null when there is none — in
 *  particular `@node` without a known kind after it is NOT a marker, so an item whose
 *  prose happens to start with the word is left alone. `inline` is true when parsing
 *  the item's own line, where a bare lowercase label only counts if text follows. */
function matchKind(raw: string, inline: boolean): KindMarker | null {
  const m = raw.match(KIND_MARKER);
  if (!m) return null;
  let rest = raw.slice(m[0].length);
  let kind = m[1].toLowerCase();
  if (kind === "node") {
    const k = rest.match(KIND_NAME);
    const name = (k?.[1] ?? "").toLowerCase();
    if (!k || !KINDS.has(name)) return null;
    kind = name;
    rest = rest.slice(k[0].length);
  }
  let kindLabel = "";
  const explicit = rest.match(LABEL_EXPLICIT);
  if (explicit) {
    kindLabel = explicit[1];
    rest = rest.slice(explicit[0].length);
  } else if (kind !== "tool") {
    // NEVER on a `@tool` node. Its text IS the command, so a bare first word is
    // `make` in `@tool make test`, not a label — eating it would silently run a
    // different command than the plan says (and would hide the word `git` from the
    // guard). A tool node labels itself the explicit way: `@tool build: make test`.
    const bare = rest.match(LABEL_BARE);
    if (bare) {
      const after = rest.slice(bare[0].length);
      if (!inline || after.trim()) {
        kindLabel = bare[1];
        rest = after;
      }
    }
  }
  return { kind: kind as PlanNodeKind, kindLabel, rest: rest.trim() };
}

/** Parse the text after `@on` into a route. Null only when nothing was written. */
function parseRoute(raw: string): PlanRoute | null {
  const written = raw.trim();
  if (!written) return null;
  const split = written.match(ARROW_SPLIT);
  const when = (split ? split[1] : written).trim();
  const targetText = split ? split[2].trim() : "";
  const t = targetText.match(/^#?(\d+)$/);
  const target = t ? parseInt(t[1], 10) : 0;
  const sig = when.match(SIGNAL_COND);
  if (sig) {
    return {
      when,
      target,
      kind: "signal",
      key: sig[1],
      op: sig[2] === "!=" ? "!=" : "=",
      value: unquote(sig[3].trim()),
    };
  }
  return { when, target, kind: "status" };
}

/** Parse the text after `@emit` into one signal. `key` alone means `key=true`. */
function parseEmit(raw: string): PlanEmit | null {
  const written = raw.trim();
  if (!written) return null;
  const eq = written.indexOf("=");
  if (eq < 0) return { key: written, value: "true" };
  return { key: written.slice(0, eq).trim(), value: unquote(written.slice(eq + 1).trim()) };
}

/** Parse the text after `@needs` into signal keys (comma- or space-separated). */
function parseNeeds(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((tok) => tok.split("=")[0].trim())
    .filter(Boolean);
}

interface ItemMarkers { deps: number[]; kind: PlanNodeKind; kindLabel: string; text: string }

/** Parse the leading `(after: 1, 3)` and node-kind markers off an item's line. Either
 *  order works; both are optional. Everything left is the item's text. */
function splitMarkers(raw: string): ItemMarkers {
  let rest = raw;
  const deps: number[] = [];
  let kind: PlanNodeKind = "work";
  let kindLabel = "";
  // One dep marker per item, exactly as before: a second `(after:)` stays in the text
  // today and must keep staying there, or an existing plan would parse differently.
  let sawDep = false;
  for (;;) {
    // Anchored exactly as before: a dep marker is only a marker at position 0.
    const d = sawDep ? null : rest.match(DEP_MARKER);
    if (d) {
      sawDep = true;
      for (const s of d[1].split(",")) {
        const n = parseInt(s.trim(), 10);
        if (Number.isFinite(n) && n >= 1) deps.push(n);
      }
      rest = rest.slice(d[0].length);
      continue;
    }
    const k = matchKind(rest.trimStart(), true);
    if (k) {
      kind = k.kind;
      if (k.kindLabel) kindLabel = k.kindLabel;
      rest = k.rest;
      continue;
    }
    break;
  }
  return { deps: [...new Set(deps)], kind, kindLabel, text: rest.trim() };
}

export function parsePlan(text: string): PlanItem[] {
  const items: PlanItem[] = [];
  let index = 0;
  let current: PlanItem | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(CHECKBOX);
    if (m) {
      index += 1;
      const done = m[1].toLowerCase() === "x";
      const { deps, kind, kindLabel, text: itemText } = splitMarkers(m[2] ?? "");
      current = {
        index, text: itemText, done, deps: deps.filter((d) => d < index),
        scenarios: [], kind, kindLabel, routes: [], emits: [], needs: [],
      };
      items.push(current);
      continue;
    }
    // A marker line attaches to the item above it. Non-checkbox, non-marker lines
    // (blank lines, wrapped continuations, prose) are ignored, exactly as before.
    if (!current) continue;
    const s = line.match(SCENARIO);
    if (s) {
      const scenario = s[1].trim();
      if (scenario) current.scenarios.push(scenario);
      continue;
    }
    const r = line.match(ROUTE);
    if (r) {
      const route = parseRoute(r[1]);
      if (route) current.routes.push(route);
      continue;
    }
    const e = line.match(EMIT);
    if (e) {
      const emit = parseEmit(e[1]);
      if (emit) current.emits.push(emit);
      continue;
    }
    const n = line.match(NEEDS);
    if (n) {
      for (const key of parseNeeds(n[1])) if (!current.needs.includes(key)) current.needs.push(key);
      continue;
    }
    const bare = line.trim();
    if (bare.startsWith("@")) {
      const marker = matchKind(bare, false);
      if (marker) {
        current.kind = marker.kind;
        if (marker.kindLabel) current.kindLabel = marker.kindLabel;
      }
    }
  }
  return items;
}

export function parsePlanFile(planPath: string): PlanItem[] {
  return parsePlan(fs.readFileSync(planPath, "utf8"));
}

// --- the checkbox ledger -------------------------------------------------------------
// WHO flipped that checkbox. The driver is the only thing entitled to close a plan item,
// and every flip it makes is recorded here as it happens. A read-only node's receipt
// (loop.ts) subtracts this ledger from what actually moved while the node ran, so a
// `--parallel` sibling closing its own item reads as the driver's doing — and a flip on
// nobody's ledger reads as what it is: an item marked done by something that was not
// allowed to write at all. Without this the two are indistinguishable, and forging
// `[x]` on every open item ends the run with `plan_complete` and the work never done.

interface CheckboxFlip { planPath: string; index: number }
const FLIPS: CheckboxFlip[] = [];

/** Where the ledger stands right now. Pass it to `driverFlipsSince` afterwards. */
export function checkboxLedgerMark(): number {
  return FLIPS.length;
}

/** The 1-based item indices the DRIVER itself flipped in `planPath` since `mark`. */
export function driverFlipsSince(mark: number, planPath: string): Set<number> {
  const out = new Set<number>();
  for (const f of FLIPS.slice(Math.max(0, mark))) if (f.planPath === planPath) out.add(f.index);
  return out;
}

/** The checkbox state of every item, in plan order: `x` done, ` ` open. One character
 *  per item, so comparing two vectors names the exact item whose state moved. */
export function checkboxVector(planPath: string): string {
  let out = "";
  try {
    for (const line of fs.readFileSync(planPath, "utf8").split("\n")) {
      const m = line.match(CHECKBOX);
      if (m) out += m[1] === " " ? " " : "x";
    }
  } catch { /* no plan to read is no vector to compare */ }
  return out;
}

/** Set the Nth checkbox to `state`, recording the flip on the driver's ledger. The one
 *  place a checkbox is written: sync read-modify-write, so two callers in the same tick
 *  cannot interleave. Returns the number of open items left. */
function writeCheckbox(planPath: string, index: number, state: " " | "x"): number {
  const lines = fs.readFileSync(planPath, "utf8").split("\n");
  let n = 0, open = 0, flipped = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX);
    if (!m) continue;
    n += 1;
    if (n !== index) continue;
    const now = m[1] === " " ? " " : "x";
    if (now === state) continue;
    lines[i] = state === "x" ? lines[i].replace("- [ ]", "- [x]") : lines[i].replace(/- \[[xX]\]/, "- [ ]");
    flipped = true;
  }
  if (flipped) FLIPS.push({ planPath, index });
  fs.writeFileSync(planPath, lines.join("\n"));
  for (const line of lines) { const m = line.match(CHECKBOX); if (m && m[1] === " ") open += 1; }
  return open;
}

/** Which items' checkboxes moved while a read-only node ran, WITHOUT the driver moving
 *  them — the forgeries. 1-based indices, in plan order.
 *
 *  Only compares vectors of the same length. A plan that gained or lost a line has had
 *  its positions shifted, so a position-by-position comparison would name the wrong item
 *  and a restore would write the wrong line; the brief digest already flags a deleted or
 *  injected item on its own, which is the louder signal anyway. */
export function forgedCheckboxes(before: string, after: string, driverFlipped: Set<number>): number[] {
  if (!before || before.length !== after.length) return [];
  const out: number[] = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i] && !driverFlipped.has(i + 1)) out.push(i + 1);
  }
  return out;
}

/** Put the checkboxes at `indices` back to the state `was` records for them, and log the
 *  restore on the ledger like any other driver flip. Used when a read-only node's receipt
 *  says a checkbox moved that the driver never touched: the state the driver knows is
 *  authoritative, so the forgery is undone rather than merely noticed. */
export function restoreCheckboxes(planPath: string, indices: number[], was: string): number[] {
  const undone: number[] = [];
  for (const i of indices) {
    const state = was[i - 1];
    if (state !== " " && state !== "x") continue;
    writeCheckbox(planPath, i, state);
    undone.push(i);
  }
  return undone;
}

/** Mark the Nth checkbox (1-based, matching PlanItem.index) done. Returns the
 *  number of open items left. Index-based so the parallel scheduler can close a
 *  specific item without text matching. */
export function setItemDone(planPath: string, index: number): number {
  return writeCheckbox(planPath, index, "x");
}

/** Re-open the Nth checkbox (1-based) — flip `[x]` back to `[ ]`. Used by the
 *  canvas "rerun-item" steer command so the loop redoes a completed item. Returns
 *  the number of open items left. */
export function setItemOpen(planPath: string, index: number): number {
  return writeCheckbox(planPath, index, " ");
}

/** Open items whose every dependency is already done — the dispatchable set,
 *  minus anything already in flight. */
export function readyItems(items: PlanItem[], inFlight: Set<number>): PlanItem[] {
  const doneIdx = new Set(items.filter((i) => i.done).map((i) => i.index));
  return items.filter(
    (i) => !i.done && !inFlight.has(i.index) && i.deps.every((d) => doneIdx.has(d)),
  );
}

/** True when no open item remains. */
export function allDone(items: PlanItem[]): boolean {
  return items.every((i) => i.done);
}

/** Open items that can never run because a dependency is missing or items form a
 *  cycle (deadlock) — used to stop the scheduler instead of spinning forever. */
export function deadlocked(items: PlanItem[], inFlight: Set<number>): boolean {
  const open = items.filter((i) => !i.done && !inFlight.has(i.index));
  return open.length > 0 && readyItems(items, inFlight).length === 0 && inFlight.size === 0;
}
