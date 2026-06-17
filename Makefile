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

# ---- Hooks ------------------------------------------------------------------

.PHONY: hooks-check
hooks-check: ## Syntax-check the hooks and the installer
	@bash -n hooks/stop-continuity.sh
	@bash -n hooks/guard-irreversible.sh
	@bash -n install.sh
	@echo "hooks + install.sh: syntax OK"

# ---- Driver -----------------------------------------------------------------

.PHONY: driver-install driver-build driver-check driver-clean
driver-install: ## Install the SDK driver dependencies
	@cd $(DRIVER) && $(NPM) install

driver-build: ## Build the SDK driver (tsc)
	@cd $(DRIVER) && $(NPM) run build

driver-check: ## Typecheck the SDK driver
	@cd $(DRIVER) && $(NPM) run typecheck

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
test: hooks-check driver-check docs-build ## Run the full check gate (what CI runs)
	@echo "all checks passed"

ci: test ## Alias for the full check gate

clean: docs-clean driver-clean ## Remove all build output and dependencies
	@echo "cleaned"
