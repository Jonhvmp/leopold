// Encrypted secret vault for a run. Secrets the work needs are injected into the
// worker as environment variables (resolved at run time), so they reach the worker's
// Bash tool as $NAME but never land in the prompt/transcript the model sees.
//
// At rest: AES-256-GCM. The 32-byte master key lives at ~/.claude/leopold/secrets.key
// (mode 0600, generated on demand); the vault is .leopold/secrets.env (the encrypted
// blob). Mirrors paperclip's local-encrypted-provider, file edition — no DB.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findLeoDir } from "./config.js";

const ALGO = "aes-256-gcm";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function keyPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "leopold", "secrets.key");
}

export function vaultPath(leoDir: string): string {
  return path.join(leoDir, "secrets.env");
}

/** Paths the guard must protect from the worker (the vault and the master key). */
export function secretFilePaths(leoDir: string): string[] {
  return [vaultPath(leoDir), keyPath()];
}

function loadOrCreateKey(): Buffer {
  const kp = keyPath();
  if (fs.existsSync(kp)) return Buffer.from(fs.readFileSync(kp, "utf8").trim(), "base64");
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(kp), { recursive: true });
  fs.writeFileSync(kp, key.toString("base64"), { mode: 0o600 });
  try { fs.chmodSync(kp, 0o600); } catch { /* best effort on platforms without chmod */ }
  return key;
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"),
  });
}

function decrypt(key: Buffer, blob: string): string {
  const o = JSON.parse(blob) as { iv: string; tag: string; data: string };
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(o.iv, "base64"));
  decipher.setAuthTag(Buffer.from(o.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(o.data, "base64")), decipher.final()]).toString("utf8");
}

function readVault(leoDir: string): Record<string, string> {
  const vp = vaultPath(leoDir);
  if (!fs.existsSync(vp)) return {};
  try {
    return JSON.parse(decrypt(loadOrCreateKey(), fs.readFileSync(vp, "utf8"))) as Record<string, string>;
  } catch {
    return {}; // wrong/rotated key or corrupt vault — fail closed (no secrets)
  }
}

function writeVault(leoDir: string, secrets: Record<string, string>): void {
  fs.writeFileSync(vaultPath(leoDir), encrypt(loadOrCreateKey(), JSON.stringify(secrets)), { mode: 0o600 });
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function setSecret(leoDir: string, name: string, value: string): void {
  if (!isValidName(name)) throw new Error(`invalid secret name: ${name}`);
  const s = readVault(leoDir);
  s[name] = value;
  writeVault(leoDir, s);
}

/** Decrypt the vault to {NAME: value} for env injection. */
export function loadSecrets(leoDir: string): Record<string, string> {
  return readVault(leoDir);
}

/** Set the run's secrets into process.env for the duration of one item; returns a
 *  restore() that puts the previous environment back (so secrets don't outlive the item). */
export function applySecretsEnv(leoDir: string): { restore: () => void } {
  const secrets = loadSecrets(leoDir);
  const prev: Array<[string, string | undefined]> = [];
  for (const [k, v] of Object.entries(secrets)) {
    prev.push([k, process.env[k]]);
    process.env[k] = v;
  }
  return {
    restore() {
      for (const [k, p] of prev) {
        if (p === undefined) delete process.env[k];
        else process.env[k] = p;
      }
    },
  };
}

export function listSecretNames(leoDir: string): string[] {
  return Object.keys(readVault(leoDir)).sort();
}

/** `leopold-driver secrets set NAME | list` — the value for `set` is read from
 *  stdin so it never appears in shell history. */
export function runSecrets(argv: string[]): number {
  const sub = argv[0];
  let leoDir: string;
  try {
    leoDir = findLeoDir(process.cwd());
  } catch {
    console.error("leopold-driver secrets: no .leopold/ here. Run /leopold-brief first.");
    return 1;
  }
  if (sub === "list") {
    const names = listSecretNames(leoDir);
    process.stdout.write(names.length ? names.join("\n") + "\n" : "(no secrets)\n");
    return 0;
  }
  if (sub === "set") {
    const name = argv[1];
    if (!name || !isValidName(name)) {
      console.error("usage: leopold-driver secrets set NAME   (NAME = a valid env var name)");
      return 2;
    }
    let value: string;
    try {
      value = fs.readFileSync(0, "utf8").replace(/\r?\n$/, ""); // stdin, strip one trailing newline
    } catch {
      console.error("could not read the secret value from stdin");
      return 1;
    }
    setSecret(leoDir, name, value);
    console.log(`secret '${name}' stored (encrypted) in .leopold/secrets.env`);
    return 0;
  }
  console.error("usage: leopold-driver secrets set NAME | list");
  return 2;
}
