// Unit tests for the lexical contract gate (persona-testing/contract-check.ts).
// Pure core: no IO, no temp homes. The gate never parses the contract YAML
// semantically — these tests feed it real builder-shaped headers plus the
// exact failure shapes it must refuse loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_CONTRACT_SCHEMA,
  checkContract,
} from "../src/persona-testing/contract-check.ts";

/** A contract header in the shape persona-contract-builder emits. */
function contract(opts: { schema?: string; id?: string; status?: string } = {}): string {
  return `persona_contract:
  schema_version: "${opts.schema ?? SUPPORTED_CONTRACT_SCHEMA}"
  persona_id: "${opts.id ?? "ana"}"
  contract_status: "${opts.status ?? "ready"}"
  created_at: "2026-08-18"
  output_language: "en"

  scope:
    target: "the checkout flow"
`;
}

// @scenario a ready contract in personas/ana/ with persona_id "ana" → accepted
test('a ready contract whose persona_id matches its directory is accepted', () => {
  const result = checkContract(contract(), "ana");
  assert.deepEqual(result, { status: "ready", personaId: "ana" });
});

// @scenario contract_status draft → skipped, the skip names the status
test("a draft contract is skipped and the skip names the status", () => {
  const result = checkContract(contract({ status: "draft" }), "ana");
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") return;
  assert.equal(result.contractStatus, "draft");
  assert.match(result.reason, /"draft"/);
  assert.match(result.reason, /ana/);
});

test("a blocked contract is skipped and the skip names the status", () => {
  const result = checkContract(contract({ status: "blocked" }), "ana");
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") return;
  assert.equal(result.contractStatus, "blocked");
  assert.match(result.reason, /"blocked"/);
});

// @scenario persona_id "rafa" inside personas/ana/ → error naming both ids
test("a persona_id that mismatches its directory is an error naming both", () => {
  const result = checkContract(contract({ id: "rafa" }), "ana");
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.match(result.reason, /"rafa"/);
  assert.match(result.reason, /personas\/ana\//);
});

// @scenario an unsupported schema_version → refused naming the version found
// and the version supported
test("an unsupported schema_version is refused naming found and supported", () => {
  const result = checkContract(contract({ schema: "persona-contract/2.0" }), "ana");
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.match(result.reason, /"persona-contract\/2\.0"/);
  assert.match(result.reason, new RegExp(`"${SUPPORTED_CONTRACT_SCHEMA.replace("/", "\\/")}"`));
});

test("an unknown contract_status is an error, never guessed at", () => {
  const result = checkContract(contract({ status: "approved" }), "ana");
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.match(result.reason, /"approved"/);
});

test("missing header fields are an error naming every one of them", () => {
  const result = checkContract("persona_contract:\n  created_at: '2026-08-18'\n", "ana");
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  for (const key of ["schema_version", "persona_id", "contract_status"])
    assert.match(result.reason, new RegExp(key));
});

test("extraction is line-anchored: the first occurrence wins, quotes optional", () => {
  // Unquoted values (valid YAML) gate the same as quoted ones.
  const unquoted = `persona_contract:
  schema_version: ${SUPPORTED_CONTRACT_SCHEMA}
  persona_id: ana
  contract_status: ready
`;
  assert.deepEqual(checkContract(unquoted, "ana"), { status: "ready", personaId: "ana" });

  // A later prose mention of persona_id never overrides the header line.
  const withProse = contract() + `\n  notes: "the persona_id: someone-else story is prose"\n`;
  assert.deepEqual(checkContract(withProse, "ana"), { status: "ready", personaId: "ana" });
});

test("the gate is byte-deterministic", () => {
  const text = contract({ status: "draft" });
  assert.deepEqual(checkContract(text, "ana"), checkContract(text, "ana"));
});
