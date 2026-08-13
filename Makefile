# Leopold - project Makefile
# Run `make` or `make help` to list targets.
#
# Recipes are POSIX-sh compatible. Overridable tools:
#   make docs-build MKDOCS="python3 -m mkdocs"
#   make driver-build NPM=pnpm

DRIVER := packages/driver
NPM    ?= npm
MKDOCS ?= python3 -m mkdocs

.DEFAULT_GOAL := help

# ---- Help -------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@printf "Leopold - make targets\n\n"
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---- Install ----------------------------------------------------------------

.PHONY: install
install: ## Install skills + hooks into ~/.claude (runs ./install.sh)
	@./install.sh

.PHONY: update
update: ## Update Leopold to the latest (pull + reinstall)
	@bash scripts/leopold-update.sh

.PHONY: menu
menu: ## Open the toolchain manager (install/manage gstack, ovmem, ...)
	@bash scripts/leopold-menu.sh

.PHONY: watch
watch: ## Live dashboard for the run in this project (http://127.0.0.1:4179, Ctrl-C to stop)
	@python3 scripts/leopold-watch.py --project .

.PHONY: ovmem-watch
ovmem-watch: ## Live dashboard for ovmem long-term memory (http://127.0.0.1:1934, Ctrl-C to stop)
	@bash extensions/ovmem/manage.sh watch

.PHONY: serena-install serena-doctor
serena-install: ## Install + register Serena (LSP code intelligence MCP) on every harness here
	@bash extensions/serena/manage.sh install

serena-doctor: ## Check the Serena install per harness (CLI, MCP registration, hooks)
	@bash extensions/serena/manage.sh doctor

.PHONY: gstack-install gstack-doctor
gstack-install: ## Install gstack (optional, MIT by Garry Tan) into every harness here
	@bash extensions/gstack/manage.sh install

gstack-doctor: ## Check the gstack install per harness (checkout, bun, skills per skills root)
	@bash extensions/gstack/manage.sh doctor

# ---- Hooks ------------------------------------------------------------------

.PHONY: doctor
doctor: ## Diagnose the Leopold install (skills, hooks, wiring, gstack)
	@bash scripts/leopold-doctor.sh

.PHONY: hooks-check hooks-test
hooks-check: ## Syntax-check the hooks, the installer, and the enhance engine
	@bash -n hooks/stop-continuity.sh
	@bash -n hooks/guard-irreversible.sh
	@bash -n install.sh
	@bash -n scripts/install-codex.sh
	@bash -n extensions/lib/harness.sh
	@bash -n extensions/serena/manage.sh
	@bash -n extensions/enhance/install.sh
	@bash -n extensions/enhance/manage.sh
	@bash -n extensions/ovmem/install.sh
	@bash -n extensions/ovmem/manage.sh
	@python3 -m py_compile extensions/enhance/payload/enhance.py
	@python3 -m py_compile extensions/ovmem/payload/ovmem.py extensions/ovmem/payload/dashboard.py
	@# The SAME lint CI runs (ci.yml), so `make test` green means the hooks job's lint is
	@# green too. A machine without shellcheck says so out loud instead of skipping into a
	@# local-passes-CI-fails surprise — that already happened once (SC2034, PR #58).
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck -S warning hooks/*.sh install.sh scripts/*.sh extensions/*/*.sh && echo "shellcheck: clean"; \
	else \
		echo "WARNING: shellcheck not installed — CI lints with it and this machine cannot."; \
		echo "         install: https://github.com/koalaman/shellcheck#installing (static binary works in ~/.local/bin)"; \
	fi
	@echo "hooks + installers + harness lib + enhance/ovmem engines: syntax OK"

hooks-test: ## Run the hook behavior tests
	@bash scripts/test-hooks.sh

.PHONY: harness-test
harness-test: ## Run the shared harness-wiring tests (hermetic: temp CLAUDE_HOME/CODEX_HOME)
	@bash scripts/test-harness-lib.sh

.PHONY: codex-install-test
codex-install-test: ## Run the end-to-end Codex install test (hermetic: temp homes, stubbed PATH, no network)
	@bash scripts/test-codex-install.sh

.PHONY: serena-test
serena-test: ## Run the serena extension tests (hermetic: temp HOME/CLAUDE_HOME/CODEX_HOME, stubbed CLIs)
	@bash scripts/test-serena-ext.sh

.PHONY: ovmem-test
ovmem-test: ## Run the ovmem extension tests (hermetic: temp homes, stubbed OpenViking, no network)
	@bash scripts/test-ovmem-ext.sh

.PHONY: gstack-test
gstack-test: ## Run the gstack extension tests (hermetic: temp homes, stubbed git, no bun)
	@bash scripts/test-gstack-ext.sh

.PHONY: skills-test
skills-test: ## Run the skill path tests (no SKILL.md may hardcode a harness home)
	@bash scripts/test-skill-paths.sh

.PHONY: menu-test
menu-test: ## Run the toolchain-menu harness-switch tests (hermetic: temp homes, stubbed PATH)
	@bash scripts/test-menu-harness.sh

.PHONY: test-guard
test-guard: ## Run the guard red-team suite (bypass attempts must stay blocked)
	@bash scripts/test-guard.sh

.PHONY: enhance-test
enhance-test: ## Run the prompt-enhancer behavior tests (stubbed claude, no network)
	@bash scripts/test-enhance.sh
	@bash scripts/test-enhance-ext.sh

.PHONY: watch-test
watch-test: ## Run the dashboard DAG-builder + steer-command tests (stdlib, no network)
	@python3 -m py_compile scripts/leopold-watch.py
	@python3 scripts/test-watch-graph.py

# ---- Driver -----------------------------------------------------------------

.PHONY: driver-install driver-build driver-check driver-test driver-smoke driver-clean
driver-install: ## Install the SDK driver dependencies
	@cd $(DRIVER) && $(NPM) install

driver-build: ## Build the SDK driver (tsc)
	@cd $(DRIVER) && $(NPM) run build

driver-check: ## Typecheck the SDK driver
	@cd $(DRIVER) && $(NPM) run typecheck

driver-test: ## Run the SDK driver unit tests (parser + guard; needs Node 22.6+)
	@cd $(DRIVER) && $(NPM) test

driver-smoke: ## Build the driver, then smoke the built CLI end to end (no network)
	@cd $(DRIVER) && $(NPM) run build
	@bash scripts/test-cli-smoke.sh

driver-clean: ## Remove driver build output and dependencies
	@rm -rf $(DRIVER)/dist $(DRIVER)/node_modules

# ---- Docs -------------------------------------------------------------------

.PHONY: docs-install docs-serve docs-build docs-deploy docs-clean
docs-install: ## Install the docs toolchain (mkdocs-material)
	@python3 -m pip install --user -r requirements-docs.txt || python3 -m pip install --user --break-system-packages -r requirements-docs.txt

docs-serve: ## Serve the docs locally with live reload
	@$(MKDOCS) serve

docs-build: ## Build the docs (strict; fails on broken links)
	@$(MKDOCS) build --strict

docs-deploy: ## Build and deploy the docs to GitHub Pages
	@$(MKDOCS) gh-deploy --force

docs-clean: ## Remove the built docs site
	@rm -rf site

# ---- Aggregate --------------------------------------------------------------

.PHONY: test ci clean
test: hooks-check hooks-test test-guard harness-test codex-install-test serena-test ovmem-test gstack-test skills-test menu-test enhance-test watch-test driver-check driver-test driver-smoke docs-build ## Run the full check gate (what CI runs)
	@echo "all checks passed"

ci: test ## Alias for the full check gate

clean: docs-clean driver-clean ## Remove all build output and dependencies
	@echo "cleaned"
