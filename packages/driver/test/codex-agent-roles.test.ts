// Parity: the Codex agent roles the INSTALLER writes vs the lenses the DRIVER defines.
//
// A review lens exists twice by necessity — as `REVIEW_LENSES` in src/review.ts, which
// builds the panelist's system prompt, and as a lens spec in extensions/lib/harness.sh,
// which an installer (bash, no TypeScript in sight) renders into
// `$CODEX_HOME/agents/leopold-lens-<lens>.toml`. Two copies drift. So this suite RUNS
// the shell writer — never a re-implementation of it — and asserts every field of every
// file it produces against the driver's array. Edit a focus in review.ts and forget the
// writer, and this fails by name.
//
// It also pins the two facts the probe established about Codex 0.152.1 roles
// (docs/reference/hook-events.md, "#subagentstart-codex-cli"):
//   - ONE unknown key makes Codex ignore the whole role file, so the writer may emit
//     only keys the capture proved are accepted;
//   - `codex exec` cannot run AS a role, so what keeps a headless lens read-only is
//     `--sandbox read-only`, asserted here on the argv a review query actually builds.
//
// Mutation-verified (recorded in .leopold/DECISIONS.md): a lens focus edited in
// review.ts, a lens dropped from the shell spec list, `sandbox_mode` removed from the
// writer, and the role override removed from buildArgv — each one fails cases here.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REVIEW_LENSES, lensRole } from "../src/review.ts";
import { buildArgv, isReadOnly, lensRoleArgs, codexAgentsDir } from "../src/providers/codex.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const LIB = path.join(REPO, "extensions", "lib", "harness.sh");

const NO_BASH = spawnSync("bash", ["-c", "true"]).error ? "bash is not available" : undefined;

/** Run the shell writer into a fresh CODEX_HOME and return that home. */
function installRoles(env: Record<string, string> = {}, times = 1): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "leo-roles-"));
  const script = `
set -euo pipefail
. ${JSON.stringify(LIB)}
specs=()
while IFS= read -r spec; do [ -n "$spec" ] && specs+=("$spec"); done < <(leo_review_lens_specs)
for _ in $(seq 1 ${times}); do
  leo_write_codex_agent_roles ${JSON.stringify(home)} "\${specs[@]}" >/dev/null
done
printf '%s %s\\n' "\${LEO_ROLES_TOTAL:-0}" "\${LEO_ROLES_WRITTEN:-0}"
`;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    // Hermetic: never the developer's own ~/.codex, and no inherited model override.
    env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, ...env },
  });
  assert.equal(r.status, 0, `the role writer failed: ${r.stderr}`);
  return home;
}

/** The subset of TOML the writer emits: comments, and `key = <basic string | bare>`.
 *  Deliberately strict — anything else is a shape this test has not agreed to, and a
 *  silent skip is how a drifted file would pass. */
function parseRoleFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    assert.ok(m, `role file line is not a key = value: ${line}`);
    const key = m![1];
    const val = m![2].trim();
    if (val.startsWith('"')) {
      assert.ok(val.endsWith('"') && val.length >= 2, `unterminated string for ${key}`);
      out[key] = val
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Every key Codex 0.152.1 was live-verified to accept in a role file. An unknown key
 *  makes it ignore the file entirely, so this list is a hard bound, not a style rule. */
const ACCEPTED_KEYS = new Set(["name", "description", "developer_instructions", "sandbox_mode", "model"]);

test("the installer writes one role file per review lens, and only for the lenses that exist", { skip: NO_BASH }, () => {
  const home = installRoles();
  const dir = path.join(home, "agents");
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(
    files,
    REVIEW_LENSES.map((d) => `${d.role}.toml`).sort(),
    "the roles on disk are not exactly the driver's lenses",
  );
  // The item's acceptance list, spelled out, so a renamed lens cannot quietly pass.
  for (const stem of ["correctness", "security", "does-it-work", "conformance"]) {
    assert.ok(files.includes(`leopold-lens-${stem}.toml`), `missing role file for ${stem}`);
  }
});

test("every field of every role file matches REVIEW_LENSES", { skip: NO_BASH }, () => {
  const home = installRoles();
  for (const def of REVIEW_LENSES) {
    const file = path.join(home, "agents", `${def.role}.toml`);
    const t = parseRoleFile(fs.readFileSync(file, "utf8"));

    assert.equal(t.name, lensRole(def.lens), `${def.lens}: name`);
    assert.equal(t.description, def.description, `${def.lens}: description`);
    // The mutation this suite exists for: the lens text in review.ts IS the role's
    // developer_instructions, character for character.
    assert.equal(t.developer_instructions, def.focus, `${def.lens}: developer_instructions must be the driver's focus text`);
    assert.equal(t.sandbox_mode, def.readOnly ? "read-only" : undefined, `${def.lens}: sandbox_mode`);
    // No model key at all when the override env is unset: an absent key inherits the
    // harness default, while model = "" would pin the lens to a model named "".
    assert.equal(t.model, undefined, `${def.lens}: no model key without ${def.modelEnv}`);

    for (const k of Object.keys(t)) {
      assert.ok(ACCEPTED_KEYS.has(k), `${def.lens}: "${k}" is not a key Codex accepts — one unknown key makes it ignore the whole role file`);
    }
  }
});

test("the per-role model comes from the lens's own env key", { skip: NO_BASH }, () => {
  const key = REVIEW_LENSES[0].modelEnv;
  const home = installRoles({ [key]: "gpt-5.6-sol" });
  for (const def of REVIEW_LENSES) {
    const t = parseRoleFile(fs.readFileSync(path.join(home, "agents", `${def.role}.toml`), "utf8"));
    assert.equal(t.model, "gpt-5.6-sol", `${def.lens}: ${def.modelEnv} is the per-role model`);
  }
});

test("three installs leave one file per lens with unchanged bytes", { skip: NO_BASH }, () => {
  const once = installRoles({}, 1);
  const thrice = installRoles({}, 3);
  const dir = path.join(thrice, "agents");
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, REVIEW_LENSES.length, "a re-install must not add a second file");
  for (const def of REVIEW_LENSES) {
    assert.equal(
      fs.readFileSync(path.join(dir, `${def.role}.toml`), "utf8"),
      fs.readFileSync(path.join(once, "agents", `${def.role}.toml`), "utf8"),
      `${def.lens}: three writes changed the bytes`,
    );
  }
  // Idempotent means it did not even rewrite them: nothing to back up on runs 2 and 3.
  assert.equal(fs.existsSync(path.join(dir, `${REVIEW_LENSES[0].role}.toml.leopold.bak`)), false,
    "an unchanged role file was rewritten (a backup appeared on a no-op install)");
});

test("a changed role file is replaced and the previous one backed up", { skip: NO_BASH }, () => {
  const home = installRoles();
  const file = path.join(home, "agents", `${REVIEW_LENSES[0].role}.toml`);
  fs.writeFileSync(file, 'name = "hand-edited"\n');
  const script = `
set -euo pipefail
. ${JSON.stringify(LIB)}
specs=()
while IFS= read -r spec; do [ -n "$spec" ] && specs+=("$spec"); done < <(leo_review_lens_specs)
leo_write_codex_agent_roles ${JSON.stringify(home)} "\${specs[@]}" >/dev/null
`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(file, "utf8"), /name = "leopold-lens-correctness"/);
  assert.match(fs.readFileSync(`${file}.leopold.bak`, "utf8"), /hand-edited/);
});

test("a review query on the codex provider runs as the lens role, read-only", { skip: NO_BASH }, () => {
  const home = installRoles();
  // Exactly the options src/review.ts hands the seam for a lens.
  const options = {
    leopoldRole: "review",
    leopoldLens: "correctness",
    allowedTools: ["Bash", "Read", "Grep", "Glob", "Skill"],
    disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  };
  const env = { ...process.env, CODEX_HOME: home };
  const readOnly = isReadOnly(options);
  assert.equal(readOnly, true, "a review lens is a read-only session");
  const { role, roleFile } = lensRoleArgs(options.leopoldLens, env);
  const argv = buildArgv({ readOnly, role, roleFile });
  const s = argv.join(" ");

  assert.ok(s.includes("agents.leopold-lens-correctness.config_file="), `argv does not name the lens role: ${s}`);
  assert.ok(s.includes(path.join(home, "agents", "leopold-lens-correctness.toml")), "the role's own file is named");
  assert.ok(s.includes("--sandbox read-only"), "a lens session must stay read-only");
  // `codex exec` cannot run AS a role (probed), so nothing here may claim it does.
  for (const rejected of ["agent_role=", "agent_type=", " role=", "--profile"]) {
    assert.ok(!s.includes(rejected), `argv uses ${rejected}, which Codex rejects`);
  }
});

test("a lens with no role file installed names no role", { skip: NO_BASH }, () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "leo-noroles-"));
  const env = { ...process.env, CODEX_HOME: empty };
  assert.deepEqual(lensRoleArgs("correctness", env), {}, "a role Codex has never seen must not reach the argv");
  assert.deepEqual(lensRoleArgs("not-a-lens", env), {});
  assert.deepEqual(lensRoleArgs(undefined, env), {});
  assert.equal(codexAgentsDir(env), path.join(empty, "agents"));
  const argv = buildArgv({ readOnly: true, ...lensRoleArgs("correctness", env) });
  assert.ok(!argv.join(" ").includes("config_file"), "no role file, no role in the argv");
});
