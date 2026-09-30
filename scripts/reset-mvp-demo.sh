#!/usr/bin/env bash
# Reset the local MVP demo to a known start (docs/mvp/DEMO_RUNBOOK.md): an empty operational
# database, every migration, the demo users' PSS accounts and roles, and the synthetic demo data.
#
# DESTRUCTIVE: drops the local database named below. It never touches Keycloak users or their
# passwords (.local/pss-mvp-demo-logins.txt stays valid) and refuses to run without confirmation.
set -euo pipefail
cd "$(dirname "$0")/.."

database="${PSS_DEMO_DATABASE:-pss_operational}"
if [[ "${CONFIRM_RESET:-}" != "yes" ]]; then
  echo "This drops the local database '${database}' and rebuilds the demo. Re-run with CONFIRM_RESET=yes." >&2
  exit 1
fi
url="postgresql://pss_local:pss_local_only@127.0.0.1:5432/${database}"

# Over the published port rather than `docker compose exec`, which depends on this folder's name.
PSS_DEMO_DATABASE="$database" node --input-type=module -e "
import pg from 'pg';
const name = process.env.PSS_DEMO_DATABASE;
if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unsafe database name.');
const client = new pg.Client({ connectionString: 'postgresql://pss_local:pss_local_only@127.0.0.1:5432/postgres' });
await client.connect();
await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = \$1 AND pid <> pg_backend_pid()', [name]);
await client.query('DROP DATABASE IF EXISTS ' + name);
await client.query('CREATE DATABASE ' + name);
await client.end();
"

pnpm build >/dev/null
DATABASE_URL="$url" node scripts/migrate-local.mjs
DATABASE_URL="$url" node scripts/setup-local-identity.mjs
DATABASE_URL="$url" node scripts/seed-mvp-demo.mjs
echo "Demo reset complete. Start the API with scripts/dev-mvp-api.sh and the web with pnpm --filter @pss/web dev."
