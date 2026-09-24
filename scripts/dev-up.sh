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
pnpm dev
