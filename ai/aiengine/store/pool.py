"""
db.py
-----
Shared asyncpg connection pool for the AI worker.

Usage
-----
    from aiengine.store.pool import create_pool, close_pool

    pool = await create_pool(dsn)
    # … pass pool to ChunkStore …
    await close_pool(pool)
"""
from __future__ import annotations

import logging

import asyncpg

logger = logging.getLogger(__name__)


async def create_pool(dsn: str, min_size: int = 2, max_size: int = 5) -> asyncpg.Pool:
    """Open a connection pool; retries are handled by the caller (worker startup)."""
    logger.info("Connecting to Postgres …")
    pool = await asyncpg.create_pool(dsn, min_size=min_size, max_size=max_size)
    logger.info("Postgres pool ready.")
    return pool


async def close_pool(pool: asyncpg.Pool) -> None:
    """Gracefully close all connections in the pool."""
    try:
        await pool.close()
        logger.info("Postgres pool closed.")
    except Exception:
        logger.exception("Error closing Postgres pool.")
