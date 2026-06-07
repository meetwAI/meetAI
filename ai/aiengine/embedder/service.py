"""
embedder/server.py
------------------
Host-local FastAPI microservice that owns the embedder singleton.

Why a separate process
----------------------
Both the topic worker and the QA service need to embed text. Loading the embedder model
twice would waste >1 GB of RAM and double cold-start time. By moving the model
behind a tiny HTTP service, every other process becomes a thin client and the
weights live in exactly one process for the whole host.

The service reuses ``aiengine.embedder.embeddings`` unchanged — that module already
implements the thread-safe lazy singleton. We just wrap it in HTTP.

Endpoints
---------
- ``POST /embed {"texts": [...]}``  → ``{"vectors": [[...], ...], "dim": EMBED_DIM}``
- ``GET  /health``                  → liveness, plus ``model_loaded`` flag.
- ``POST /warmup``                  → forces the model load now so the first
                                       real request doesn't pay the latency.
"""
from __future__ import annotations

import logging
import os
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from aiengine.embedder.embeddings import EMBED_DIM, embed_texts_async

logger = logging.getLogger(__name__)

app = FastAPI(title="meetAI embedder", version="1.0")


class EmbedRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1)


class EmbedResponse(BaseModel):
    vectors: List[List[float]]
    dim: int


def _warmup_enabled() -> bool:
    return os.getenv("EMBEDDER_WARMUP", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
    }


@app.on_event("startup")
async def _startup_warmup() -> None:
    if not _warmup_enabled():
        logger.info("Embedder warmup disabled via EMBEDDER_WARMUP.")
        return
    logger.info("Warming embedder model...")
    await embed_texts_async(["warmup"])
    logger.info("Embedder warmup complete.")


@app.get("/health")
async def health() -> dict:
    # We don't force-load the model here — health should be cheap. The
    # ``model_loaded`` flag tells the caller whether the next /embed will pay
    # the cold-start cost.
    from aiengine.embedder import embeddings as _emb
    return {
        "status": "ok",
        "model_loaded": _emb._embed_model is not None,
        "dim": EMBED_DIM,
    }


@app.post("/warmup")
async def warmup() -> dict:
    # One-token embed forces the singleton to load.
    await embed_texts_async(["warmup"])
    return {"status": "ready", "dim": EMBED_DIM}


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    if not req.texts:
        raise HTTPException(status_code=400, detail="texts must be non-empty")
    try:
        vectors = await embed_texts_async(req.texts)
    except Exception as exc:
        logger.exception("embedding failed")
        raise HTTPException(status_code=500, detail=f"embedding failed: {exc}")
    return EmbedResponse(vectors=vectors, dim=EMBED_DIM)
