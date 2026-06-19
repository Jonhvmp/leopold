#!/usr/bin/env node
// leopold-driver: Leopold from npm. Install + manage the harness, conduct runs, and
// watch — without cloning the repo or running `make`. The harness assets are bundled
// into the package at build time; subcommands run them.

import { runDriver } from "./loop.js";
import { runInstall, runMenu, runWatch, runExt, runDoctor } from "./harness.js";

const sub = process.argv[2];
const rest = process.argv.slice(3);

function help(): void {
  process.stdout.write(`leopold-driver — Leopold from npm. Manage the harness, conduct runs, watch.

Usage:
  leopold-driver install [--with-gstack]   install skills + hooks into ~/.claude
  leopold-driver menu                       toolchain manager (serena / gstack / ovmem)
  leopold-driver watch [--port N]           live dashboard (http://127.0.0.1:4179)
  leopold-driver serena [install|doctor]    manage an extension (also: gstack, ovmem)
  leopold-driver doctor                     run every extension's doctor
  leopold-driver update                     reinstall from this package
  leopold-driver run [--dry-run]            conduct the .leopold run (the SDK driver)

Most commands run the bundled harness — no repo clone, no make. 'watch' needs Python 3.
Newer version: npm i -g leopold-driver@latest.

Conducting a run uses your existing Claude Code login (ANTHROPIC_API_KEY only in headless).
Env: LEOPOLD_CONDUCTOR_MODEL, LEOPOLD_WORKER_MODEL, LEOPOLD_MAX_TURNS_PER_ITEM, LEOPOLD_WEBHOOK
`);
}

function conduct(): void {
  runDriver(process.cwd(), process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("leopold-driver error:", msg);
    process.exit(1);
  });
}

switch (sub) {
  case "install":
  case "update":
    process.exit(runInstall(rest));
  case "menu":
    process.exit(runMenu());
  case "watch":
  case "watch-web":
    process.exit(runWatch(rest));
  case "serena":
  case "gstack":
  case "ovmem":
    process.exit(runExt(sub, rest));
  case "doctor":
    process.exit(runDoctor());
  case "--help":
  case "-h":
  case "help":
    help();
    process.exit(0);
  default:
    if (sub && sub !== "run" && !sub.startsWith("-")) {
      console.error(`leopold-driver: unknown command "${sub}". Try: leopold-driver --help`);
      process.exit(2);
    }
    conduct();
}
