// `leopold recall <query>`: the command a run (or a human) asks "what did this
// project already decide?" — and gets an answer with the Reversal attached.
//
// It searches THIS project's `.leopold/runs/` and nothing else: cwd scope is the
// authorization model, exactly as the memory core draws it. Zero network, zero
// dependencies — searchRuns is a ranked lexical walk over the archive, and this
// file only resolves the directory, parses the flags, and prints.
//
// The output is PAST-RUN TEXT. The text form's FIRST line is the untrusted-data
// framing (PAST_RUN_DATA_AUTHORITY — the one home on this surface), and the JSON
// form carries the same sentence in `data_authority`, so a machine consumer that
// pastes hits into a prompt has the framing in hand.
//
// Exit codes are the contract: 0 for an answer — including "no archived runs yet"
// and "no matches", which are answers, never failures — and 2 for a usage error
// (no query). An empty archive must not break a script that composes recall into
// a pre-flight, and it must not read as success by saying nothing.
//
// `--digest` is the other mode: print the bounded run-start digest — the EXACT
// block the SDK driver seeds into a run's first lead, from the same digestOf()
// builder, byte-identical. It exists so the in-session engine (the /leopold-run
// skill) reads the same memory the driver seeds: one flag, one builder, never two.
// With no archived decisions, stdout stays byte-empty (exactly what the driver
// seeds: nothing) and stderr says so — never a silent empty exit.

import path from "node:path";
import { findLeoDir } from "./config.js";
import { searchRuns, renderRecall, digestOf, PAST_RUN_DATA_AUTHORITY } from "./recall.js";

const DEFAULT_LIMIT = 8;

/** Split argv into the query words and the flags recall understands. `--provider`
 *  is global (index.ts resolves it before dispatch) so its value must not leak
 *  into the query; any other unknown flag is a usage error, said out loud. */
function parseArgs(argv: string[]): { words: string[]; json: boolean; limit: number; digest: boolean } {
  const words: string[] = [];
  let json = false;
  let limit = DEFAULT_LIMIT;
  let digest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { json = true; continue; }
    if (a === "--digest") { digest = true; continue; }
    if (a === "--limit") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error("--limit needs a positive integer.");
      limit = v;
      continue;
    }
    if (a === "--provider") { i++; continue; }
    if (a.startsWith("-")) throw new Error(`unknown flag "${a}". Usage: leopold recall <query> [--json] [--limit N] | leopold recall --digest`);
    words.push(a);
  }
  // --digest is a mode, not a filter: it prints THE block the driver seeds, so a
  // query, --json or --limit beside it would promise a shaping it must never do.
  if (digest && (words.length > 0 || json || limit !== DEFAULT_LIMIT)) {
    throw new Error("--digest takes no query and no other flags. Usage: leopold recall --digest");
  }
  return { words, json, limit, digest };
}

/** `leopold recall <query> [--json] [--limit N]` | `leopold recall --digest`. */
export function runRecallCommand(cwd: string, argv: string[]): number {
  let words: string[], json: boolean, limit: number, digest: boolean;
  try {
    ({ words, json, limit, digest } = parseArgs(argv));
  } catch (err) {
    console.error(`leopold recall: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (!digest && words.length === 0) {
    console.error("leopold recall: what should I look for? Usage: leopold recall <query> [--json] [--limit N] | leopold recall --digest");
    return 2;
  }

  // No `.leopold/` anywhere up-tree is the same answer as an empty runs dir: this
  // project has no archive yet. searchRuns types that result; a missing brief only
  // means the runs dir cannot exist either.
  let runsDir: string | null = null;
  try {
    runsDir = path.join(findLeoDir(cwd), "runs");
  } catch {
    runsDir = null;
  }

  if (digest) {
    // The SAME builder the driver's run start calls — stdout is byte-identical to
    // the block it seeds (digestOf carries its own untrusted-data framing header).
    const block = runsDir ? digestOf(runsDir) : "";
    if (block === "") {
      // The driver seeds nothing here, so stdout stays byte-empty to match — but
      // an empty exit that reads as success is the failure mode, so stderr says it.
      console.error("leopold recall: no archived decisions yet — the run starts without a digest, exactly as a fresh project does.");
      return 0;
    }
    process.stdout.write(`${block}\n`);
    return 0;
  }

  const query = words.join(" ");
  const result = runsDir
    ? searchRuns(runsDir, query, limit)
    : { status: "no_archive" as const, runsSearched: 0, hits: [], warnings: [] };

  if (json) {
    console.log(JSON.stringify(
      { data_authority: PAST_RUN_DATA_AUTHORITY, query, ...result },
      null,
      2,
    ));
    return 0;
  }

  // First line: the framing. Everything under it is archive text or derived from
  // it, and whoever pastes this into a prompt carries the sentence along.
  console.log(PAST_RUN_DATA_AUTHORITY);
  console.log("");
  process.stdout.write(renderRecall(result, query));
  return 0;
}
