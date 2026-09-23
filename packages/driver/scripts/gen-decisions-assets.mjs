// Regenerate the decisions module's DERIVED assets from the TypeScript that owns them.
//
// Two files, two consumers that cannot import TypeScript:
//   src/decisions/catalog.schema.json   the shell seam validates catalogs with it (jq)
//   src/decisions/providers.json        the extension installer offers providers from it
//
// Both are pinned to their source by tests in `decisions-contract.test.ts`, so a stale file is a
// red gate rather than a silent divergence. Run with tsx, because the sources use .js specifiers:
//
//     node --import tsx scripts/gen-decisions-assets.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "decisions");

const { catalogJsonSchema, providerTemplates } = await import(path.join(SRC, "contract.ts"));
const { JEV_DESCRIPTOR } = await import(path.join(SRC, "providers", "jev.ts"));
const { OPENROUTER_DESCRIPTOR } = await import(path.join(SRC, "providers", "openrouter.ts"));
const { VERCEL_DESCRIPTOR } = await import(path.join(SRC, "providers", "vercel.ts"));
const { GENERIC_DESCRIPTOR } = await import(path.join(SRC, "providers", "generic.ts"));

const write = (name, value) => {
  const file = path.join(SRC, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  console.log("wrote", path.relative(process.cwd(), file));
};

write("catalog.schema.json", catalogJsonSchema());
write(
  "providers.json",
  providerTemplates([JEV_DESCRIPTOR, OPENROUTER_DESCRIPTOR, VERCEL_DESCRIPTOR, GENERIC_DESCRIPTOR]),
);
