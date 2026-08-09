// WHAT THE GUARD ENFORCES, AND WHAT LEOPOLD IS ALLOWED TO SAY IT ENFORCES.
//
// `autonomy: full` makes a @human node execute under a synthesized role instead of
// waiting for a person, and a @human node is exactly where the irreversible calls live
// ("approve the production cutover"). The safety argument for that is the trust boundary:
// a role DECIDES, it never ships. So the prompts that hand a role the seat had better
// describe that boundary accurately — a role told a hook will catch `npm publish` has no
// reason to hold back, and nothing would stop it.
//
// hooks/guard-irreversible.sh denies TWO things and says so in its own header: "git
// commit/push ... That is the ENTIRE scope". scripts/test-guard.sh asserts the other side
// deliberately — `gh pr create`, `gh release create`, `npm publish` and `cargo publish`
// are ALLOWED, and edits (GUARDRAILS.md included) are never guarded.
//
// This suite is the bridge between those two facts and the words Leopold ships. It runs
// the REAL guard to establish what is enforced, then asserts that no prompt surface —
// driver or in-session hook, so BOTH engines — credits the guard (or any hook) with a
// denial it does not perform. Add a denial to the guard and the ground-truth half fails
// first, which is the right order: change the guard, then change the wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NO_EXECUTION_CLAUSE, personaAppend, parsePersona } from "../src/persona.ts";
import { escalationSystemPrompt } from "../src/conductor.ts";
import { buildHumanNodePrompt } from "../src/kinds.ts";
import type { Brief } from "../src/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GUARD = path.join(REPO, "hooks", "guard-irreversible.sh");
const STOP_HOOK = path.join(REPO, "hooks", "stop-continuity.sh");

/** bash + jq are what both hooks require. Absent -> say so, never assert nonsense. */
function missing(): string | false {
  if (!fs.existsSync(GUARD)) return "hooks/guard-irreversible.sh not found";
  if (!fs.existsSync(STOP_HOOK)) return "hooks/stop-continuity.sh not found";
  const r = spawnSync("bash", ["-c", "command -v jq >/dev/null"], { stdio: "ignore" });
  if (r.error) return "bash is not available";
  if (r.status !== 0) return "jq is not installed (the hooks require it)";
  return false;
}
const MISSING = missing();

/** Run the real PreToolUse guard against one Bash command in a hermetic active run. */
function guardSays(command: string): "deny" | "allow" {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-guard-"));
  try {
    fs.mkdirSync(path.join(root, ".leopold"));
    fs.writeFileSync(
      path.join(root, ".leopold", "state.json"),
      JSON.stringify({ active: true, iteration: 1 }),
    );
    const r = spawnSync("bash", [GUARD], {
      input: JSON.stringify({ tool_name: "Bash", cwd: root, tool_input: { command } }),
      encoding: "utf8",
    });
    return /"permissionDecision":"deny"/.test(r.stdout ?? "") ? "deny" : "allow";
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The instruction the in-session engine re-injects at a @human node under `autonomy: full`.
 *  Read from the hook itself, so the assertion below covers the bash engine too. */
function hookHumanNote(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-note-"));
  try {
    const leo = path.join(root, ".leopold");
    fs.mkdirSync(leo);
    fs.writeFileSync(path.join(leo, "PLAN.md"), "- [ ] @human Approve the production cutover\n");
    fs.writeFileSync(path.join(leo, "GUARDRAILS.md"), "# Guardrails\n- autonomy: full\n");
    fs.writeFileSync(
      path.join(leo, "state.json"),
      JSON.stringify({ active: true, iteration: 1, max_iterations: 50 }),
    );
    const r = spawnSync("bash", [STOP_HOOK], {
      input: JSON.stringify({ cwd: root }),
      encoding: "utf8",
      env: { ...process.env, LEOPOLD_AUTONOMY: "" },
    });
    const out = JSON.parse((r.stdout ?? "").trim() || "{}") as { reason?: string };
    return out.reason ?? "";
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- ground truth: what the shipped guard actually does -----------------------------

const ENFORCED = ["git commit -m x", "git push origin main", "git push --force"];
const NOT_ENFORCED = [
  "git tag v1.0.0",
  "npm publish",
  "cargo publish",
  "gh pr create --fill",
  "gh release create v1",
];

test("the guard denies git commit and git push — and nothing else", { skip: MISSING }, () => {
  for (const c of ENFORCED) assert.equal(guardSays(c), "deny", `${c} must be denied`);
  for (const c of NOT_ENFORCED) {
    assert.equal(
      guardSays(c),
      "allow",
      `${c} is NOT blocked by the guard. If you just made it so, update every prompt below ` +
        `(and docs/reference/hooks.md#what-the-guard-enforces) to match.`,
    );
  }
});

// --- the wording: no prompt may credit an enforcer with a denial it does not perform ---

/** A word that names something UNENFORCED. `PR` is matched whole so "PROMPT" is not a hit. */
const UNENFORCED_WORD = /\b(tag|tags|tagging|publish|publishes|publishing|release|releases|PR)\b/;

/** An enforcer, and an act of enforcement. Tested independently of each other and of word
 *  order, because "denied by the guard" and "the guard denies" are the same overclaim. */
const ENFORCER = /\b(guard|hook|hooks)\b/i;
const ENFORCES = /\b(den|block|lock|prevent|refus|enforc|stop)/i;

/** Sentences that credit the guard/a hook with enforcing something. `GUARDRAILS` never
 *  matches `\bguard\b` (the trailing letters are word characters), so a sentence merely
 *  forbidding a GUARDRAILS.md edit is not an enforcement claim — which is the point: it
 *  is a rule the role keeps, not one a hook keeps for it. */
function enforcementClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => ENFORCER.test(s) && ENFORCES.test(s));
}

const CHARTER = "## Hard rules\n- The git lock holds.\n- Never add a runtime dependency.\n";
const DESIGNER = JSON.stringify({
  name: "Mara Vance",
  role: "Release Engineer",
  expertise: ["blue/green cutovers", "rollback drills"],
  optimizesFor: ["a reversible release"],
  rationale: "The item is a production cutover.",
});
const ITEM = { fork: "human" as const, item: "Approve the production cutover" };

function surfaces(): Array<[string, string]> {
  const brief = { mission: "ship it", charter: CHARTER } as Brief;
  const persona = parsePersona(DESIGNER, ITEM, CHARTER)!;
  return [
    ["NO_EXECUTION_CLAUSE", NO_EXECUTION_CLAUSE],
    ["personaAppend", personaAppend(persona)],
    ["escalationSystemPrompt", escalationSystemPrompt(brief)],
    ["escalationSystemPrompt (with persona)", escalationSystemPrompt(brief, persona)],
    ["buildHumanNodePrompt", buildHumanNodePrompt("Approve the production cutover", [])],
  ];
}

test("no driver prompt claims the guard denies something it allows", () => {
  for (const [where, text] of surfaces()) {
    for (const sentence of enforcementClaims(text)) {
      assert.ok(
        !UNENFORCED_WORD.test(sentence),
        `${where} credits a hook with enforcing something the guard allows:\n  "${sentence.trim()}"\n` +
          `The guard's entire scope is git commit and git push. Say the rest as a rule the ` +
          `role must keep, not as a denial that will be made for it.`,
      );
    }
  }
});

test("the in-session hook's @human instruction claims nothing the guard allows", { skip: MISSING }, () => {
  const note = hookHumanNote();
  assert.match(note, /THIS ITEM IS A @human NODE/, "the hook re-injected the persona instruction");
  for (const sentence of enforcementClaims(note)) {
    assert.ok(
      !UNENFORCED_WORD.test(sentence),
      `hooks/stop-continuity.sh credits a hook with enforcing something the guard allows:\n  "${sentence.trim()}"`,
    );
  }
});

// --- both engines say the same thing about the boundary ------------------------------

// --- the docs prose may not overclaim either -----------------------------------------

/** Enforcement verbs in the pt-BR twins. The English `ENFORCES` never matches `negados`,
 *  so a translated overclaim would sail through a sweep that only knows `den|block|…`. */
const ENFORCES_PT = /\b(neg|bloque|impede|impedid|proib|trava|barra)/i;

/** The unenforced things, as PROSE writes them. `UNENFORCED_WORD` matches the bare noun,
 *  which is right for a table cell (`gh release create`) and wrong for a sentence — "a
 *  persona may conclude 'release the cutover'" is not a claim about `gh release create`.
 *  So the prose sweep requires the command shape or a backticked token, which is exactly
 *  how the overclaim was written: "`git commit`, `push`, `tag`, `publish` and opening an
 *  external PR stay denied by …". */
const UNENFORCED_IN_PROSE =
  /`(tag|publish)`|\bgit tag\b|\b(npm|cargo) publish\b|\bgh (pr|release) create\b|\bexternal PR\b|\bPR externo\b/i;

/** Every page that describes what a persona may do. `hooks.md` is covered by the table
 *  check below; these are the prose pages, which is where the claim actually drifted:
 *  `plan-grammar.md` said tag/publish/PR "stay denied by hooks/guard-irreversible.sh"
 *  while the guard allows all three, and no test looked at prose. */
const PROSE_DOCS = [
  "docs/reference/plan-grammar.md",
  "docs/reference/plan-grammar.pt-BR.md",
  "docs/concepts/personas.md",
  "docs/concepts/personas.pt-BR.md",
  "docs/reference/driver-config.md",
  "docs/reference/driver-config.pt-BR.md",
  "docs/guardrails.md",
  "docs/guardrails.pt-BR.md",
];

test("no doc page claims the guard denies something it allows", { skip: MISSING }, () => {
  let swept = 0;
  for (const doc of PROSE_DOCS) {
    const file = path.join(REPO, doc);
    if (!fs.existsSync(file)) continue;
    swept += 1;
    const md = fs.readFileSync(file, "utf8");
    // Split on paragraph boundaries FIRST. A markdown bullet list carries no terminal
    // punctuation, so a sentence-only split glues "- `git tag`, publish a package" onto
    // the paragraph after it — and a page that correctly says "two of those are
    // machine-enforced, the rest are rules the role keeps" reads as one overclaiming
    // sentence. The list is its own block; judge it as one.
    const sentences = md
      .split(/\n\s*\n/)
      .flatMap((block) => block.split(/(?<=[.!?])\s+/))
      .filter((s) => ENFORCER.test(s) && (ENFORCES.test(s) || ENFORCES_PT.test(s)));
    for (const sentence of sentences) {
      assert.ok(
        !UNENFORCED_IN_PROSE.test(sentence),
        `${doc} credits the guard with enforcing something it allows:\n  "${sentence.trim()}"\n` +
          `The guard's entire scope is git commit and git push. tag / publish / PR are ` +
          `policy a role keeps, not a denial made for it — say so, the way ` +
          `docs/reference/hooks.md does.`,
      );
    }
  }
  assert.ok(swept >= 2, `the prose sweep found no docs to read (looked for ${PROSE_DOCS.length})`);
});

// --- the docs say what the guard does, and the guard is asked ------------------------

/** The row of a markdown table whose first cell backticks `cmd`, in `md`. */
function tableRow(md: string, cmd: string): string | undefined {
  return md.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${cmd}\``));
}

const VERDICTS: Array<[string, string, string]> = [
  // doc, the word for denied, the word for allowed
  ["docs/reference/hooks.md", "denied", "allowed"],
  ["docs/reference/hooks.pt-BR.md", "negado", "permitido"],
];

test("the guard table in the docs matches what the guard does", { skip: MISSING }, () => {
  for (const [doc, deniedWord, allowedWord] of VERDICTS) {
    const md = fs.readFileSync(path.join(REPO, doc), "utf8");
    for (const [cmd, want] of [
      ["git commit", "deny"], ["git push", "deny"], ["git push --force", "deny"],
      ["git tag", "allow"], ["npm publish", "allow"], ["cargo publish", "allow"],
      ["gh pr create", "allow"], ["gh release create", "allow"],
    ] as Array<[string, "deny" | "allow"]>) {
      const row = tableRow(md, cmd);
      assert.ok(row, `${doc} does not list \`${cmd}\` in the guard table`);
      const word = want === "deny" ? deniedWord : allowedWord;
      assert.ok(
        row.includes(`**${word}**`),
        `${doc} says the wrong thing about \`${cmd}\` — the guard answers ${want}:\n  ${row}`,
      );
      // And the guard itself agrees, for a command shaped like the row's.
      const probe = cmd === "git commit" ? "git commit -m x"
        : cmd === "git push" ? "git push origin main"
        : cmd === "git tag" ? "git tag v1.0.0"
        : cmd === "gh pr create" ? "gh pr create --fill"
        : cmd === "gh release create" ? "gh release create v1"
        : cmd;
      assert.equal(guardSays(probe), want, `${cmd}: the docs and the guard disagree`);
    }
  }
});

test("both engines name the same two enforced denials", { skip: MISSING }, () => {
  const note = hookHumanNote();
  for (const text of [NO_EXECUTION_CLAUSE, note]) {
    assert.match(text, /guard denies `git commit` and `git push`/);
    assert.match(text, /that is its entire scope/);
    assert.match(text, /EVERYTHING ELSE IS ON YOU/);
    assert.match(text, /no hook will stop you/);
  }
});
