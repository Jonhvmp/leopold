// Consumer 3: triage classification — and the property the provider must not be allowed to erode.
//
// The typed classifier is a real strengthening of the quarantine: a constrained answer space has
// no channel for prose, for a tool request, or for an action. It is NOT a reason to merge the
// stages, because a decision model treats its state as data rather than as hostile, so a hostile
// issue body can still push a classification WITHIN the enum. This suite pins BOTH halves of that
// sentence in the skill, so a future edit cannot add the provider path while quietly dropping the
// rule it does not replace.
//
// MUTATION-VERIFIED: delete the "Do not optimize this away" sentence from SKILL.md and the first
// case fails; make the triage catalog's `kind` a noul and the validation case fails.
//
// HERMETIC: reads two files in the checkout. No network, no key, no writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_DESCRIPTOR, validateCatalog, type Catalog } from "../src/decisions/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL = path.join(REPO, "skills", "leopold-triage", "SKILL.md");
const CATALOG = path.join(REPO, "templates", "decisions", "triage.json");

test("the skill keeps the stage-separation rule AND explains what typed output does not fix", () => {
  const text = fs.readFileSync(SKILL, "utf8");
  // The original rule survives.
  assert.match(text, /no repo\s*\naccess/, "the classifier agents' lack of repo access is no longer stated");
  assert.match(text, /Do not "optimize" this away by merging the stages\./, "the merge prohibition was dropped");
  // And the new paragraph says why a typed classifier is not a licence to merge them.
  assert.match(text, /narrows the blast radius; it does not remove it/);
  assert.match(text, /within the enum/, "the residual risk is not named");
  assert.match(text, /It is NOT a reason to merge the stages\./);
  assert.match(text, /below its confidence\s*\nfloor goes to human review/, "the floor-to-human rule is missing");
});

test("the shipped triage catalog is valid and asks for the fields the report needs", () => {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")) as Catalog;
  const r = validateCatalog(catalog, JEV_DESCRIPTOR);
  assert.deepEqual(r.errors, [], r.errors.join(" | "));
  assert.deepEqual(Object.keys(catalog.questions).sort(), ["kind", "needs_repro", "severity"]);
  assert.equal(catalog.questions.kind.type, "choice");
  assert.equal(catalog.questions.severity.type, "score");
  assert.equal(catalog.questions.needs_repro.type, "noul");
});

test("every triage question tells the model its state is untrusted content, not instructions", () => {
  // The classifier reads text an outsider wrote. Saying so inside the question is the cheapest
  // half of the defence; the stage separation is the half that actually bounds the damage.
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")) as Catalog;
  const framed = Object.entries(catalog.questions).filter(([, q]) =>
    JSON.stringify(q.instructions).toLowerCase().includes("untrusted"),
  );
  assert.ok(
    framed.length >= 2,
    `expected the untrusted framing on the questions that read the issue body, got ${framed.length}`,
  );
});

test("a `noise` outcome exists, so an unclassifiable item is not forced into a real category", () => {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")) as Catalog;
  const kind = catalog.questions.kind;
  assert.equal(kind.type, "choice");
  assert.ok("noise" in (kind as { criteria: Record<string, unknown> }).criteria);
});

test("every shipped catalog validates — including the one only a hook reads", () => {
  // `permission.json` is loaded at runtime by hooks/permission-policy.sh, whose suite uses its own
  // inline fixture. Without this, the one catalog that can deny a command would be the only one
  // the gate never parses.
  const dir = path.join(REPO, "templates", "decisions");
  const shipped = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(shipped, ["permission.json", "review.json", "routing.json", "triage.json"]);
  for (const name of shipped) {
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Catalog;
    const r = validateCatalog(catalog, JEV_DESCRIPTOR);
    assert.deepEqual(r.errors, [], `${name}: ${r.errors.join(" | ")}`);
  }
});
