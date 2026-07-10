// Guardrails-driven config toggles and their precedence: explicit CLI/env > brief > default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boolFrom, loadConfig } from "../src/config.ts";

const GUARDRAILS = `# Guardrails
## Quality & orchestration
- review: on
- hypotheses: off
- smart_routing: on
- learn_on_finish: on   # mine the run afterward
`;

// loadConfig reads process.env; snapshot and clear the knobs it looks at.
const KEYS = ["LEOPOLD_REVIEW", "LEOPOLD_HYPOTHESES", "LEOPOLD_SMART_ROUTING", "LEOPOLD_LEARN_ON_FINISH",
  "LEOPOLD_CONFORMANCE", "LEOPOLD_LITERAL_RESET", "LEOPOLD_BEST_OF_K", "LEOPOLD_SLICE_SCOPE"];
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
