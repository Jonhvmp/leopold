// The lexical contract gate, pure. Decides whether a persona contract may
// reach a worker WITHOUT ever parsing the contract YAML semantically —
// contracts are model-facing text owned by the vendored skills
// (persona-contract-builder writes them, persona-contract-runtime consumes
// them). The driver only checks presence and extracts three header fields by
// line-anchored matching: `schema_version`, `persona_id`, `contract_status`.
//
// The verdicts, in check order:
//   - an unsupported `schema_version` is refused, naming the version found and
//     the one supported;
//   - a `persona_id` that mismatches the directory the contract lives in is an
//     error naming both ids — a contract filed under the wrong persona must
//     never enact as that persona;
//   - `ready` passes; `draft` and `blocked` are skipped, the skip naming the
//     status (the builder's own vocabulary — see its SKILL.md), and a skip is
//     data, not a failure of the run;
//   - anything else — a missing field, an unknown status — is a loud error.
//
// Pure and byte-deterministic: same text in, same result out. No IO, no
// wall-clock, no silent repair.

/** The one contract schema this driver conducts. The vendored runtime skill
 *  declares the same string (`accepts-contract`); they must move together. */
export const SUPPORTED_CONTRACT_SCHEMA = "persona-contract/1.0";

/** The builder's terminal statuses. `ready` enacts; the others are reported
 *  and skipped. Any other spelling is an error, never guessed at. */
export const SKIPPED_STATUSES = ["draft", "blocked"] as const;
export type SkippedStatus = (typeof SKIPPED_STATUSES)[number];

export type ContractCheckResult =
  /** Enactable: the only verdict that lets a contract reach a worker. */
  | { status: "ready"; personaId: string }
  /** Not enactable by the builder's own verdict. Reported, never failed on:
   *  other personas in the cast still run and the exit stays 0. */
  | { status: "skipped"; contractStatus: SkippedStatus; reason: string }
  /** Unusable: refused loudly with a reason naming what was found. */
  | { status: "error"; reason: string };

// -- Lexical field extraction ------------------------------------------------

/** First line-anchored `key: value` occurrence of a top-of-contract field,
 *  quotes stripped. Lexical only: no YAML nesting, anchors, or semantics —
 *  the header fields the builder emits are plain `key: "value"` lines. */
function fieldValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(text);
  if (m === null) return undefined;
  return m[1].replace(/^["']|["']$/g, "");
}

// -- The gate (pure) ---------------------------------------------------------

/** Gate one contract's full text against the directory it was found in
 *  (`personas/<personaDir>/contract.yaml`). Pure and deterministic; the
 *  conductor reads the file and enacts only a `ready` verdict. */
export function checkContract(text: string, personaDir: string): ContractCheckResult {
  const missing = ["schema_version", "persona_id", "contract_status"].filter(
    (key) => fieldValue(text, key) === undefined,
  );
  if (missing.length > 0)
    return { status: "error", reason: `contract is missing required field(s): ${missing.join(", ")}` };

  const schemaVersion = fieldValue(text, "schema_version")!;
  if (schemaVersion !== SUPPORTED_CONTRACT_SCHEMA)
    return {
      status: "error",
      reason: `unsupported schema_version "${schemaVersion}" — this driver supports "${SUPPORTED_CONTRACT_SCHEMA}"`,
    };

  const personaId = fieldValue(text, "persona_id")!;
  if (personaId !== personaDir)
    return {
      status: "error",
      reason: `persona_id "${personaId}" does not match its directory "personas/${personaDir}/" — a contract filed under the wrong persona never runs`,
    };

  const contractStatus = fieldValue(text, "contract_status")!;
  if (contractStatus === "ready") return { status: "ready", personaId };
  if ((SKIPPED_STATUSES as readonly string[]).includes(contractStatus))
    return {
      status: "skipped",
      contractStatus: contractStatus as SkippedStatus,
      reason: `contract_status is "${contractStatus}" — persona "${personaId}" skipped, not enacted`,
    };
  return {
    status: "error",
    reason: `unknown contract_status "${contractStatus}" — expected "ready", "draft" or "blocked"`,
  };
}
