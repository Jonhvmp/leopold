// Unit tests for the Codex backend's mapping layer: Agent-SDK options in, `codex
// exec` argv out, plus the pieces the budget and the read-only sessions depend on.
// The mapping is kept pure precisely so it can be tested without spawning codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildArgv, mapEffort, isReadOnly, systemPreamble, priceFor, usageToUsd,
} from "../src/providers/codex.ts";

test("a first turn starts a thread; a later turn resumes it", () => {
  const first = buildArgv({ readOnly: false });
  assert.deepEqual(first.slice(0, 2), ["exec", "--json"]);
  assert.ok(!first.includes("resume"));

  const next = buildArgv({ readOnly: false, resumeId: "abc-123" });
  assert.deepEqual(next.slice(0, 3), ["exec", "resume", "abc-123"]);
  assert.ok(next.includes("--json"));
});

test("read-only sessions get the read-only sandbox, working ones get write access", () => {
  assert.ok(buildArgv({ readOnly: true }).join(" ").includes("--sandbox read-only"));
  assert.ok(buildArgv({ readOnly: false }).join(" ").includes("--sandbox workspace-write"));
});

test("cwd, model and effort map onto codex flags", () => {
  const argv = buildArgv({ readOnly: false, cwd: "/repo", model: "gpt-5.6", effort: "high" });
  const s = argv.join(" ");
  assert.ok(s.includes("-C /repo"));
  assert.ok(s.includes("-m gpt-5.6"));
  assert.ok(s.includes('model_reasoning_effort="high"'));
});

test("the git lock rides on the same guard script both harnesses use", () => {
  const argv = buildArgv({ readOnly: false, guard: "/leo/hooks/guard-irreversible.sh" });
  const s = argv.join(" ");
  assert.ok(s.includes("hooks.PreToolUse="), "the guard is wired as a PreToolUse hook");
  assert.ok(s.includes('matcher="Bash"'));
  assert.ok(s.includes("guard-irreversible.sh"));
  // Config-file hooks are inert until trusted, and a headless run has nobody to
  // trust them — without this the lock would silently not exist.
  assert.ok(argv.includes("--dangerously-bypass-hook-trust"));
});

test("no guard requested means no hook wiring and no trust bypass", () => {
  const argv = buildArgv({ readOnly: true });
  assert.ok(!argv.join(" ").includes("hooks.PreToolUse"));
  assert.ok(!argv.includes("--dangerously-bypass-hook-trust"));
});

test("the guard command survives paths with spaces", () => {
  const argv = buildArgv({ readOnly: false, guard: "/home/a b/hooks/guard.sh" });
  const cfg = argv[argv.indexOf("-c", argv.indexOf("-c") + 1) + 1] ?? argv.find((a) => a.startsWith("hooks."));
  const wired = argv.find((a) => a.includes("guard.sh")) ?? "";
  assert.ok(wired.includes('"/home/a b/hooks/guard.sh"'), `quoted: ${wired} ${cfg ?? ""}`);
});

test("effort maps across the two scales, and unknown efforts are dropped", () => {
  assert.equal(mapEffort("low"), "low");
  assert.equal(mapEffort("high"), "high");
  assert.equal(mapEffort("xhigh"), "xhigh");
  assert.equal(mapEffort("max"), "xhigh", "Claude's top tier is Codex's top tier");
  assert.equal(mapEffort("wildly-fast"), undefined);
  assert.equal(mapEffort(undefined), undefined);
});

test("disallowing the edit tools is what makes a session read-only", () => {
  assert.equal(isReadOnly({ disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"] }), true);
  assert.equal(isReadOnly({ allowedTools: ["Bash", "Read", "Grep", "Glob"] }), true);
  assert.equal(isReadOnly({ allowedTools: [] }), true, "a no-tools reasoning session cannot edit");
  assert.equal(isReadOnly({}), false, "a worker session defaults to write access");
  assert.equal(isReadOnly({ allowedTools: ["Bash", "Edit"] }), false);
});

test("the system prompt flattens to the instructions Codex can actually use", () => {
  assert.equal(systemPreamble("be brief"), "be brief");
  // The claude_code preset has no Codex counterpart; only the appended half carries.
  assert.equal(
    systemPreamble({ type: "preset", preset: "claude_code", append: "You are a Leopold worker." }),
    "You are a Leopold worker.",
  );
  assert.equal(systemPreamble(undefined), "");
});

test("token usage prices out, so --budget-usd still bites on Codex", () => {
  const [inP, outP] = priceFor("gpt-5.6-sol");
  assert.ok(inP > 0 && outP > 0);
  // An unknown model must never price at zero — that would silently disable the budget.
  const [uIn, uOut] = priceFor("some-unreleased-model");
  assert.ok(uIn > 0 && uOut > 0);

  const usd = usageToUsd(
    { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 1_000_000 },
    "gpt-5.6",
  );
  assert.ok(Math.abs(usd - (inP + outP)) < 1e-9, `${usd}`);
  assert.equal(usageToUsd(undefined, "gpt-5.6"), 0);
});

test("cached input is billed at the cache-read rate, not the full one", () => {
  const full = usageToUsd({ input_tokens: 1_000_000, cached_input_tokens: 0 }, "gpt-5.6");
  const cached = usageToUsd({ input_tokens: 1_000_000, cached_input_tokens: 1_000_000 }, "gpt-5.6");
  assert.ok(cached < full, `${cached} should be cheaper than ${full}`);
  assert.ok(cached > 0, "cached reads still cost something");
});
