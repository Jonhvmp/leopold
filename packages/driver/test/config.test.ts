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
const KEYS = ["LEOPOLD_REVIEW", "LEOPOLD_HYPOTHESES", "LEOPOLD_SMART_ROUTING", "LEOPOLD_LEARN_ON_FINISH"];
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
