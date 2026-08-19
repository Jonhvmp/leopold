// The flow parser, pure. A flow file (`flows/<name>.md`, the
// `templates/persona/FLOW.md` shape) becomes a typed, enforceable object: the
// entry point, the persona's goal, the success criteria, the domain allowlist,
// the out-of-bounds list, the app-version pin, and the step budget.
//
// Parsing is LEXICAL, never semantic: sections are found by their `## ` heading
// prefix, their prose is carried verbatim as model-facing text (untrusted for
// later readers — the conductor enforces the two hard bounds, allowlist and
// out-of-bounds, in code and never interprets the rest). A file missing a
// required section is a typed error NAMING each missing section — loud, never
// silently repaired. Everything here is pure and byte-deterministic: same text
// in, same result out, no IO, no wall-clock.

/** Default step budget when a flow has no `max_turns:` line. */
export const DEFAULT_MAX_TURNS = 40;

/** The required sections, in template order. The canonical labels here are the
 *  exact names a missing-section error carries — "Domain allowlist", not a
 *  paraphrase — so the CLI message and the template heading always agree. */
export const REQUIRED_SECTIONS = [
  "Entry point",
  "Goal",
  "Success criteria",
  "Domain allowlist",
  "Out of bounds",
  "App version pin",
] as const;

export type FlowSectionName = (typeof REQUIRED_SECTIONS)[number];

/** A parsed flow: every hard bound as data, everything else verbatim prose. */
export interface Flow {
  name: string; // from the `# Flow — <name>` title, or "" when untitled
  entryPoint: string;
  goal: string;
  successCriteria: string;
  /** Hostnames the persona may navigate to. Lowercased, trailing dots
   *  stripped. Enforced by allows() with hostname-SUFFIX matching. */
  allowlist: string[];
  /** Extra never-execute items (payments, deletion and destructive submits are
   *  always out of bounds regardless — the template says so in prose). */
  outOfBounds: string[];
  appVersionPin: string;
  maxTurns: number;
  /** True iff the url's hostname is one of the allowlist entries or a
   *  subdomain of one. Never substring matching: for allowlist
   *  ["example.com"], `evil-example.com` and `example.com.attacker.io` are
   *  both outside. An unparseable url is outside — the bound fails closed. */
  allows(url: string): boolean;
}

export type FlowParseResult =
  | { status: "ok"; flow: Flow }
  /** Sections required by the template that the file lacks (or left empty),
   *  by their canonical names, in template order. */
  | { status: "invalid"; missing: FlowSectionName[]; reason: string }
  /** A section is present but its content is unusable (e.g. a malformed
   *  `max_turns:` value). Named, never guessed around. */
  | { status: "malformed"; reason: string };

// -- Hostname matching (the enforceable bound) ------------------------------

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

/** Hostname-suffix matching against an allowlist. Exact host or a dot-boundary
 *  subdomain — never a substring — so `staging.example.com.evil.io` can never
 *  pass for `example.com`. Pure; exported for the conductor's own checks. */
export function hostAllowed(allowlist: string[], url: string): boolean {
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return false; // not a parseable URL — the bound fails closed
  }
  if (host === "") return false;
  for (const entry of allowlist) {
    const allowed = normalizeHost(entry);
    if (allowed === "") continue;
    if (host === allowed || host.endsWith("." + allowed)) return true;
  }
  return false;
}

// -- Section extraction (lexical) -------------------------------------------

interface Section {
  label: FlowSectionName | "Step budget";
  body: string;
}

/** Match a `## ` heading to its canonical label by case-insensitive prefix, so
 *  the template's parentheticals ("Domain allowlist (hard boundary)") and a
 *  bare "Domain allowlist" both land on the same section. */
function sectionLabel(heading: string): Section["label"] | undefined {
  const h = heading.trim().toLowerCase();
  for (const label of [...REQUIRED_SECTIONS, "Step budget"] as const) {
    if (h.startsWith(label.toLowerCase())) return label;
  }
  return undefined;
}

function splitSections(text: string): { title: string; sections: Map<Section["label"], string> } {
  const lines = text.split("\n");
  let title = "";
  const sections = new Map<Section["label"], string>();
  let current: Section["label"] | undefined;
  let body: string[] = [];
  const flush = () => {
    // First heading wins: a duplicated section never silently overwrites.
    if (current !== undefined && !sections.has(current)) sections.set(current, body.join("\n").trim());
  };
  for (const line of lines) {
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1 !== null && !line.startsWith("##")) {
      if (title === "") title = h1[1].replace(/^flow\s*[—–-]\s*/i, "").trim();
      continue;
    }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2 !== null) {
      flush();
      current = sectionLabel(h2[1]);
      body = [];
      continue;
    }
    if (current !== undefined) body.push(line);
  }
  flush();
  return { title, sections };
}

/** The `- item` lines of a section body, verbatim after the marker. */
function listItems(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (m !== null) items.push(m[1]);
  }
  return items;
}

// -- Parse (pure) -----------------------------------------------------------

/** Parse a flow file's full text. Pure and deterministic. Missing or empty
 *  required sections come back as one typed error naming every one of them;
 *  an unusable value in a present section is a named "malformed". */
export function parseFlow(text: string): FlowParseResult {
  const { title, sections } = splitSections(text);

  const missing: FlowSectionName[] = [];
  for (const label of REQUIRED_SECTIONS) {
    const body = sections.get(label);
    if (body === undefined || body === "") missing.push(label);
  }

  // The allowlist is the enforceable bound: a section with prose but zero
  // list entries is as unenforceable as an absent one, and says so the same way.
  const allowlistBody = sections.get("Domain allowlist");
  const allowlist = allowlistBody === undefined ? [] : listItems(allowlistBody);
  if (allowlistBody !== undefined && allowlistBody !== "" && allowlist.length === 0)
    missing.push("Domain allowlist");

  if (missing.length > 0) {
    const ordered = REQUIRED_SECTIONS.filter((l) => missing.includes(l));
    return {
      status: "invalid",
      missing: ordered,
      reason: `flow is missing required section(s): ${ordered.join(", ")}`,
    };
  }

  let maxTurns = DEFAULT_MAX_TURNS;
  const budgetBody = sections.get("Step budget");
  if (budgetBody !== undefined) {
    const m = /^\s*max_turns\s*:\s*(\S+)\s*$/m.exec(budgetBody);
    if (m !== null) {
      const value = Number(m[1]);
      if (!Number.isInteger(value) || value <= 0)
        return { status: "malformed", reason: `max_turns must be a positive integer, got "${m[1]}"` };
      maxTurns = value;
    }
  }

  const flowAllowlist = allowlist.map(normalizeHost);
  const flow: Flow = {
    name: title,
    entryPoint: sections.get("Entry point") ?? "",
    goal: sections.get("Goal") ?? "",
    successCriteria: sections.get("Success criteria") ?? "",
    allowlist: flowAllowlist,
    outOfBounds: listItems(sections.get("Out of bounds") ?? ""),
    appVersionPin: sections.get("App version pin") ?? "",
    maxTurns,
    allows: (url: string) => hostAllowed(flowAllowlist, url),
  };
  return { status: "ok", flow };
}

/** The one CLI-facing message for a failed parse. The subcommand prints this
 *  and exits non-zero; the message NAMES each missing section verbatim. */
export function flowErrorMessage(result: Exclude<FlowParseResult, { status: "ok" }>): string {
  return result.reason;
}
