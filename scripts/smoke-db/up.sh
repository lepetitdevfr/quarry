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
#   ./scripts/smoke-db/reset.sh       # put the data back exactly as seeded
#   docker stop quarry-smoke          # stop it (data kept)
#   docker rm -f quarry-smoke \
#     && docker volume rm quarry-smoke-data   # wipe and start over
#
# The seed only ever runs on an empty volume, so this script also checks
# afterwards: a volume that exists but holds no schema gets seeded rather
# than left as an empty database nobody asked for. Drift from smoke
# testing is `reset.sh`'s job, not this one's — it will not overwrite
# data that is there.
#
# Connection URL for Quarry:
#   postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable
set -euo pipefail
cd "$(dirname "$0")"

# Seed only if the database has no schema of its own. Present data is
# never touched: a reset in the middle of smoke testing would be this
# script destroying the thing you were testing.
seed_if_empty() {
  local tables
  tables=$(docker exec quarry-smoke psql -U postgres -tAc \
    "select count(*) from information_schema.tables where table_schema in ('public','analytics')" \
    2>/dev/null || echo "")
  if [ "$tables" = "0" ]; then
    echo "volume exists but holds no schema — seeding it"
    ./reset.sh
  fi
}

if docker ps --format '{{.Names}}' | grep -qx quarry-smoke; then
  echo "quarry-smoke already running"
  seed_if_empty
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

# The server needs a moment before it will answer; without this the
# emptiness check below reads as "cannot connect" and seeds nothing.
for _ in $(seq 1 30); do
  docker exec quarry-smoke pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

seed_if_empty

echo "quarry-smoke up on localhost:55432"
