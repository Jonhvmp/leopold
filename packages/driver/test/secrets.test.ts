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
