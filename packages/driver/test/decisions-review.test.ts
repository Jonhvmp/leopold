// Consumer 2: review dedupe and demotion, and the asymmetry that makes it safe.
//
// Keeping a duplicate costs the worker a turn. Dropping a real blocker costs a bug. So every
// failure mode — no provider, low confidence, a thrown error, a timeout — leaves the panel's
// verdict exactly as `unionReviews()` produced it, and the tests assert that by comparing against
// the untouched input rather than against a hand-written expectation.
//
// MUTATION-VERIFIED: drop the `v.usable` check on the merge and the low-confidence case fails;
// flip the demotion to `>= 0.5` and three cases fail. (A third mutation was tried and dropped
// instead of kept: an "unchanged input" short-circuit turned out to be behaviourally redundant —
// the rebuilt result already deep-equals the input — so the branch was removed rather than left
// in with a comment claiming a guarantee no test could hold it to.)
//
// HERMETIC: a mkdtemp project with the shipped catalog, and stub providers. No network, no key.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refineReviews, type Provider, type ProviderDescriptor, type Result } from "../src/decisions/index.ts";
import type { ReviewResult } from "../src/review.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMPLATE = path.join(REPO, "templates", "decisions", "review.json");

const descriptor: ProviderDescriptor = {
  name: "stub", endpoint: "http://127.0.0.1:1/v1/systemone", model: "stub-1.0.0",
  calibrated: true, calibration_source: "trained", auth_env: "STUB_KEY",
  timeout_ms: 1000, max_options: 255, max_state_tokens: 32000,
};

/** `same` answers the pair question, `defect` the per-finding one. */
function stub(same: number, defect: number, opts: { throws?: boolean } = {}): Provider {
  return {
    descriptor,
    async ask(req) {
      if (opts.throws) throw new Error("socket hang up");
      const out: Record<string, Result> = {};
      for (const q of req.questions) {
        out[q] = {
          ok: true, type: "noul", noul: q === "same_defect" ? same : defect,
          confidence: null, provider: "stub", model: "stub-1.0.0",
        };
      }
      return out;
    },
  };
}

const base: ReviewResult = {
  ok: false,
  summary: "3 blocking findings",
  blocking: [
    { file: "src/pay.ts", issue: "the refund path dereferences `order` without checking it exists", severity: "blocking" },
    { file: "src/pay.ts", issue: "`order` may be undefined when a refund is retried, crashing the handler", severity: "blocking" },
    { file: "src/ui.ts", issue: "the button label should be sentence case", severity: "blocking" },
  ],
};

function project(t: TestContext, withCatalog = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leo-review-"));
  const leoDir = path.join(root, ".leopold");
  fs.mkdirSync(path.join(leoDir, "decisions"), { recursive: true });
  if (withCatalog) fs.copyFileSync(TEMPLATE, path.join(leoDir, "decisions", "review.json"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return leoDir;
}

test("scenario: with no provider the blocking set is byte-for-byte the panel's", async (t) => {
  const leoDir = project(t);
  assert.deepEqual(await refineReviews(base, { leoDir }), base);
});

test("a missing catalog also leaves the verdict untouched", async (t) => {
  const leoDir = project(t, false);
  assert.deepEqual(await refineReviews(base, { leoDir, provider: stub(0.99, 0.99) }), base);
});

test("scenario: two lenses describing one defect become one blocking finding", async (t) => {
  const leoDir = project(t);
  // Confident that every pair is the same defect, and that everything is a defect.
  const got = await refineReviews(base, { leoDir, provider: stub(0.97, 0.99) });
  assert.equal(got.blocking.length, 1, "the duplicates should have merged");
  assert.equal(got.blocking[0].issue, base.blocking[0].issue, "the FIRST wording is the one kept");
  assert.match(got.summary, /duplicate finding\(s\) merged/);
});

test("scenario: a dedupe answer below the bar keeps BOTH findings blocking", async (t) => {
  const leoDir = project(t);
  // 0.62 -> certainty 0.24, under the 0.5 floor: not usable, so nothing merges.
  const got = await refineReviews(base, { leoDir, provider: stub(0.62, 0.99) });
  assert.deepEqual(got, base, "an unsure dedupe must not merge");
});

test("scenario: a confident style-only finding is demoted; the defects are not", async (t) => {
  const leoDir = project(t);
  // Nothing is a duplicate; nothing is a defect (confidently).
  const got = await refineReviews(base, { leoDir, provider: stub(0.02, 0.01) });
  assert.equal(got.blocking.length, 0, "all three were confidently style-only");
  assert.equal(got.ok, true);
  assert.match(got.summary, /style-only finding\(s\) demoted/);
});

test("scenario: a provider failure never unblocks anything", async (t) => {
  const leoDir = project(t);
  for (const provider of [stub(0.99, 0.01, { throws: true }), undefined]) {
    assert.deepEqual(
      await refineReviews(base, { leoDir, provider }),
      base,
      "a failing provider changed the blocking set",
    );
  }
});

test("an uncertain defect answer keeps the finding blocking", async (t) => {
  const leoDir = project(t);
  // 0.45 is "probably not a defect" but nowhere near sure: it stays.
  const got = await refineReviews(base, { leoDir, provider: stub(0.02, 0.45) });
  assert.deepEqual(got, base, "an unsure demotion must not fire");
});

test("a clean panel is returned untouched without asking anything", async (t) => {
  const leoDir = project(t);
  let asked = false;
  const spy: Provider = { descriptor, async ask(req) { asked = true; return {}; } };
  const clean: ReviewResult = { ok: true, blocking: [], summary: "clean" };
  assert.deepEqual(await refineReviews(clean, { leoDir, provider: spy }), clean);
  assert.equal(asked, false, "a clean panel must cost nothing");
});
