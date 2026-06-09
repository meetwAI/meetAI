#!/usr/bin/env bash
set -euo pipefail

# Run from the repo root regardless of where the script is invoked from
# (it lives in scripts/, repo root is one level up).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TIMEOUT=${1:-180}

COMPOSE_FILE="infra/docker/docker-compose.yml"

echo "Bringing up containers (build if needed)..."
docker compose -f "$COMPOSE_FILE" up --build -d

# auth-service listens on HTTPS by default (see compose: AUTH_USE_HTTPS=true).
# Mirror that here so curl picks the right scheme; `-k` skips 0.0.0.0 cert
# validation since we ship a self-signed pair.
auth_scheme="https"
if [ "${AUTH_USE_HTTPS:-true}" != "true" ]; then
  auth_scheme="http"
fi

targets=(
  "http://0.0.0.0:4010/health"
  "${auth_scheme}://0.0.0.0:4020/health"
  "http://0.0.0.0:4001/health"
)
start=$(date +%s)

for t in "${targets[@]}"; do
  echo "Waiting for $t ..."
  ok=0
  while [ $ok -eq 0 ]; do
    if curl -fsSk --max-time 5 "$t" >/dev/null 2>&1; then
      ok=1
      break
    fi
    now=$(date +%s)
    if [ $((now - start)) -gt $TIMEOUT ]; then
      echo "Timed out waiting for $t" >&2
      exit 1
    fi
    sleep 2
  done
  echo "$t is ready"
done

echo "All services appear ready."
echo "Frontend: https://0.0.0.0:5173"
echo "Gateway: http://0.0.0.0:4010"
echo "Auth: http://0.0.0.0:4020"
echo "Meeting: http://0.0.0.0:4001"
