SHELL := /bin/bash
COMPOSE ?= docker compose
SERVICE ?= stream-vod-guard

.PHONY: help init up down restart logs status test test-e2e demo shell config update

help:
	@echo "Stream VOD Guard"
	@echo ""
	@echo "  make init      Create .env and local folders from .env.example"
	@echo "  make up        Build and start the stack"
	@echo "  make down      Stop and remove the stack"
	@echo "  make restart   Restart the stack"
	@echo "  make logs      Follow container logs"
	@echo "  make status    Show container status and health"
	@echo "  make test      Run unit tests inside the image"
	@echo "  make test-e2e  Run capture/crash/finalize tests"
	@echo "  make demo      Synthetic live capture demo"
	@echo "  make shell     Open a shell in the container"
	@echo "  make config    Validate docker-compose config"
	@echo "  make update    Pull base images and rebuild"

init:
	@test -f .env || cp .env.example .env
	@mkdir -p videos/recordings data
	@echo "Created .env, videos/recordings and data. Edit .env with your channels."

up: init
	@test -f .env || cp .env.example .env
	$(COMPOSE) up -d --build

down: init
	$(COMPOSE) down

restart: init
	$(COMPOSE) restart

logs: init
	$(COMPOSE) logs -f --tail=100

status: init
	$(COMPOSE) ps
	@curl -fsS http://127.0.0.1:$${DASHBOARD_PORT:-8787}/healthz | python3 -m json.tool 2>/dev/null || true

test: init
	$(COMPOSE) run --rm --entrypoint node $(SERVICE) --test test/unit.test.js

test-e2e: init
	$(COMPOSE) run --rm -e E2E=1 --entrypoint node $(SERVICE) --test test/audit.test.js test/e2e.test.js test/integration.test.js

demo: init
	$(COMPOSE) run --rm $(SERVICE) bash scripts/demo-capture.sh

shell: init
	$(COMPOSE) run --rm --entrypoint bash $(SERVICE)

config: init
	$(COMPOSE) config >/dev/null && echo "docker-compose config OK"

update: init
	$(COMPOSE) pull --ignore-buildable
	$(COMPOSE) build --pull
	$(COMPOSE) up -d
