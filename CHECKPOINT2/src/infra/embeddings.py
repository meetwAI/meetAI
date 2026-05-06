"""
embeddings.py
-------------
Shared BGE-M3 (1024-d) embedding singleton used by both the chunk-store and
the topic processor.

The model + tokenizer are loaded exactly once for the whole worker process —
loading bge-m3 twice would waste >1 GB of RAM and double cold-start time.
A threading.Lock guards the lazy init against a double-init race when several
async tasks try to embed concurrently on first use.

Public surface
--------------
- ``EMBED_DIM`` — embedding dimensionality (1024).
- ``embed_texts_sync(texts)`` — synchronous, returns ``list[list[float]]``.
- ``embed_texts_async(texts)`` — async wrapper that offloads large batches to
  a dedicated single-thread executor so the event loop stays responsive.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import List
import torch
import numpy as np
from sentence_transformers import SentenceTransformer
from src.core.config import settings

logger = logging.getLogger(__name__)

_MODEL_REPO = "BAAI/bge-m3"
EMBED_DIM = 1024
_MAX_SYNC_BATCH = 64  # above this we offload to thread to keep event loop free

_embed_model = None
_embed_lock = threading.Lock()
_embed_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="st-bge")


def _get_model_and_tokenizer():
    """Thread-safe lazy init. Returns (model, tokenizer)."""
    global _embed_model
    if _embed_model is not None:
        return _embed_model, None
    with _embed_lock:
        if _embed_model is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if settings.EMBEDDINGS_REQUIRE_GPU and device != "cuda":
                raise RuntimeError(
                    "EMBEDDINGS_REQUIRE_GPU=true but CUDA is not available."
                )
            logger.info(
                "Loading embedding model repo=%s device=%s cuda_available=%s",
                _MODEL_REPO,
                device,
                torch.cuda.is_available(),
            )
            _embed_model = SentenceTransformer(_MODEL_REPO, device=device)
            logger.info("Embedding model loaded on %s.", device)
    return _embed_model, None


def embed_texts_sync(texts: List[str]) -> List[List[float]]:
    """
    Synchronous embedding — safe to call from any thread.
    Returns a list of 1024-d float vectors.
    """
    if not texts:
        return []

    model, _ = _get_model_and_tokenizer()
    logger.info("Embedding batch size=%s", len(texts))
    vectors: np.ndarray = model.encode(
        texts,
        batch_size=32,
        normalize_embeddings=False,
        show_progress_bar=False,
    )

    embeddings = vectors.tolist()

    assert len(embeddings[0]) == EMBED_DIM, (
        f"Unexpected embedding dim {len(embeddings[0])}, expected {EMBED_DIM}. "
        "Did the model change?"
    )
    return embeddings


async def embed_texts_async(texts: List[str]) -> List[List[float]]:
    """
    Async wrapper. Small batches run inline (sentence-transformers is non-blocking
    enough for small inputs); large batches are offloaded to a dedicated thread so
    asyncio stays free.
    """
    if not texts:
        return []
    if len(texts) > _MAX_SYNC_BATCH:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_embed_executor, embed_texts_sync, texts)
    return embed_texts_sync(texts)

