// `leopold-driver watch` — launch the local live dashboard for the run in the cwd.
//
// The dashboard itself is the zero-dependency Python server (`leopold-watch.py`),
// bundled into this package's dist/ at build time. This subcommand just locates it
// and spawns `python3` on it, forwarding any extra flags (e.g. --port). It needs
// Python 3 on PATH — the same requirement as the dashboard everywhere else.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findScript(): string | null {
  // Walk up from this module: covers the published layout (dist/leopold-watch.py,
  // copied by `npm run build`) and the repo dev layout (<repo>/scripts/leopold-watch.py).
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const bundled = join(dir, "leopold-watch.py");
    if (existsSync(bundled)) return bundled;
    const inRepo = join(dir, "scripts", "leopold-watch.py");
    if (existsSync(inRepo)) return inRepo;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function runWatch(args: string[]): void {
  const script = findScript();
  if (!script) {
    console.error(
      "leopold-driver watch: dashboard script (leopold-watch.py) not found in the package.",
    );
    process.exit(1);
  }
  const py = process.env.LEOPOLD_PYTHON ?? "python3";
  const child = spawn(py, [script, "--project", process.cwd(), ...args], {
    stdio: "inherit",
  });
  child.on("error", (e: NodeJS.ErrnoException) => {
    const hint = e.code === "ENOENT" ? " (is Python 3 installed and on PATH?)" : "";
    console.error(`leopold-driver watch: could not run "${py}"${hint}: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
