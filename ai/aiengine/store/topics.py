"""
topic_store.py
--------------
DB layer for the ``meeting_topics`` table.

Three operations
----------------
1. ``fetch_existing(meeting_id)`` — read every topic row for a meeting along
   with its decoded embedding vector. Used by the topic processor to compare
   newly generated topics against what already exists for that meeting.
2. ``insert_topic(...)`` — append a brand-new topic row.
3. ``merge_chunk_ids(topic_id, new_chunk_ids)`` — extend an existing topic's
   ``chunk_ids`` array with new IDs while guaranteeing the result has no
   duplicates. The deduplication is performed atomically in SQL so two
   concurrent merges on the same row cannot leave duplicate UUIDs behind.

All public methods are best-effort: they log exceptions and return a sentinel
(``[]``, ``False``) instead of raising, so a DB outage degrades the topic
pipeline without crashing the audio pipeline.

Embedding format
----------------
``pgvector`` stores vectors as ``VECTOR(EMBED_DIM)``. asyncpg surfaces them as
strings shaped like ``'[0.1,0.2,...]'`` on read, and accepts the same string
on write when we cast with ``::vector``. We decode to ``list[float]`` here
so callers can use plain numpy/Python math.
"""
from __future__ import annotations

import logging
from typing import List, Optional, Sequence, Tuple

import asyncpg

logger = logging.getLogger(__name__)


# Encode/decode helpers live in aiengine.embedder.vector_utils so the
# precision (%.8f) and parsing stay in lock-step across modules.
from aiengine.embedder.vector_utils import (
    encode_vector as _encode_vector,
    decode_vector as _decode_vector,
)


class TopicStore:
    """
    All ``meeting_topics`` access for a single meeting goes through one
    instance. The instance holds no per-meeting state of its own — the
    ``meeting_id`` is passed at the call site so a single instance could in
    principle serve many meetings, but in practice the topic processor owns
    one ``TopicStore`` per meeting and that's it.
    """

    def __init__(self, db_pool: asyncpg.Pool) -> None:
        self._pool = db_pool

    async def fetch_existing(
        self, meeting_id: int
    ) -> List[Tuple[int, str, List[float]]]:
        """
        Return every existing topic row for the meeting as
        ``(topic_id, topic, embedding)`` tuples. Topics with NULL embeddings
        are skipped — they cannot participate in cosine matching anyway.
        """
        logger.debug(f"fetch_existing called for meeting_id={meeting_id}")
        sql = """
            SELECT topic_id, topic, embedding
            FROM meeting_topics
            WHERE meeting_id = $1
              AND embedding IS NOT NULL
        """
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(sql, meeting_id)
        except Exception:
            logger.exception(
                "TopicStore.fetch_existing failed for meeting_id=%s", meeting_id
            )
            return []

        out: List[Tuple[int, str, List[float]]] = []
        for r in rows:
            out.append((r["topic_id"], r["topic"], _decode_vector(r["embedding"])))
        logger.debug(f"fetch_existing returning {len(out)} topics")
        return out

    async def insert_topic(
        self,
        meeting_id: int,
        topic: str,
        chunk_ids: Sequence[int],
        embedding: Sequence[float],
    ) -> Optional[int]:
        """
        Insert a new topic row and return its generated ``topic_id``.

        ``chunk_ids`` is deduplicated in SQL using
        ``ARRAY(SELECT DISTINCT unnest(...))`` so a caller-side mistake
        can't leave duplicates in the row. Returns ``None`` on failure.
        """
        logger.debug(f"insert_topic called: meeting_id={meeting_id}, topic='{topic}', chunk_ids_count={len(chunk_ids)}")
        if not topic.strip():
            logger.debug("insert_topic aborted: empty topic string")
            return None

        sql = """
            INSERT INTO meeting_topics (meeting_id, topic, chunk_ids, embedding)
            SELECT
                $1,
                $2,
                ARRAY(SELECT DISTINCT unnest($3::bigint[])),
                $4::vector
            RETURNING topic_id
        """
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    sql,
                    meeting_id,
                    topic,
                    list(chunk_ids),
                    _encode_vector(embedding),
                )
            new_id = row["topic_id"] if row else None
            logger.debug(f"insert_topic returning new topic_id={new_id}")
            return new_id
        except Exception:
            logger.exception(
                "TopicStore.insert_topic failed for meeting_id=%s topic=%r",
                meeting_id,
                topic,
            )
            return None

    async def merge_chunk_ids(
        self, topic_id: int, new_chunk_ids: Sequence[int]
    ) -> bool:
        """
        Append ``new_chunk_ids`` to the existing row's ``chunk_ids`` array,
        ensuring the result has no duplicates. The dedup happens atomically
        inside the UPDATE statement: we unnest the existing array together
        with the incoming IDs, run DISTINCT, and write the result back.

        Returns True on success, False on failure.
        """
        logger.debug(f"merge_chunk_ids called: topic_id={topic_id}, new_chunk_ids_count={len(new_chunk_ids)}")
        if not new_chunk_ids:
            return True

        sql = """
            UPDATE meeting_topics
            SET chunk_ids = ARRAY(
                SELECT DISTINCT u
                FROM unnest(COALESCE(chunk_ids, ARRAY[]::bigint[]) || $2::bigint[]) AS u
            )
            WHERE topic_id = $1
        """
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    sql,
                    topic_id,
                    list(new_chunk_ids),
                )
            return True
        except Exception:
            logger.exception(
                "TopicStore.merge_chunk_ids failed for topic_id=%s", topic_id
            )
            return False
