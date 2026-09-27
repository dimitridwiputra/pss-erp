#!/usr/bin/env bash
set -euo pipefail

docker_args=(--detach --rm --ipc=host --publish 127.0.0.1::3000)
if [[ "$(uname -s)" != 'Darwin' ]]; then
  docker_args+=(--add-host=host.docker.internal:host-gateway)
fi

container_id="$(docker run "${docker_args[@]}" mcr.microsoft.com/playwright:v1.63.0-noble npx -y playwright@1.63.0 run-server --port 3000 --host 0.0.0.0)"
cleanup() { docker stop "$container_id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
address="$(docker port "$container_id" 3000/tcp)"

for attempt in {1..30}; do
  if docker logs "$container_id" 2>&1 | grep -q 'Listening on ws://'; then
    PW_TEST_CONNECT_WS_ENDPOINT="ws://${address}/" \
      PSS_VISUAL_BASE_URL='http://host.docker.internal:6006' \
      pnpm test:visual "$@"
    exit $?
  fi
  sleep 1
done

docker logs "$container_id" >&2
echo 'The pinned Playwright browser server did not start.' >&2
exit 1
