// The gate has to actually run the suites.
//
// `npm test` enumerates every suite by name, which is fast and explicit and has exactly
// one failure mode: a new test file lands, nobody adds it to the list, and it passes when
// invoked by hand while `make test` — the stated gate — never runs it. That happened once
// (test/deadlock-repair.test.ts shipped unlisted), so it is a test now.
//
// A file dropped in test/ is a claim that something is covered. This asserts the gate
// makes good on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TEST_DIR = import.meta.dirname;
const PKG = path.join(TEST_DIR, "..", "package.json");

test("every test/*.test.ts is enumerated in the package `test` script", () => {
  const script = String(
    (JSON.parse(fs.readFileSync(PKG, "utf8")) as { scripts: Record<string, string> }).scripts.test,
  );
  const listed = new Set(script.match(/test\/[\w.-]+\.test\.ts/g) ?? []);
  const onDisk = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts")).sort();

  assert.ok(onDisk.length > 0, "no suites found on disk — the glob is wrong");
  const missing = onDisk.filter((f) => !listed.has(`test/${f}`));
  assert.deepEqual(
    missing,
    [],
    `these suites exist but \`make test\` never runs them — add them to packages/driver/package.json: ${missing.join(", ")}`,
  );
});

test("the package `test` script names no suite that does not exist", () => {
  const script = String(
    (JSON.parse(fs.readFileSync(PKG, "utf8")) as { scripts: Record<string, string> }).scripts.test,
  );
  const listed = [...new Set(script.match(/test\/[\w.-]+\.test\.ts/g) ?? [])].sort();
  const stale = listed.filter((f) => !fs.existsSync(path.join(TEST_DIR, "..", f)));
  assert.deepEqual(stale, [], `the test script names suites that are gone: ${stale.join(", ")}`);
});
