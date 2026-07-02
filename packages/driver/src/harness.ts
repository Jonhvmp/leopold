// Harness commands for the leopold-driver CLI: install / menu / watch / extensions /
// doctor / update. They run the bundled harness assets (skills, hooks, installer,
// extensions) that `npm run build` vendors into ../assets, so everything works from the
// npm package alone — no repo clone, no `make`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Locate the vendored harness root (assets/ in the package, or the repo root in dev). */
export function assetRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "..", "assets");
  if (existsSync(join(bundled, "install.sh"))) return bundled;
  let dir = here; // dev: walk up to the repo root (has install.sh + skills/)
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "install.sh")) && existsSync(join(dir, "skills"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return bundled;
}

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    const hint = e.code === "ENOENT" ? ` (is "${cmd}" installed and on PATH?)` : "";
    console.error(`leopold-driver: could not run ${cmd}${hint}: ${e.message}`);
    return 1;
  }
  return r.status ?? 0;
}

export function runInstall(args: string[]): number {
  return run("bash", [join(assetRoot(), "install.sh"), ...args]);
}

/** One-shot project setup: install the harness, seed a sane permissions allowlist,
 *  and point at the in-session /leopold-up skill for the rest (CLAUDE.md, run-skill). */
export function runUp(args: string[]): number {
  const script = join(assetRoot(), "scripts", "leopold-up.sh");
  if (!existsSync(script)) return runInstall(args); // fallback: at least install
  return run("bash", [script, ...args]);
}

export function runMenu(): number {
  return run("bash", [join(assetRoot(), "scripts", "leopold-menu.sh")]);
}

export function runWatch(args: string[]): number {
  const script = join(assetRoot(), "scripts", "leopold-watch.py");
  if (!existsSync(script)) {
    console.error("leopold-driver watch: dashboard script (leopold-watch.py) not found.");
    return 1;
  }
  const py = process.env.LEOPOLD_PYTHON ?? "python3";
  return run(py, [script, "--project", process.cwd(), ...args]);
}

export function runExt(name: string, args: string[]): number {
  const mgr = join(assetRoot(), "extensions", name, "manage.sh");
  if (!existsSync(mgr)) {
    console.error(`leopold-driver: unknown extension "${name}". Try: serena, gstack, ovmem.`);
    return 2;
  }
  return run("bash", [mgr, ...(args.length ? args : ["status"])]);
}

export function runDoctor(): number {
  const extDir = join(assetRoot(), "extensions");
  let rc = 0;
  for (const name of existsSync(extDir) ? readdirSync(extDir) : []) {
    if (!existsSync(join(extDir, name, "manage.sh"))) continue;
    process.stdout.write(`\n[${name}]\n`);
    const r = run("bash", [join(extDir, name, "manage.sh"), "doctor"]);
    if (r !== 0) rc = r;
  }
  return rc;
}
