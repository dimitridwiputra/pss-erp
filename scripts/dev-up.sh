#!/usr/bin/env bash
set -euo pipefail
if command -v docker >/dev/null 2>&1; then
  docker_bin="$(command -v docker)"
elif [[ -x "${HOME}/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
  docker_bin="${HOME}/Applications/Docker.app/Contents/Resources/bin/docker"
  export PATH="${HOME}/Applications/Docker.app/Contents/Resources/bin:${PATH}"
  if [[ -S "${HOME}/.docker/run/docker.sock" ]]; then
    export DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock"
  fi
else
  echo 'Docker with Compose is required for pnpm dev:up. Install/start Docker, or use pnpm dev for app shells only.' >&2
  exit 1
fi
"${docker_bin}" compose up -d --wait
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/audit db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/platform db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/identity db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/master-data db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/commercial db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/inventory db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/orders db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/fulfillment db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/invoicing db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/payments db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/pos db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/reporting db:migrate
DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational' pnpm --filter @pss/wms db:migrate
export DATABASE_URL='postgresql://pss_local:pss_local_only@127.0.0.1:5432/pss_operational'
export REDIS_URL='redis://127.0.0.1:6379'
export PSS_OIDC_ISSUER='http://127.0.0.1:8080/realms/pss-local'
export PSS_OIDC_AUDIENCE='pss-api'
export PSS_OIDC_JWKS_URI='http://127.0.0.1:8080/realms/pss-local/protocol/openid-connect/certs'
pnpm idp:setup:local
pnpm dev
