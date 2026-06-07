"""
Entrypoint: ``python -m aiengine.qa``

Boots the QA FastAPI app on QA_HOST:QA_PORT (defaults to 0.0.0.0:8100).

Single worker on purpose:
- google-genai clients hold no per-process state we'd want to fork around.
- The asyncpg pool is built in the startup hook; multiple uvicorn workers
  would each open their own pool, which is fine but unnecessary at this
  scale and would multiply Postgres connections for no throughput gain.
- The whole point of the embedder microservice (Step 1) is to keep the embedder
  loaded once; the QA service runs in service mode and is itself stateless,
  so we don't need workers > 1 to scale either.

If you ever do need more concurrency, scale by running more QA processes
behind a load balancer rather than ``--workers``.
"""
from __future__ import annotations

import logging
import os

import uvicorn


def main() -> None:
    host = os.getenv("QA_HOST", "0.0.0.0")
    port = int(os.getenv("QA_PORT", "8100"))
    log_level = os.getenv("LOG_LEVEL", "INFO").lower()
    logging.basicConfig(level=log_level.upper())
    uvicorn.run(
        "aiengine.qa.service:app",
        host=host,
        port=port,
        workers=1,
        log_level=log_level,
    )


if __name__ == "__main__":
    main()
