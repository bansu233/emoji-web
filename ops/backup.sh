#!/usr/bin/env bash
set -euo pipefail

# Run a consistent SQLite + uploads backup inside the app container.
# The container has /app/backups bind-mounted to ./backups on the host.
cd "$(dirname "$0")/.."
docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/backup.js
