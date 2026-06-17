# Publishing Leopold

Leopold's autonomous run prepares and stages everything below. **These final steps
are gated human actions** — the run never publishes, pushes, tags, or opens
external PRs. Run them when you are ready.

## 1. npm — the SDK driver

```bash
cd packages/driver
npm login            # once
npm publish          # unscoped + public by default; prepublishOnly runs the build
```
Then users: `npm i -g leopold-driver`.

## 2. Claude Code plugin

### Available immediately (self-hosted marketplace)
The repo is its own marketplace via `.claude-plugin/marketplace.json`. Validate
locally, then it works for anyone:

```bash
claude plugin marketplace add .            # local validation
# users, once the repo is public:
claude plugin marketplace add Jonhvmp/leopold
claude plugin install leopold@leopold
```
Installing the plugin auto-wires the skills and hooks (no `settings.json` merge).
Use the plugin **or** `install.sh`, not both, to avoid double-wired hooks.

### Official marketplace (wider reach)
Submit to `anthropics/claude-plugins-official`:
1. Fork it, then add an entry to its `.claude-plugin/marketplace.json` `plugins`
   array. Match the `source` shape used by existing entries; for a plugin at our
   repo root it is roughly:
   ```json
   {
     "name": "leopold",
     "description": "An autonomous orchestration harness for Claude Code: brief it, it conducts Claude Code in your seat, git locked.",
     "author": { "name": "Jonhvmp" },
     "category": "orchestration",
     "source": { "source": "github", "repo": "Jonhvmp/leopold" }
   }
   ```
2. Open the PR. Review and listing are on their side.

## 3. Release v0.1.0

```bash
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 --title "Leopold v0.1.0" --notes-file <(sed -n '/## \[0.1.0\]/,/## \[/p' CHANGELOG.md)
```

## Note on CI
GitHub Actions is billing-locked on the account, so CI and the docs auto-deploy
do not run. Resolve in GitHub Settings -> Billing. Meanwhile, `make docs-deploy`
publishes the docs (native Pages build, not Actions).
