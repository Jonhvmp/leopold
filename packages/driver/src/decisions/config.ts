// Which provider is active, and on whose say-so.
//
// RESOLUTION ORDER, exactly as the plan states it: an explicit option beats the project's
// config file, which beats the environment, which beats `none`. The config file is the
// reviewable home — a human reads one file to know what this project asks a model and on
// what bars it acts — so it outranks an env var that nobody sees in a diff.

import fs from "node:fs";
import path from "node:path";
import type { ProviderDescriptor } from "./contract.js";

export const CONFIG_DIRNAME = "decisions";
export const CONFIG_BASENAME = "config.json";
export const PROVIDER_ENV = "LEOPOLD_DECISIONS_PROVIDER";

export interface DecisionsConfig {
  version?: string;
  /** The active provider's name. Absent means "consult the environment". */
  provider?: string;
  /** Every descriptor this project knows, by name. */
  providers?: Record<string, ProviderDescriptor>;
}

export function configPath(leoDir: string): string {
  return path.join(leoDir, CONFIG_DIRNAME, CONFIG_BASENAME);
}

/** Read the project's decisions config. A missing file is not an error — it is the
 *  overwhelmingly common case, and it means `none`. A MALFORMED file is also not a throw:
 *  it resolves to no provider, so a typo degrades to today's behavior instead of ending a run. */
export function loadConfig(leoDir: string): DecisionsConfig {
  const p = configPath(leoDir);
  if (!fs.existsSync(p)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DecisionsConfig) : {};
  } catch {
    return {};
  }
}

export interface Resolution {
  descriptor: ProviderDescriptor | null;
  /** Where the choice came from, for the event log and for `leopold doctor`. */
  source: "explicit" | "config" | "env" | "none";
  /** Set when a name was chosen but no descriptor backs it. */
  unknownName?: string;
}

export function catalogPath(leoDir: string, name: string): string {
  return path.join(leoDir, CONFIG_DIRNAME, `${name}.json`);
}

/** Read a named catalog from `.leopold/decisions/<name>.json`.
 *
 *  Returns null when the file is absent or unparseable — the caller turns that into the
 *  contract's `no_catalog` failure. Both seams read the same path by the same rule, which is what
 *  lets the parity suite compare their behaviour on a missing file. */
export function loadCatalog(leoDir: string, name: string): unknown | null {
  const p = catalogPath(leoDir, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function resolveDescriptor(
  config: DecisionsConfig,
  env: NodeJS.ProcessEnv = process.env,
): Resolution {
  const byName = (name: string, source: "config" | "env"): Resolution => {
    const d = config.providers?.[name];
    return d ? { descriptor: d, source } : { descriptor: null, source, unknownName: name };
  };
  if (config.provider) return byName(config.provider, "config");
  const fromEnv = env[PROVIDER_ENV];
  if (fromEnv) return byName(fromEnv, "env");
  return { descriptor: null, source: "none" };
}
