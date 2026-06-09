"""
qa/memory.py
------------
Simple in-process conversation memory for the QA pipeline.

Keyed by ``(meeting_id, user_id)``, each entry holds the recent Q&A turns so
the extractor can resolve pronouns/references and the streamer can maintain
conversational continuity.

Design
------
- **In-memory dict** — no Redis, no extra infra.  Works because the QA
  service runs as a single uvicorn worker (``workers=1``).
- **DB hydration** — on cache miss (service restart, TTL expiry, first
  question on a finished meeting) we read the last N turns from the
  ``messages`` table that the meeting-service already populates.
- **No writes to DB** — the meeting-service persists every turn; we only
  read.  ``add_turn`` writes to the in-memory cache only.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import asyncpg

logger = logging.getLogger(__name__)

# Type alias for the cache key.
_Key = Tuple[int, int]  # (meeting_id, user_id)


class _CacheEntry:
    """One session's cached conversation turns + bookkeeping."""

    __slots__ = ("turns", "last_access")

    def __init__(self, turns: List[Dict[str, str]], last_access: float) -> None:
        self.turns = turns
        self.last_access = last_access


class ConversationMemory:
    """
    Lightweight conversation-history cache for the QA service.

    Parameters
    ----------
    db_pool:
        The shared asyncpg connection pool (same one the retriever uses).
    max_turns:
        Maximum number of Q&A *pairs* to retain per session.  Each pair is
        two items in the turns list (user + assistant).
    ttl_seconds:
        Seconds of inactivity after which a cache entry is considered stale
        and eligible for eviction by ``cleanup()``.
    """

    def __init__(
        self,
        db_pool: asyncpg.Pool,
        max_turns: int = 10,
        ttl_seconds: int = 3600,
    ) -> None:
        self._pool = db_pool
        self._max_turns = max(1, int(max_turns))
        self._ttl = max(0, int(ttl_seconds))
        self._cache: Dict[_Key, _CacheEntry] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_history(
        self, meeting_id: int, user_id: int
    ) -> List[Dict[str, str]]:
        """
        Return the recent conversation turns for this session.

        Returns a list of dicts: ``[{"role": "user", "content": "..."}, ...]``
        ordered chronologically (oldest first).

        On cache miss the history is hydrated from the ``messages`` table.
        """
        key: _Key = (meeting_id, user_id)
        entry = self._cache.get(key)

        if entry is not None and not self._is_stale(entry):
            entry.last_access = time.monotonic()
            return list(entry.turns)  # defensive copy

        # Cache miss or stale — hydrate from DB.
        turns = await self._hydrate_from_db(meeting_id)
        self._cache[key] = _CacheEntry(
            turns=turns, last_access=time.monotonic()
        )
        return list(turns)

    def add_turn(
        self, meeting_id: int, user_id: int, question: str, answer: str
    ) -> None:
        """
        Append a Q&A pair to the in-memory cache.

        Does **not** write to the database — the meeting-service already
        persists both the user question and assistant answer to the
        ``messages`` table.
        """
        key: _Key = (meeting_id, user_id)
        entry = self._cache.get(key)
        if entry is None:
            entry = _CacheEntry(turns=[], last_access=time.monotonic())
            self._cache[key] = entry

        entry.turns.append({"role": "user", "content": question})
        entry.turns.append({"role": "assistant", "content": answer})
        entry.last_access = time.monotonic()

        # Trim to max_turns pairs (each pair = 2 items).
        max_items = self._max_turns * 2
        if len(entry.turns) > max_items:
            entry.turns = entry.turns[-max_items:]

    def cleanup(self) -> int:
        """
        Evict stale cache entries.  Returns the number of entries removed.

        Called periodically by the background cleanup task in ``service.py``.
        """
        now = time.monotonic()
        stale_keys = [
            k for k, v in self._cache.items()
            if (now - v.last_access) > self._ttl
        ]
        for k in stale_keys:
            del self._cache[k]
        if stale_keys:
            logger.info(
                "ConversationMemory: evicted %d stale entries", len(stale_keys)
            )
        return len(stale_keys)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _is_stale(self, entry: _CacheEntry) -> bool:
        return (time.monotonic() - entry.last_access) > self._ttl

    async def _hydrate_from_db(self, meeting_id: int) -> List[Dict[str, str]]:
        """
        Read the most recent turns from the ``messages`` table.

        The query fetches ``max_turns * 2`` rows (each Q&A pair = 2 rows)
        ordered newest-first, then reverses so the caller gets chronological
        order.
        """
        limit = self._max_turns * 2
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT role, content
                    FROM messages
                    WHERE chat_id = $1
                    ORDER BY date DESC
                    LIMIT $2
                    """,
                    int(meeting_id),
                    limit,
                )
        except Exception:
            logger.exception(
                "ConversationMemory: failed to hydrate from DB for "
                "meeting_id=%s",
                meeting_id,
            )
            return []

        # Reverse so oldest is first (chronological).
        turns = [
            {"role": str(r["role"]), "content": str(r["content"])}
            for r in reversed(rows)
        ]
        logger.info(
            "ConversationMemory: hydrated %d turns from DB for meeting_id=%s",
            len(turns),
            meeting_id,
        )
        return turns
