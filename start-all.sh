#!/usr/bin/env bash
set -euo pipefail

TIMEOUT=${1:-180}

echo "Bringing up containers (build if needed)..."
docker compose up --build -d

targets=("http://localhost:4010/health" "http://localhost:4020/health" "http://localhost:4001/health")
start=$(date +%s)

for t in "${targets[@]}"; do
  echo "Waiting for $t ..."
  ok=0
  while [ $ok -eq 0 ]; do
    if curl -fsS --max-time 5 "$t" >/dev/null 2>&1; then
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
echo "Frontend: http://localhost:5173"
echo "Gateway: http://localhost:4010"
echo "Auth: http://localhost:4020"
echo "Meeting: http://localhost:4001"
