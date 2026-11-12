#!/usr/bin/env bash
# Applies db/migrations/*.sql in order against the running `db` container. Safe to re-run (migrations are idempotent).
# Usage: docker compose up -d db && bash tools/migrar.sh && docker compose up -d
set -euo pipefail
cd "$(dirname "$0")/.."
for f in db/migrations/*.sql; do
  echo "→ $f"
  docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$f"
done
docker compose kill -s SIGUSR1 rest 2>/dev/null || true   # PostgREST reloads its schema cache
echo "migrations applied"
