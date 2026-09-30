#!/usr/bin/env bash
# The core API for the MVP demo on this machine (docs/mvp/DEMO_RUNBOOK.md). The POS routes answer
# only with PSS_DEMO_POS_ENABLED=true and never under NODE_ENV=production (MVP-OD-5), so this runs
# the API in development mode against the local containers from `pnpm dev:up`.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=development
export PORT="${PORT:-4000}"
export DATABASE_URL="${DATABASE_URL:-postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export PSS_OIDC_ISSUER='http://127.0.0.1:8080/realms/pss-local'
export PSS_OIDC_AUDIENCE='pss-api'
export PSS_OIDC_JWKS_URI='http://127.0.0.1:8080/realms/pss-local/protocol/openid-connect/certs'
export PSS_DEMO_POS_ENABLED=true
exec apps/api/node_modules/.bin/tsx apps/api/src/main.ts
