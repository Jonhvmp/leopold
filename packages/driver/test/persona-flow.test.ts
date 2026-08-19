// Unit tests for the persona flow parser (persona-testing/flow.ts). Pure core:
// no IO beyond reading the shipped template, no temp homes needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MAX_TURNS,
  REQUIRED_SECTIONS,
  parseFlow,
  hostAllowed,
  flowErrorMessage,
} from "../src/persona-testing/flow.ts";

const TEMPLATE = path.join(import.meta.dirname, "..", "..", "..", "templates", "persona", "FLOW.md");

/** A fully filled flow in the shipped template's shape. */
function filledFlow(opts: { allowlist?: boolean; budget?: string | null } = {}): string {
  const allowlist =
    opts.allowlist === false
      ? ""
      : `## Domain allowlist (hard boundary)

- staging.example.com
- accounts.example.com

The persona never navigates outside these.
`;
  const budget =
    opts.budget === null
      ? ""
      : `## Step budget (optional)

${opts.budget ?? "max_turns: 40"}
`;
  return `# Flow — checkout

## Entry point

https://staging.example.com/store

## Goal (the persona's own goal, in their terms)

Subscribe to the Pro plan and understand what I just paid for.

## Success criteria

The dashboard shows the active subscription.

${allowlist}
## Out of bounds (never executed, even inside the allowlist)

Payments, account deletion, and destructive submits are always out of bounds.

- the "invite teammates" email sender

## App version pin

Deployed version string in the footer: v1.4.2 (commit abc1234).

${budget}`;
}

// @scenario the shipped template filled in → parses with every field populated
test("a filled-in template parses with every field populated", () => {
  const result = parseFlow(filledFlow());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const f = result.flow;
  assert.equal(f.name, "checkout");
  assert.match(f.entryPoint, /staging\.example\.com\/store/);
  assert.match(f.goal, /Pro plan/);
  assert.match(f.successCriteria, /active subscription/);
  assert.deepEqual(f.allowlist, ["staging.example.com", "accounts.example.com"]);
  assert.deepEqual(f.outOfBounds, ['the "invite teammates" email sender']);
  assert.match(f.appVersionPin, /v1\.4\.2/);
  assert.equal(f.maxTurns, 40);
});

test("the shipped template's own headings all land on their sections", () => {
  // The template's placeholder bodies count as content; what this proves is
  // that every heading spelling in templates/persona/FLOW.md maps to a
  // canonical section — a heading rename there must break here.
  const result = parseFlow(fs.readFileSync(TEMPLATE, "utf8"));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.flow.maxTurns, 40); // the template's own max_turns line
});

// @scenario a flow missing the allowlist → the error names "Domain allowlist"
test('a flow missing the allowlist names "Domain allowlist" specifically', () => {
  const result = parseFlow(filledFlow({ allowlist: false }));
  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.deepEqual(result.missing, ["Domain allowlist"]);
  assert.match(flowErrorMessage(result), /Domain allowlist/);
});

test("an allowlist section with prose but zero entries is as missing as no section", () => {
  const text = filledFlow({ allowlist: false }).replace(
    "## Out of bounds",
    "## Domain allowlist (hard boundary)\n\nPoint flows at staging, not production.\n\n## Out of bounds",
  );
  const result = parseFlow(text);
  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.deepEqual(result.missing, ["Domain allowlist"]);
});

test("every missing section is named, in template order", () => {
  const result = parseFlow("# Flow — empty\n\nnothing here\n");
  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.deepEqual(result.missing, [...REQUIRED_SECTIONS]);
  for (const label of REQUIRED_SECTIONS) assert.match(result.reason, new RegExp(label));
});

// @scenario allows("https://staging.example.com/x") with ["staging.example.com"] → true
// @scenario allows("https://staging.example.com.evil.io/x") with the same → false
test("allows() is hostname-suffix matching, never substring", () => {
  const result = parseFlow(filledFlow());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const { allows } = result.flow;

  assert.equal(allows("https://staging.example.com/x"), true);
  assert.equal(allows("https://sub.accounts.example.com/login"), true);
  // The attack shapes: the allowed name as a substring, prefix, or left label.
  assert.equal(allows("https://staging.example.com.evil.io/x"), false);
  assert.equal(allows("https://evil-staging.example.com.attacker.io/"), false);
  assert.equal(allows("https://notstaging.example.com/"), false); // no dot boundary
  assert.equal(allows("https://example.com/"), false); // parent of an allowed host is NOT allowed
  assert.equal(allows("not a url"), false); // fails closed
});

test("hostAllowed handles case, trailing dots, and empty entries", () => {
  assert.equal(hostAllowed(["Staging.Example.COM"], "https://STAGING.example.com./x"), true);
  assert.equal(hostAllowed([""], "https://anything.io/"), false);
  assert.equal(hostAllowed(["example.com"], "https://deep.sub.example.com/"), true);
});

// @scenario "https://evil.io\@staging.example.com/" with ["staging.example.com"] → false
// WHATWG parsers (new URL, Chromium) treat '\' as an authority terminator in
// http(s) URLs: the real host of the first URL is evil.io, of the second
// staging.example.com. hooks/persona-guard.sh pins the same two verdicts in
// scripts/test-persona-guard.sh — the hook and this function must never diverge.
test("hostAllowed follows WHATWG backslash authority termination", () => {
  assert.equal(hostAllowed(["staging.example.com"], "https://evil.io\\@staging.example.com/"), false);
  assert.equal(hostAllowed(["staging.example.com"], "https://staging.example.com\\@evil.io/"), true);
});

// @scenario max_turns absent → 40; present → honored
test("max_turns defaults to 40 when absent and is honored when present", () => {
  const absent = parseFlow(filledFlow({ budget: null }));
  assert.equal(absent.status, "ok");
  if (absent.status === "ok") assert.equal(absent.flow.maxTurns, DEFAULT_MAX_TURNS);

  const present = parseFlow(filledFlow({ budget: "max_turns: 12" }));
  assert.equal(present.status, "ok");
  if (present.status === "ok") assert.equal(present.flow.maxTurns, 12);
});

test("a malformed max_turns is a named error, never guessed around", () => {
  for (const bad of ["max_turns: soon", "max_turns: 0", "max_turns: -3", "max_turns: 4.5"]) {
    const result = parseFlow(filledFlow({ budget: bad }));
    assert.equal(result.status, "malformed", bad);
    if (result.status === "malformed") assert.match(result.reason, /max_turns/);
  }
});
