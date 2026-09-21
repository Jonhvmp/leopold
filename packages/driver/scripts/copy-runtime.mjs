// Build step: vendor the harness runtime (installer, skills, hooks, templates, scripts,
// extensions, docs) into packages/driver/assets/ so the published npm package is
// self-contained. That lets `leopold-driver install | menu | watch | serena | doctor`
// run without a repo clone. Runs after tsc; assets/ is gitignored (regenerated on every
// build / publish).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));      // packages/driver/scripts
const repo = join(here, "..", "..", "..");                // repo root
const assets = join(here, "..", "assets");                // packages/driver/assets

const FILES = ["install.sh", "settings.template.json", "VERSION"];
// `docs` is runtime, not documentation-for-its-own-sake: hooks/hook-matrix.tsv cites a
// section of docs/reference/hook-events.md as the evidence for every capability it
// claims, and `leopold doctor` resolves those anchors against the INSTALLED page to
// report a bound as `verified` rather than merely `wired`. npm is the fastest install
// path (docs/getting-started/install.md), and install.sh copies docs out of this tree —
// so leaving it out here made `verified` unreachable for every npm user, and turned a
// correctly armed git lock into a warning whose remedy could not fix it.
const DIRS = ["skills", "hooks", "templates", "scripts", "extensions", "docs"];

for (const f of [...FILES, ...DIRS]) {
  if (!existsSync(join(repo, f))) {
    console.error(`copy-runtime: missing ${f} in repo root (${repo})`);
    process.exit(1);
  }
}

rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
for (const f of FILES) cpSync(join(repo, f), join(assets, f));
for (const d of DIRS) cpSync(join(repo, d), join(assets, d), { recursive: true });
console.log(`copy-runtime: vendored harness -> assets/ (${[...FILES, ...DIRS].join(", ")})`);
