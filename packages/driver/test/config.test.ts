// Guardrails-driven config toggles and their precedence: explicit CLI/env > brief > default.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { boolFrom, autonomyFrom, loadConfig, briefDigest, readAmendmentsAdded, initState } from "../src/config.ts";
import { OWNER_KEYS, type Brief } from "../src/types.ts";

const GUARDRAILS = `# Guardrails
## Quality & orchestration
- review: on
- hypotheses: off
- smart_routing: on
- learn_on_finish: on   # mine the run afterward
`;

// loadConfig reads process.env; snapshot and clear the knobs it looks at.
const KEYS = ["LEOPOLD_REVIEW", "LEOPOLD_HYPOTHESES", "LEOPOLD_SMART_ROUTING", "LEOPOLD_LEARN_ON_FINISH",
  "LEOPOLD_CONFORMANCE", "LEOPOLD_LITERAL_RESET", "LEOPOLD_BEST_OF_K", "LEOPOLD_SLICE_SCOPE", "LEOPOLD_AUTONOMY"];
function withCleanEnv<T>(fn: () => T): T {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  try { return fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("boolFrom reads on/off/true/false and tolerates comments; undefined when absent", () => {
  assert.equal(boolFrom("- review: on   # a comment", "review"), true);
  assert.equal(boolFrom("smart_routing: off", "smart_routing"), false);
  assert.equal(boolFrom("hypotheses: true", "hypotheses"), true);
  assert.equal(boolFrom("learn_on_finish: no", "learn_on_finish"), false);
  assert.equal(boolFrom("nothing here", "review"), undefined);
});

test("guardrails set the toggles when no CLI/env override is present", () => {
  withCleanEnv(() => {
    const cfg = loadConfig([], GUARDRAILS);
    assert.equal(cfg.review, true);
    assert.equal(cfg.hypotheses, false);
    assert.equal(cfg.smartRouting, true);
    assert.equal(cfg.learnOnFinish, true);
  });
});

test("built-in defaults apply when guardrails are silent", () => {
  withCleanEnv(() => {
    const cfg = loadConfig([], "");
    assert.equal(cfg.review, true);
    assert.equal(cfg.hypotheses, true);
    assert.equal(cfg.smartRouting, false);
    assert.equal(cfg.learnOnFinish, false);
  });
});

test("a CLI flag overrides the brief", () => {
  withCleanEnv(() => {
    // guardrails say review:on, hypotheses:off — flags flip both.
    const cfg = loadConfig(["--no-review", "--smart-routing", "--learn-on-finish"], GUARDRAILS);
    assert.equal(cfg.review, false, "--no-review beats review:on");
    assert.equal(cfg.smartRouting, true);
    assert.equal(cfg.learnOnFinish, true);
    // untouched-by-flag knob still follows the brief
    assert.equal(cfg.hypotheses, false);
  });
});

test("an env var overrides the brief", () => {
  withCleanEnv(() => {
    process.env.LEOPOLD_HYPOTHESES = "1"; // brief says off; env forces on
    process.env.LEOPOLD_SMART_ROUTING = "0"; // brief says on; env forces off
    const cfg = loadConfig([], GUARDRAILS);
    assert.equal(cfg.hypotheses, true);
    assert.equal(cfg.smartRouting, false);
  });
});

// --- autonomy: full | ask (the judgment posture) --------------------------------

test("autonomyFrom reads the posture out of a guardrails line, bold or bulleted", () => {
  assert.equal(autonomyFrom("- autonomy: ask"), "ask");
  assert.equal(autonomyFrom("autonomy: full   # nothing halts"), "full");
  assert.equal(autonomyFrom("- **autonomy**: ask"), "ask");
  assert.equal(autonomyFrom("- AUTONOMY: Ask"), "ask");
  assert.equal(autonomyFrom("nothing here"), undefined);
  assert.equal(autonomyFrom("- autonomy: sometimes"), undefined,
    "an unrecognized posture is not a licence to invent one");
});

test("autonomy defaults to full, and the brief or a flag or env can set it to ask", () => {
  withCleanEnv(() => {
    assert.equal(loadConfig([], "").autonomy, "full", "nothing halts by default");
    assert.equal(loadConfig([], "- autonomy: ask\n").autonomy, "ask", "the brief sets the posture");
    assert.equal(loadConfig(["--autonomy", "ask"], "").autonomy, "ask");
    assert.equal(loadConfig(["--ask"], "").autonomy, "ask");
    // Precedence: an explicit flag/env beats the brief, in both directions.
    assert.equal(loadConfig(["--autonomy", "full"], "- autonomy: ask\n").autonomy, "full");
    process.env.LEOPOLD_AUTONOMY = "ask";
    assert.equal(loadConfig([], "- autonomy: full\n").autonomy, "ask");
    process.env.LEOPOLD_AUTONOMY = "nonsense";
    assert.equal(loadConfig([], "- autonomy: ask\n").autonomy, "ask",
      "an unreadable override falls through to the brief, never to a silent default");
  });
});

// --- deeper-levers toggles (R1 conformance, R2 literal_reset, R3 best_of_k, slice_scope) ---

test("deeper-levers defaults: conformance/literal_reset on, best_of_k off, slice_scope off", () => {
  withCleanEnv(() => {
    const cfg = loadConfig([], "");
    assert.equal(cfg.conformance, true);
    assert.equal(cfg.literalReset, true);
    assert.equal(cfg.bestOfK, 1);       // 1 = off
    assert.equal(cfg.sliceScope, false);
  });
});

test("deeper-levers read from the brief guardrails", () => {
  withCleanEnv(() => {
    const g = `# Guardrails
- conformance: off
- literal_reset: off
- best_of_k: 3
- slice_scope: on
`;
    const cfg = loadConfig([], g);
    assert.equal(cfg.conformance, false);
    assert.equal(cfg.literalReset, false);
    assert.equal(cfg.bestOfK, 3);
    assert.equal(cfg.sliceScope, true);
  });
});

test("deeper-levers: CLI flags and env override the brief", () => {
  withCleanEnv(() => {
    const g = "- conformance: on\n- literal_reset: on\n- best_of_k: 1\n- slice_scope: off\n";
    const cfg = loadConfig(["--no-conformance", "--no-literal-reset", "--best-of-k", "5", "--slice-scope"], g);
    assert.equal(cfg.conformance, false, "--no-conformance beats conformance:on");
    assert.equal(cfg.literalReset, false, "--no-literal-reset beats literal_reset:on");
    assert.equal(cfg.bestOfK, 5, "--best-of-k 5 beats best_of_k:1");
    assert.equal(cfg.sliceScope, true, "--slice-scope beats slice_scope:off");
  });
});

test("best_of_k clamps a bogus value back to the guardrails/default", () => {
  withCleanEnv(() => {
    process.env.LEOPOLD_BEST_OF_K = "0"; // <1 is invalid → falls back
    assert.equal(loadConfig([], "- best_of_k: 4\n").bestOfK, 4);
    assert.equal(loadConfig([], "").bestOfK, 1);
  });
});

// --- the brief receipt --------------------------------------------------------------
// A read-only node's guard refuses shell writes under `.leopold/`; this digest is the
// second net, because `.leopold/` is gitignored and no git-based signature can see a
// write there. It must move on a real write and stay put on the driver's own writes.

test("briefDigest catches a write to the brief, and ignores what the driver writes itself", () => {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-digest-"));
  const w = (name: string, body: string): void => fs.writeFileSync(path.join(leo, name), body);
  w("PLAN.md", "# Plan\n\n- [ ] Build the thing\n- [x] Ship the docs\n");
  w("GUARDRAILS.md", "# Guardrails\n- max_failures: 3\n");
  w("MISSION.md", "# Mission\n");
  w("CHARTER.md", "# Charter\n");
  const base = briefDigest(leo);

  // The driver's own writes during a node: events, state, the decision trail. Not a
  // node's doing, so the receipt must not cry wolf on them.
  fs.appendFileSync(path.join(leo, "events.jsonl"), '{"event":"item_start"}\n');
  fs.writeFileSync(path.join(leo, "state.json"), '{"iteration":4}');
  fs.appendFileSync(path.join(leo, "DECISIONS.md"), "\n## D1 — a fork\n");
  assert.equal(briefDigest(leo), base, "the driver's own bookkeeping is not a node edit");

  // A checkbox closed by another item of a --parallel run is legitimate too.
  w("PLAN.md", "# Plan\n\n- [x] Build the thing\n- [x] Ship the docs\n");
  assert.equal(briefDigest(leo), base, "a concurrently closed checkbox is not a node edit");

  // Everything the bounds actually protect DOES move it.
  w("PLAN.md", "# Plan\n\n- [x] Build the thing\n");
  assert.notEqual(briefDigest(leo), base, "a deleted item");
  w("PLAN.md", "# Plan\n\n- [x] Build something else\n- [x] Ship the docs\n");
  assert.notEqual(briefDigest(leo), base, "a rewritten item");
  w("PLAN.md", "# Plan\n\n- [x] Build the thing\n- [x] Ship the docs\n- [ ] Snuck in\n");
  assert.notEqual(briefDigest(leo), base, "an injected item");
  w("PLAN.md", "# Plan\n\n- [x] Build the thing\n- [x] Ship the docs\n");
  assert.equal(briefDigest(leo), base, "…and back to where it started");

  fs.appendFileSync(path.join(leo, "GUARDRAILS.md"), "- max_failures: 99\n");
  assert.notEqual(briefDigest(leo), base, "GUARDRAILS.md, the boundary a run may never widen");
  w("GUARDRAILS.md", "# Guardrails\n- max_failures: 3\n");
  fs.writeFileSync(path.join(leo, "ALLOW_GIT"), "");
  assert.notEqual(briefDigest(leo), base, "and a git-lock token that appeared out of nowhere");
});

test("readAmendmentsAdded reads the run's spent budget, and refuses to invent one", () => {
  const leo = fs.mkdtempSync(path.join(os.tmpdir(), "leo-budget-"));
  assert.equal(readAmendmentsAdded(leo), 0, "no state.json at all");
  const w = (body: string): void => fs.writeFileSync(path.join(leo, "state.json"), body);
  w("{}"); assert.equal(readAmendmentsAdded(leo), 0);
  w("not json at all"); assert.equal(readAmendmentsAdded(leo), 0);
  w('{"amendments_added":2}'); assert.equal(readAmendmentsAdded(leo), 2);
  w('{"amendments_added":"3"}'); assert.equal(readAmendmentsAdded(leo), 3, "a string counter still counts");
  w('{"amendments_added":-5}'); assert.equal(readAmendmentsAdded(leo), 0, "a negative counter is not a refund");
});

// The posture flag is the one knob whose default is the PERMISSIVE side, so it is the one
// knob that must not fail open. Two ways it did: `flagValue` only read the space-separated
// form, so `--autonomy=ask` was ignored rather than rejected; and an unrecognized explicit
// value fell straight through to the default. Either way an operator who was switching
// autonomy OFF silently got it on, with @human nodes executed and escalations auto-settled.
test("an autonomy value the driver cannot read never resolves to the permissive posture", () => {
  const warn = console.warn; const seen: string[] = [];
  console.warn = ((m: unknown) => { seen.push(String(m)); }) as typeof console.warn;
  try {
    withCleanEnv(() => {
      assert.equal(loadConfig(["--autonomy=ask"], "").autonomy, "ask", "the --flag=value form must be read");
      assert.equal(loadConfig(["--autonomy=full"], "").autonomy, "full");
      assert.equal(loadConfig(["--autonomy", "asked"], "").autonomy, "ask", "a typo takes the safe side");
      assert.equal(loadConfig(["--autonomy", "Ask-only"], "").autonomy, "ask");
    });
  } finally { console.warn = warn; }
  assert.equal(seen.filter((m) => /not a posture I know/.test(m)).length, 2,
    "an ignored posture must SAY it was ignored — silent is how the operator never finds out");
  // And the default is untouched: nothing typed still means full (decision D0).
  withCleanEnv(() => { assert.equal(loadConfig([], "").autonomy, "full"); });
});

test("initState writes the driver's owner record: engine driver, no session, this process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-owner-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(leoDir);
  const brief = { mission: "", charter: "", guardrails: "", planPath: path.join(leoDir, "PLAN.md"), root, leoDir } as Brief;
  const st = initState(brief, { harness: "codex" });
  // No interactive session can ever match an empty session_id: the in-session Stop hook
  // continues nobody inside a driver run, and the driver's own workers stop freely.
  assert.deepEqual(st.owner, {
    session_id: "", harness: "codex", engine: "driver", claimed_at: st.started_at, pid: process.pid, transcript_path: "",
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(leoDir, "state.json"), "utf8")) as { owner: Record<string, unknown> };
  assert.deepEqual(Object.keys(onDisk.owner).sort(), [...OWNER_KEYS].sort());
  assert.equal(initState(brief).owner?.harness, "", "harness unknown -> empty, never invented");
});
