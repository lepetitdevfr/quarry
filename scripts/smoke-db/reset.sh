#!/usr/bin/env bash
# Put the smoke database back exactly as seed.sql describes it.
#
# The seed in up.sh only ever runs once: Postgres' entrypoint loads
# /docker-entrypoint-initdb.d only when the data directory is empty, and
# the data lives in a named volume that survives everything. So the
# database drifts — a smoke test that deletes rows, drops a table, or
# leaves a stray view behind changes what the next smoke test starts
# from, and "500 rows" stops meaning 500 rows.
#
# This reloads it in place, without touching the container or the volume:
#
#   ./scripts/smoke-db/reset.sh
#
# Everything in the public and analytics schemas is dropped and rebuilt
# from seed.sql. Nothing else on the machine is touched — it acts only on
# the `quarry-smoke` container.
set -euo pipefail
cd "$(dirname "$0")"

container=quarry-smoke

if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
  echo "error: $container is not running — start it with ./up.sh" >&2
  exit 1
fi

echo "resetting $container from seed.sql…"

# Drop both schemas rather than the database itself: dropping a database
# needs no open connections, and Quarry may well be connected while you
# are smoke testing. This works with the app running.
docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
drop schema if exists analytics cascade;
drop schema if exists public cascade;
create schema public;
SQL

# Output to /dev/null, errors still raised: the dump prints a `set_config`
# and a `setval` result table per sequence, which buries the report below.
docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q -o /dev/null < seed.sql

# Report what is there, so a reset that silently did half the job cannot
# pass for one that worked.
docker exec -i "$container" psql -U postgres -tA <<'SQL'
select 'customers      ' || count(*) from public.customers
union all select 'orders         ' || count(*) from public.orders
union all select 'daily_revenue  ' || count(*) from analytics.daily_revenue
union all select 'views          ' || count(*) from information_schema.views
    where table_schema in ('public', 'analytics');
SQL

echo "smoke database reset"
