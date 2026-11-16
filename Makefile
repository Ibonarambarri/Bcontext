# Shortcuts for the common tasks. Every target is a thin wrapper around a
# command documented in the README, so nothing here is required: run the
# command directly if you prefer. `make help` lists them.

DOMAIN      ?= localhost
HTTP_PORT   ?= 8080
ADMIN_EMAIL ?= admin@example.com
URL         := http://$(DOMAIN):$(HTTP_PORT)

.DEFAULT_GOAL := help
.PHONY: help setup up down logs health install build test lint verify dev examples examples-node

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ── Run the stack (Docker) ─────────────────────────────────────────────

setup: ## Write .env with fresh secrets (DOMAIN, HTTP_PORT, ADMIN_EMAIL)
	./setup.sh --domain $(DOMAIN) --admin-email $(ADMIN_EMAIL) --http-port $(HTTP_PORT) -y

up: ## Start the stack (runs setup first if there is no .env), wait until healthy
	@test -f .env || $(MAKE) setup
	docker compose up -d
	@$(MAKE) --no-print-directory health

down: ## Stop the stack (data volumes are kept)
	docker compose down

logs: ## Follow the api, worker and web logs
	docker compose logs -f api worker web

health: ## Wait up to 2 minutes for /api/health to answer ok
	@for i in $$(seq 1 60); do \
	  if curl -fsS $(URL)/api/health 2>/dev/null | grep -q '"status":"ok"'; then \
	    echo "healthy: open $(URL)"; exit 0; fi; sleep 2; done; \
	echo "not healthy after 2 minutes: docker compose logs migrate api" >&2; exit 1

## ── Develop (Node 24) ──────────────────────────────────────────────────

install: ## Install the workspace dependencies
	npm ci --no-audit --no-fund

build: ## Build the contract, the API bundles and the web app
	npm run build

test: ## Run the unit tests of every workspace
	npm test

verify: ## Typecheck, lint, test and build every workspace: what CI runs
	npm run verify

lint: ## Lint the web app (ESLint)
	npm run lint -w bcontext-web

dev: ## Run the web app in dev mode
	npm run dev:web

## ── Examples (need BCONTEXT_URL, BCONTEXT_WORKSPACE, BCONTEXT_TOKEN) ────

examples: ## Run the curl agent loop against your instance
	./examples/curl/agent-loop.sh

examples-node: ## Run the MCP SDK agent loop against your instance
	cd examples/node && npm install --no-audit --no-fund && npm start
