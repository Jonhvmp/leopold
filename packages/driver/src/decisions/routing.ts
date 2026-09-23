// Consumer 1: item routing, refined.
//
// `classify.ts` reads an item's WORDING through a keyword regex; its own header admits the
// compromise, and item 1's spike measured the cost on this project's history — 3 of 17 items
// misread, every one of them because a word appeared somewhere it did not mean what it looked
// like ("docs" inside a cited file path made a verification gate read as cosmetic).
//
// THE DIVISION OF LABOUR IS THE POINT. Code gathers EVIDENCE — which files the item names, how
// many references they have — because counting is something code does exactly and a model does
// badly. The provider judges BLAST RADIUS, which is the semantic part. Neither does the other's
// job.
//
// AND THE REGEX ALWAYS WINS TIES. `classifyItem()` is the required fallback: with no provider, a
// failure, a timeout, or an answer below its floor, the verdict it produced is returned field for
// field — `reason` included, so a reader can always tell which path decided.

import fs from "node:fs";
import path from "node:path";
import { classifyItem, type Effort, type ItemClass } from "../classify.js";
import { ask, bandOf, certaintyOf, type AskInput, type Band } from "./ask.js";
import { loadCatalog } from "./config.js";
import type { Catalog, ChoiceAnswer, NoulAnswer, Result } from "./contract.js";
import type { Provider } from "./provider.js";
import type { DecisionEvent } from "./events.js";
import { appendRow, type DecisionRow } from "./ledger.js";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface Evidence {
  item: string;
  /** Paths the item names that actually exist in the repo. Gathered, never guessed. */
  files: string[];
  /** How many files reference each of those paths. Counting is code's job, not a model's. */
  references: Record<string, number>;
  /** The charter, truncated: it can raise the floor for the whole project. */
  charter_excerpt: string;
}

/** Paths an item names. Backticked paths first, then bare-looking ones — both filtered to what
 *  exists on disk, so a hallucinated path in the item text cannot enter the evidence. */
export function namedPaths(item: string, repoRoot: string, exists = fs.existsSync): string[] {
  const candidates = new Set<string>();
  for (const m of item.matchAll(/`([^`\s]+\.[A-Za-z0-9]{1,6})`/g)) candidates.add(m[1]);
  for (const m of item.matchAll(/(?:^|[\s(])([\w./-]+\/[\w.-]+\.[A-Za-z0-9]{1,6})/g)) candidates.add(m[1]);
  return [...candidates].filter((p) => !p.startsWith("/") && exists(path.join(repoRoot, p))).sort();
}

export interface Probe {
  /** How many files mention this path. The default shells out to grep; tests inject counts. */
  references(target: string): number;
}

export function gatherEvidence(
  item: string,
  opts: { repoRoot: string; charter?: string; probe?: Probe; files?: string[] },
): Evidence {
  const files = opts.files ?? namedPaths(item, opts.repoRoot);
  const references: Record<string, number> = {};
  if (opts.probe) for (const f of files) references[f] = opts.probe.references(f);
  return {
    item,
    files,
    references,
    // Enough charter for a project-wide risk flag to be visible, bounded so the state stays
    // small — a large state costs accuracy, which is the provider's own documented weakness.
    charter_excerpt: (opts.charter ?? "").slice(0, 2000),
  };
}

/** Which direction the provider is pushing, relative to the deterministic verdict. The bars are
 *  asymmetric because the errors are: raising scrutiny is recoverable, lowering it skips a review
 *  that was deserved. (Item 1's priors: raise 0.65, lower 0.85.) */
function directionOf(from: Effort, to: Effort): "raise" | "lower" | undefined {
  const a = EFFORTS.indexOf(from);
  const b = EFFORTS.indexOf(to);
  if (a === b) return undefined;
  return b > a ? "raise" : "lower";
}

export interface RouteWithDecisionsOptions {
  item: string;
  charter?: string;
  repoRoot: string;
  /** `.leopold`, for the catalog and the provider config. */
  leoDir: string;
  catalogName?: string;
  provider?: Provider;
  probe?: Probe;
  files?: string[];
  emit?: (event: DecisionEvent) => void;
  env?: NodeJS.ProcessEnv;
  /** Write the decision rows the calibration ledger is built from. On by default: a ledger with
   *  no writer is a format, not a corpus. Set false in a test that must not touch disk. */
  ledger?: boolean;
  /** Injected for tests so a row is reproducible. */
  now?: () => Date;
  idFor?: (question: string) => string;
  config?: AskInput<never>["config"];
}

/** The same `ItemClass` shape `classifyItem()` returns, refined when — and only when — a provider
 *  answered above the bar for the direction it is pushing. */
export async function routeWithDecisions(opts: RouteWithDecisionsOptions): Promise<ItemClass> {
  const fallback = classifyItem(opts.item, opts.charter ?? "");
  const raw = loadCatalog(opts.leoDir, opts.catalogName ?? "routing");
  if (raw === null) return fallback;
  const catalog = raw as Catalog;

  const evidence = gatherEvidence(opts.item, {
    repoRoot: opts.repoRoot,
    charter: opts.charter,
    probe: opts.probe,
    files: opts.files,
  });

  const result = await ask<ItemClass>({
    catalog,
    questions: ["effort", "irreversible", "cosmetic"],
    state: evidence,
    fallback,
    provider: opts.provider,
    leoDir: opts.leoDir,
    config: opts.config,
    env: opts.env,
    emit: opts.emit,
  });

  const answer = <T extends Result>(id: string): T | null => {
    const a = result.answers[id];
    return a && a.ok === true ? (a as T) : null;
  };
  const effortAnswer = answer<ChoiceAnswer>("effort");
  const irreversible = answer<NoulAnswer>("irreversible");
  const cosmetic = answer<NoulAnswer>("cosmetic");

  // Nothing usable came back at all: the regex verdict stands, untouched.
  if (!effortAnswer && !irreversible && !cosmetic) return fallback;

  let effort = fallback.effort;
  let critical = fallback.critical;
  const why: string[] = [];

  if (effortAnswer && EFFORTS.includes(effortAnswer.choice as Effort)) {
    const proposed = effortAnswer.choice as Effort;
    const direction = directionOf(fallback.effort, proposed);
    const band: Band = bandOf(catalog.thresholds.effort, effortAnswer.confidence, direction);
    if (band === "act") {
      effort = proposed;
      why.push(`effort ${fallback.effort}->${proposed}`);
    }
  }

  // Criticality moves in both directions, each on its own bar. Setting it costs a review panel;
  // clearing it removes one, so clearing needs the stronger majority.
  if (irreversible) {
    const yes = irreversible.noul >= 0.5;
    const direction = yes === critical ? undefined : yes ? "raise" : "lower";
    const band = bandOf(
      catalog.thresholds.irreversible,
      Math.abs(irreversible.noul - 0.5) * 2,
      direction,
    );
    if (band === "act" && yes !== critical) {
      critical = yes;
      why.push(`critical ${!yes}->${yes}`);
    }
  }

  // Cosmetic only ever LOWERS, and only when nothing else says the item is critical. It exists
  // for the failure the spike measured — an item called trivial because a word looked trivial —
  // so it must not be able to talk its way past a real risk signal.
  if (cosmetic && !critical) {
    const band = bandOf(catalog.thresholds.cosmetic, Math.abs(cosmetic.noul - 0.5) * 2, "lower");
    if (band === "act" && cosmetic.noul >= 0.5 && effort !== "low") {
      effort = "low";
      why.push("cosmetic");
    }
  }

  // THE LEDGER'S DECISION HALF. One row per usable answer, written when the call is made — the
  // outcome arrives turns later and is a SECOND row (see ledger.ts). A consumer that records
  // decisions and never their outcomes still cannot fit a threshold, so `recordOutcome` must be
  // called when the review panel closes the item; that callsite lives in the driver's loop, not
  // here, and until it exists the corpus has decisions with no outcomes and `proposeThresholds`
  // correctly proposes nothing.
  if (opts.ledger !== false) {
    const stamp = (opts.now ?? (() => new Date()))().toISOString();
    for (const [question, answer] of Object.entries(result.answers)) {
      if (answer.ok !== true) continue;
      const certainty = certaintyOf(answer);
      const row: DecisionRow = {
        kind: "decision",
        id: (opts.idFor ?? ((q) => `${stamp}:${q}:${Math.random().toString(36).slice(2, 10)}`))(question),
        ts: stamp,
        consumer: "routing",
        question,
        provider: result.provider,
        model: answer.model,
        confidence: answer.confidence,
        certainty,
        band: result.bands[question],
        acted: why.length > 0 && result.bands[question] === "act",
      };
      try {
        appendRow(opts.leoDir, row);
      } catch {
        // A ledger that cannot be written must never cost a routing decision.
      }
    }
  }

  if (why.length === 0) return fallback;

  const model = effortAnswer?.model ?? irreversible?.model ?? cosmetic?.model ?? result.provider;
  return {
    effort,
    critical,
    reason: `${result.provider}/${model}: ${why.join(", ")} (was: ${fallback.reason})`,
    ...(evidence.files.length > 0 ? { files: evidence.files } : {}),
  };
}
