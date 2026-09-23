// The `decisions/1.0` contract, held to its own rules.
//
// Two things are proven here, and the second is the one that matters long-term:
//   1. The validator REFUSES each malformed catalog BY NAME — the error points at the
//      question id to fix, not at the file. Four fixtures, one per failure the contract
//      promises to catch, plus the provider-limit case that needs a descriptor.
//   2. The JSON Schema is DERIVED from the same constants the validator uses, and the
//      copy on disk (the one the bash seam will validate against with jq) is byte-equal to
//      what `catalogJsonSchema()` produces. Edit one side and this fails — which is the
//      whole point: the driver and the shell must never disagree about what is legal.
//
// MUTATION-VERIFIED: widen SCORE_LEVELS.max to 12 and the score-levels case fails;
// drop the orphan-threshold loop from validateCatalog and that case fails; change one
// value in catalog.schema.json and the derived-schema case fails naming it.
//
// HERMETIC: reads fixtures from this directory, shells out to `jq` for the schema check.
// No network, no home directory, no writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  CHOICE_MAX_OPTIONS,
  CONTRACT_VERSION,
  QUESTION_TYPES,
  SCORE_LEVELS,
  calibrationLabel,
  catalogJsonSchema,
  validateCatalog,
  validateProvider,
  type Catalog,
  type ProviderDescriptor,
} from "../src/decisions/contract.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "decisions");
const SCHEMA_FILE = path.join(import.meta.dirname, "..", "src", "decisions", "catalog.schema.json");

const load = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));

/** Every error mentioning the offending id, joined — assertions read against this. */
const why = (errors: string[]): string => errors.join(" | ");

test("a valid catalog validates with no errors", () => {
  const r = validateCatalog(load("valid"));
  assert.deepEqual(r.errors, [], why(r.errors));
  assert.equal(r.ok, true);
});

test("an unknown question type is refused, naming the id and the legal types", () => {
  const r = validateCatalog(load("unknown-type"));
  assert.equal(r.ok, false);
  const m = why(r.errors);
  assert.match(m, /"shortlist"/, "the offending question id is not named");
  assert.match(m, /unknown type "ranking"/);
  for (const t of QUESTION_TYPES) assert.match(m, new RegExp(`"${t}"`), `legal type ${t} is not offered`);
});

test("a threshold block for a question that does not exist is refused as an orphan", () => {
  const r = validateCatalog(load("orphan-threshold"));
  assert.equal(r.ok, false);
  const m = why(r.errors);
  assert.match(m, /"frustration" is an orphan/);
  assert.doesNotMatch(m, /"is_urgent" is an orphan/, "the legitimate question was flagged too");
});

test("a score outside the 2-10 level bound is refused, naming the bound", () => {
  const r = validateCatalog(load("score-levels"));
  assert.equal(r.ok, false);
  const m = why(r.errors);
  assert.match(m, /"severity"/);
  assert.match(m, new RegExp(`${SCORE_LEVELS.min}-${SCORE_LEVELS.max} levels, got 12`));
});

test("a question with no threshold block is refused, naming the question", () => {
  const r = validateCatalog(load("missing-threshold"));
  assert.equal(r.ok, false);
  assert.match(why(r.errors), /"is_spam": has no threshold block/);
});

test("a choice over the provider's declared max_options is refused, naming the provider", () => {
  const options: Record<string, null> = {};
  for (let i = 0; i < 40; i++) options[`opt_${i}`] = null;
  const catalog: Catalog = {
    version: CONTRACT_VERSION,
    questions: { wide: { type: "choice", instructions: "pick one", criteria: options } },
    thresholds: { wide: { floor: 0.5, escalate: 0.65, act: 0.85 } },
  };
  const small: ProviderDescriptor = {
    name: "tiny-local",
    endpoint: "http://127.0.0.1:9/v1/systemone",
    model: "tiny-0.1.0",
    calibrated: false,
    auth_env: "TINY_API_KEY",
    timeout_ms: 2000,
    max_options: 20,
    max_state_tokens: 512,
  };
  assert.deepEqual(validateCatalog(catalog).errors, [], "40 options is legal without a provider");
  const r = validateCatalog(catalog, small);
  assert.equal(r.ok, false);
  assert.match(why(r.errors), /40 options exceeds the 20 allowed by provider "tiny-local"/);
});

test("thresholds must be ordered floor <= escalate <= act", () => {
  const catalog = {
    version: CONTRACT_VERSION,
    questions: { q: { type: "noul", instructions: "true?" } },
    thresholds: { q: { floor: 0.9, escalate: 0.5, act: 0.7 } },
  };
  assert.match(why(validateCatalog(catalog).errors), /expected floor <= escalate <= act/);
});

test("a provider pinned to a moving alias is refused", () => {
  const p: ProviderDescriptor = {
    name: "jev",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    calibrated: true,
    auth_env: "TYPESAFE_API_KEY",
    timeout_ms: 2000,
    max_options: 255,
    max_state_tokens: 32000,
  };
  const r = validateProvider(p);
  assert.equal(r.ok, false);
  assert.match(why(r.errors), /moving alias/);
  assert.deepEqual(validateProvider({ ...p, model: "jev-1.13.0" }).errors, []);
});

test("the JSON Schema is derived from the contract's own constants", () => {
  const s = catalogJsonSchema();
  const questions = (s.properties as Record<string, Record<string, unknown>>).questions;
  const perQuestion = questions.additionalProperties as Record<string, unknown>;
  const typeEnum = ((perQuestion.properties as Record<string, Record<string, unknown>>).type as { enum: string[] }).enum;
  assert.deepEqual(typeEnum, [...QUESTION_TYPES], "the schema's type enum drifted from QUESTION_TYPES");

  const branches = perQuestion.allOf as Array<Record<string, Record<string, unknown>>>;
  const find = (kind: string) =>
    branches.find(
      (b) =>
        ((b.if.properties as Record<string, { const: string }>).type ?? { const: "" }).const === kind,
    )!;
  const score = (find("score").then.properties as Record<string, { minItems: number; maxItems: number }>).criteria;
  assert.equal(score.minItems, SCORE_LEVELS.min);
  assert.equal(score.maxItems, SCORE_LEVELS.max);
  const choice = (find("choice").then.properties as Record<string, { maxProperties: number }>).criteria;
  assert.equal(choice.maxProperties, CHOICE_MAX_OPTIONS);
  assert.equal((((s.properties as Record<string, { const: string }>).version)).const, CONTRACT_VERSION);
});

test("the schema on disk — what the bash seam validates against — matches the generated one", () => {
  assert.ok(fs.existsSync(SCHEMA_FILE), `${SCHEMA_FILE} is missing; regenerate it from catalogJsonSchema()`);
  const onDisk: unknown = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
  assert.deepEqual(
    onDisk,
    catalogJsonSchema(),
    "src/decisions/catalog.schema.json drifted from catalogJsonSchema() — regenerate it",
  );
});

test("jq validates the same fixtures against the same schema, and agrees with the validator", () => {
  // The bash seam has no JSON Schema library — it has jq. This runs the schema's load-bearing
  // constraints as a jq filter that reads every bound FROM the schema file rather than
  // retyping it, and asserts jq reaches the same verdict the TypeScript validator did. When
  // item 8 builds the shell seam it uses this filter; the two engines are already agreed here.
  const filter = `
. as $s | $cat[0] as $c
| ($s.properties.questions.additionalProperties.properties.type.enum) as $types
| ($s.properties.questions.additionalProperties.allOf[1].then.properties.criteria) as $lv
| [ (if $c.version == $s.properties.version.const then empty else "version" end),
    ( $c.questions // {} | to_entries[] as $e
      | select(($types | index($e.value.type // "")) == null) | "type:" + $e.key ),
    ( $c.questions // {} | to_entries[] as $e
      | select($e.value.type == "score")
      | select(($e.value.criteria | length) < $lv.minItems or ($e.value.criteria | length) > $lv.maxItems)
      | "levels:" + $e.key ),
    ( ($c.thresholds // {} | keys_unsorted[]) as $k | select(($c.questions // {} | has($k)) | not) | "orphan:" + $k ),
    ( ($c.questions // {} | keys_unsorted[]) as $k | select(($c.thresholds // {} | has($k)) | not) | "nothreshold:" + $k )
  ] | join(",")`;

  // The filter goes in argv, NOT through `-f /dev/stdin`. Under `execFileSync` the child's stdin
  // is a pipe, and on Linux jq cannot open /dev/stdin from there — "No such device or address".
  // It works on macOS, so only the ubuntu leg of the driver matrix caught it.
  const run = (fixture: string): string =>
    execFileSync("jq", ["-r", "--slurpfile", "cat", path.join(FIX, `${fixture}.json`), filter, SCHEMA_FILE], {
      encoding: "utf8",
    }).trim();

  assert.equal(run("valid"), "", "jq rejected the catalog the validator accepted");
  assert.equal(run("unknown-type"), "type:shortlist");
  assert.equal(run("score-levels"), "levels:severity");
  assert.equal(run("orphan-threshold"), "orphan:frustration");
  assert.equal(run("missing-threshold"), "nothreshold:is_spam");
});

test("the shipped provider templates on disk match the descriptors they are generated from", async () => {
  // `extensions/decisions/install.sh` reads this file to offer providers; it cannot import
  // TypeScript. Pinning it here is what stops the installer's copy of `jev-1.13.0` from drifting
  // away from the one the driver actually calls.
  const { providerTemplates } = await import("../src/decisions/contract.ts");
  const { JEV_DESCRIPTOR } = await import("../src/decisions/providers/jev.ts");
  const { OPENROUTER_DESCRIPTOR } = await import("../src/decisions/providers/openrouter.ts");
  const { VERCEL_DESCRIPTOR } = await import("../src/decisions/providers/vercel.ts");
  const { GENERIC_DESCRIPTOR } = await import("../src/decisions/providers/generic.ts");
  const file = path.join(import.meta.dirname, "..", "src", "decisions", "providers.json");
  assert.ok(fs.existsSync(file), `${file} is missing; regenerate it from providerTemplates()`);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, "utf8")),
    providerTemplates([JEV_DESCRIPTOR, OPENROUTER_DESCRIPTOR, VERCEL_DESCRIPTOR, GENERIC_DESCRIPTOR]),
    "src/decisions/providers.json drifted from the descriptors — regenerate it",
  );
});

test("the shell's calibration label says exactly what the driver's does, in all three states", () => {
  // Two surfaces read this sentence — `leopold doctor` and the extension's `status` — and both
  // go through `leo_calibration_label` in extensions/lib/harness.sh. The caveat on an
  // operator-declared claim is the whole point of the wording, so it is DERIVED here rather
  // than retyped: the shell function is run and compared to `calibrationLabel()`.
  const lib = path.join(import.meta.dirname, "..", "..", "..", "extensions", "lib", "harness.sh");
  const shell = (calibrated: string, source: string): string =>
    execFileSync("bash", ["-c", `. "${lib}"; leo_calibration_label "${calibrated}" "${source}"`], {
      encoding: "utf8",
    });

  const cases: Array<[boolean, "trained" | "operator-declared" | undefined]> = [
    [true, "trained"],
    [true, "operator-declared"],
    [false, undefined],
    [true, undefined],
  ];
  for (const [calibrated, source] of cases) {
    assert.equal(
      shell(String(calibrated), source ?? ""),
      calibrationLabel({ calibrated, calibration_source: source }),
      `the shell and the driver disagree for calibrated=${calibrated} source=${source ?? "(none)"}`,
    );
  }
});
