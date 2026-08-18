// Encrypted secret vault: round-trip, on-disk encryption (no plaintext leak),
// 0600 key, name validation, and the env apply/restore.
// The master key is isolated into a temp CLAUDE_CONFIG_DIR (keyPath() reads the env
// at call time), so this never touches the real ~/.claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  setSecret, loadSecrets, listSecretNames, isValidName, applySecretsEnv, keyPath, vaultPath,
  maskCredentials,
} from "../src/secrets.ts";

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "leo-cfg-"));
const tmpLeo = () => fs.mkdtempSync(path.join(os.tmpdir(), "leo-sec-"));

test("set/load round-trips through the encrypted vault", () => {
  const leo = tmpLeo();
  setSecret(leo, "API_KEY", "s3cr3t-value");
  setSecret(leo, "TOKEN", "another");
  assert.deepEqual(loadSecrets(leo), { API_KEY: "s3cr3t-value", TOKEN: "another" });
  assert.deepEqual(listSecretNames(leo), ["API_KEY", "TOKEN"]);
});

test("the on-disk vault is encrypted (no plaintext leak)", () => {
  const leo = tmpLeo();
  setSecret(leo, "API_KEY", "PLAINTEXT_NEEDLE");
  const raw = fs.readFileSync(vaultPath(leo), "utf8");
  assert.ok(!raw.includes("PLAINTEXT_NEEDLE"), "value must not appear in the vault file");
  assert.ok(!raw.includes("API_KEY"), "name must not appear in cleartext");
});

test("the master key file is created with mode 0600", () => {
  const leo = tmpLeo();
  setSecret(leo, "X", "y");
  assert.equal(fs.statSync(keyPath()).mode & 0o777, 0o600);
});

test("isValidName accepts env names, rejects junk", () => {
  for (const ok of ["API_KEY", "_x9", "TOKEN"]) assert.equal(isValidName(ok), true, ok);
  for (const bad of ["9bad", "has-dash", "has space", ""]) assert.equal(isValidName(bad), false, bad);
});

test("setSecret rejects an invalid name", () => {
  assert.throws(() => setSecret(tmpLeo(), "bad-name", "x"));
});

test("applySecretsEnv sets then restores process.env", () => {
  const leo = tmpLeo();
  setSecret(leo, "LEO_TEST_SECRET", "v1");
  assert.equal(process.env.LEO_TEST_SECRET, undefined);
  const { restore } = applySecretsEnv(leo);
  assert.equal(process.env.LEO_TEST_SECRET, "v1");
  restore();
  assert.equal(process.env.LEO_TEST_SECRET, undefined);
});

// --- maskCredentials: credential-shaped strings never leave a report ------------------

test("maskCredentials masks every credential family", () => {
  const cases: Array<[string, string]> = [
    ["key sk-proj-AAAAABBBBBCCCCCDDDDD1234 here", "sk-proj-AAAAABBBBB"],
    ["id AKIAIOSFODNN7EXAMPLE used", "AKIAIOSFODNN7"],
    ["tok ghp_AbCdEfGhIjKlMnOpQrStUvWx123456 pushed", "ghp_AbCdEfGh"],
    ["pat github_pat_11AAAAAAA0abcdefGHIJKLmn set", "github_pat_11AAAAAAA0"],
    ["slack xoxb-1234567890-abcdefghij wired", "xoxb-1234567890"],
    ["google AIzaSyA1234567890abcdefghijklmnopqrstu set", "AIzaSyA123"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N seen", "eyJhbGciOiJIUzI1NiJ9"],
    ["Authorization: Bearer abcdef1234567890ABCDEF sent", "abcdef1234567890ABCDEF"],
    ["config api_key = 'supersecretvalue99' loaded", "supersecretvalue99"],
    ["and password: hunter2secret99 typed", "hunter2secret99"],
  ];
  for (const [input, secret] of cases) {
    const out = maskCredentials(input);
    assert.ok(!out.includes(secret), `leaked: ${secret} in "${out}"`);
    assert.ok(out.includes("[redacted]"), `not marked: "${out}"`);
  }
});

test("maskCredentials keeps the readable context around a masked value", () => {
  assert.equal(
    maskCredentials("set api_key = abcdefgh12345678 and retry"),
    "set api_key = [redacted] and retry",
  );
  assert.equal(
    maskCredentials("Authorization: Bearer abcdef1234567890ABCDEF"),
    "Authorization: Bearer [redacted]",
  );
});

test("maskCredentials leaves ordinary content untouched — git SHAs, code, URLs", () => {
  for (const clean of [
    "commit 4c1a2b3d4e5f60718293a4b5c6d7e8f901234567 fixed the roll",
    "see https://example.com/docs/getting-started and packages/driver/src/loop.ts",
    "token_count_estimator = CHAR_COUNT",
    "the plan closed 11 of 11 items across 3 windows",
  ]) {
    assert.equal(maskCredentials(clean), clean, clean);
  }
});
