# Leopold - project Makefile
# Run `make` or `make help` to list targets.
#
# Recipes are POSIX-sh compatible. Overridable tools:
#   make docs-build MKDOCS="python3 -m mkdocs"
#   make driver-build NPM=pnpm

DRIVER := packages/driver
NPM    ?= npm
MKDOCS ?= python3 -m mkdocs
GSTACK_DIR ?= $(HOME)/.claude/skills/gstack

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
serena-install: ## Install + register Serena (LSP code intelligence MCP) — mandatory for quality
	@bash extensions/serena/manage.sh install

serena-doctor: ## Check the Serena install (CLI, MCP registration, hooks)
	@bash extensions/serena/manage.sh doctor

.PHONY: gstack-install
gstack-install: ## Install gstack (optional, MIT by Garry Tan) — the toolchain Leopold conducts
	@if [ -d "$(GSTACK_DIR)" ]; then \
		echo "gstack already installed at $(GSTACK_DIR)"; \
	else \
		echo "Installing gstack (https://github.com/garrytan/gstack) — needs Bun v1.0+..."; \
		git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$(GSTACK_DIR)" && cd "$(GSTACK_DIR)" && ./setup; \
	fi

# ---- Hooks ------------------------------------------------------------------

.PHONY: doctor
doctor: ## Diagnose the Leopold install (skills, hooks, wiring, gstack)
	@bash scripts/leopold-doctor.sh

.PHONY: hooks-check hooks-test
hooks-check: ## Syntax-check the hooks and the installer
	@bash -n hooks/stop-continuity.sh
	@bash -n hooks/guard-irreversible.sh
	@bash -n install.sh
	@echo "hooks + install.sh: syntax OK"

hooks-test: ## Run the hook behavior tests
	@bash scripts/test-hooks.sh

.PHONY: test-guard
test-guard: ## Run the guard red-team suite (bypass attempts must stay blocked)
	@bash scripts/test-guard.sh

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
test: hooks-check hooks-test test-guard driver-check driver-test driver-smoke docs-build ## Run the full check gate (what CI runs)
	@echo "all checks passed"

ci: test ## Alias for the full check gate

clean: docs-clean driver-clean ## Remove all build output and dependencies
	@echo "cleaned"
