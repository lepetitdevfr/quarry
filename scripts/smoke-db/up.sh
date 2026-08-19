#!/usr/bin/env bash
# Start (or restart) the persistent smoke-test Postgres.
#
# One database, always the same: postgres 17 on localhost:55432, password
# `postgres`, seeded from seed.sql — customers (500 rows, NULLs, boolean),
# orders (5000 rows, enum order_status, FK), analytics.daily_revenue, and
# the paid_orders view. Data lives in the named volume `quarry-smoke-data`,
# so it survives container removal and reboots; the seed is only loaded when
# the volume is empty.
#
#   ./scripts/smoke-db/up.sh          # start it
#   docker stop quarry-smoke          # stop it (data kept)
#   docker rm -f quarry-smoke \
#     && docker volume rm quarry-smoke-data   # wipe and start over
#
# Connection URL for Quarry:
#   postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable
set -euo pipefail
cd "$(dirname "$0")"

if docker ps --format '{{.Names}}' | grep -qx quarry-smoke; then
  echo "quarry-smoke already running"
  exit 0
fi
docker rm quarry-smoke 2>/dev/null || true

docker run -d --name quarry-smoke \
  --restart unless-stopped \
  -e POSTGRES_PASSWORD=postgres \
  -v quarry-smoke-data:/var/lib/postgresql/data \
  -v "$PWD/seed.sql":/docker-entrypoint-initdb.d/seed.sql:ro \
  -p 55432:5432 \
  postgres:17

echo "quarry-smoke up on localhost:55432 (seed loads only on first boot of an empty volume)"
