"""
Entrypoint: ``python -m src.embedder``

Boots the embedder FastAPI app on EMBEDDER_HOST:EMBEDDER_PORT (defaults to
0.0.0.0:8200). Single worker on purpose — the BGE-M3 singleton lives in this
process's memory, and uvicorn's ``--workers`` would fork and load the model
once per worker, defeating the whole point of this service.
"""
from __future__ import annotations

import logging
import os

import uvicorn


def main() -> None:
    # Defensive: this process IS the embedder server. If EMBED_SERVICE_URL is
    # set in our environment, the embeddings module would try to forward every
    # request *to ourselves* and deadlock. Strip it before importing anything
    # that touches src.infra.embeddings.
    os.environ.pop("EMBED_SERVICE_URL", None)

    host = os.getenv("EMBEDDER_HOST", "0.0.0.0")
    port = int(os.getenv("EMBEDDER_PORT", "8200"))
    log_level = os.getenv("LOG_LEVEL", "INFO").lower()
    logging.basicConfig(level=log_level.upper())
    uvicorn.run(
        "src.embedder.server:app",
        host=host,
        port=port,
        workers=1,
        log_level=log_level,
    )


if __name__ == "__main__":
    main()
