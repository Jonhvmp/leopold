// Build step: vendor the harness runtime (installer, skills, hooks, templates, scripts,
// extensions) into packages/driver/assets/ so the published npm package is self-contained.
// That lets `leopold-driver install | menu | watch | serena | doctor` run without a repo
// clone. Runs after tsc; assets/ is gitignored (regenerated on every build / publish).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));      // packages/driver/scripts
const repo = join(here, "..", "..", "..");                // repo root
const assets = join(here, "..", "assets");                // packages/driver/assets

const FILES = ["install.sh", "settings.template.json", "VERSION"];
const DIRS = ["skills", "hooks", "templates", "scripts", "extensions"];

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
console.log("copy-runtime: vendored harness -> assets/ (install.sh, skills, hooks, templates, scripts, extensions)");
