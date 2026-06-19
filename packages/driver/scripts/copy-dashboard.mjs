// Build step: copy the zero-dependency Python dashboard into dist/ so the published
// npm package ships it and `leopold-driver watch` can spawn it. Run after tsc.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));        // packages/driver/scripts
const src = join(here, "..", "..", "..", "scripts", "leopold-watch.py"); // repo/scripts
const distDir = join(here, "..", "dist");
const dest = join(distDir, "leopold-watch.py");

if (!existsSync(src)) {
  console.error(`copy-dashboard: source not found: ${src}`);
  process.exit(1);
}
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
copyFileSync(src, dest);
console.log("copy-dashboard: leopold-watch.py -> dist/");
