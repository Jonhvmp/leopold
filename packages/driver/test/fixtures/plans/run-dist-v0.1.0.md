# Plan

## npm — leopold-driver
- [x] Rename the driver package to `leopold-driver` (unscoped) in package.json; add `files` allowlist (dist, README), `prepublishOnly` build, `engines`, and `bin` with a shebang in the built entry.
- [x] Add a package-level README for npm and verify `npm pack` yields a clean tarball (no src/node_modules leakage).
- [x] Document `npm i -g leopold-driver` for the driver in the root README and docs.

## Claude Code plugin
- [x] Research the current Claude Code plugin spec and the official marketplace submission process (use /find-docs or the claude-code-guide; do not guess the schema).
- [x] Add `.claude-plugin/plugin.json` (name, version, description, author, license) and a `hooks/hooks.json` wiring the Stop + PreToolUse hooks; expose the four leopold skills.
- [x] Validate the plugin structure; add a plugin install section to README/docs.
- [x] Prepare official-marketplace submission materials: the marketplace entry metadata and a ready PR description/checklist (do NOT open the PR).

## Release
- [x] Add a `VERSION` file (0.1.0), finalize the CHANGELOG `0.1.0` section, and draft GitHub Release notes from it.

## Wrap-up
- [x] Update README/docs so all three install paths (curl, npm, plugin) are clear; verify with `make test` + `npm pack`.
- [x] Write a final report listing the exact human commands left (npm publish, marketplace PR, git tag + Release).
