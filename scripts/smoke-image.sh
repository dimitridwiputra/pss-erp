#!/usr/bin/env bash
set -euo pipefail

app="${1:?Usage: smoke-image.sh <app> <image-tag>}"
tag="${2:?Usage: smoke-image.sh <app> <image-tag>}"
case "$app" in
  web) service_port=3000 ;;
  api) service_port=4000 ;;
  finance-api) service_port=4001 ;;
  integration-worker) service_port=4002 ;;
  geo-service) service_port=4003 ;;
  *) echo "Unknown deployable: $app" >&2; exit 1 ;;
esac

container_id="$(docker run --detach --rm --publish "127.0.0.1::${service_port}" "pss-${app}:${tag}")"
cleanup() { docker stop "$container_id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
address="$(docker port "$container_id" "${service_port}/tcp")"

for attempt in {1..30}; do
  if curl --fail --silent --show-error "http://${address}/health/live" >/dev/null 2>&1; then
    echo "${app} image: /health/live OK"
    exit 0
  fi
  sleep 1
done

docker logs "$container_id" >&2
echo "${app} image did not become healthy at /health/live" >&2
exit 1
