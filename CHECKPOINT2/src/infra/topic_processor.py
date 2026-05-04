"""
topic_processor.py
------------------
The 5-minute topic-extraction orchestrator.

One ``TopicProcessor`` instance is created per meeting. The chunker hands it
``PersistedChunk`` objects (already in Postgres, with assigned UUIDs) as soon
as each chunking-window flush completes. The processor groups them into
non-overlapping 5-minute windows on the ASR audio timeline; whenever the
last received chunk's ``end`` time crosses a window boundary, the closed
window is dispatched to Gemini for topic extraction.

Window boundaries are anchored to the *first* chunk's ``start`` time, not to
wall-clock time. This matches the plan's "audio-time, ASR timeline"
requirement and means a long mid-session silence does not trigger a flush
on its own — the boundary only advances when new audio actually fills the
window.

Flow per closed window
----------------------
1. Snapshot the chunks that belong to the window.
2. Fetch existing topics + embeddings for the meeting.
3. Ask Gemini for ``GeneratedTopicList`` (subject to its Pydantic schema).
4. Drop any chunk_ids Gemini invented (must be subset of input).
5. Embed each generated topic string with the shared BGE-M3 singleton.
6. For each generated topic, find the best existing-topic cosine match.
   If best ≥ ``TOPIC_SIMILARITY_THRESHOLD`` → ``merge_chunk_ids``.
   Otherwise → ``insert_topic``. Newly inserted topics become "existing"
   for subsequent generated topics in the same window so two near-duplicate
   topics from one Gemini call still collapse.

Concurrency
-----------
``add_persisted_chunks`` schedules ``_process_window`` as a fire-and-forget
task so the chunker's flush path is never blocked on Gemini latency. An
``asyncio.Lock`` serializes window processing for the meeting so a slow
Gemini call cannot overlap with the next window's call and produce
near-duplicate inserts.

``flush(force=True)`` awaits in-flight work plus the trailing partial
window — this is what the WebSocket-close handler calls so no chunks are
lost when a session ends.
"""
from __future__ import annotations

import asyncio
import logging
import math
from typing import List, Optional, Tuple

import asyncpg

from src.core.topic_models import (
    ExistingTopicSummary,
    GeneratedTopic,
    PersistedChunk,
)
from src.infra.embeddings import embed_texts_async
from src.infra.gemini_client import GeminiTopicClient
from src.infra.topic_store import TopicStore

logger = logging.getLogger(__name__)


def _cosine(a: List[float], b: List[float]) -> float:
    """Cosine similarity between two equal-length vectors. 0.0 on degeneracy."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


class TopicProcessor:
    """
    Per-meeting topic-extraction orchestrator.

    Parameters
    ----------
    meeting_id : int
        Row ID of the meeting in the main app DB.
    db_pool : asyncpg.Pool
        Shared connection pool for the worker.
    gemini_client : GeminiTopicClient
        Pre-built Gemini wrapper. The processor does not own its lifecycle.
    window_seconds : float
        Width of each non-overlapping topic window on the audio timeline.
    similarity_threshold : float
        Cosine threshold above which a generated topic is merged into the
        best matching existing topic instead of being inserted as new.
    """

    def __init__(
        self,
        meeting_id: int,
        db_pool: asyncpg.Pool,
        gemini_client: GeminiTopicClient,
        window_seconds: float,
        similarity_threshold: float,
    ) -> None:
        self._meeting_id = meeting_id
        self._store = TopicStore(db_pool)
        self._gemini = gemini_client
        self._window_seconds = float(window_seconds)
        self._threshold = float(similarity_threshold)

        # Audio-time anchor for the current window. None until the first
        # chunk arrives.
        self._window_start: Optional[float] = None

        # Buffer of chunks belonging to the active (still-open) window.
        self._pending: List[PersistedChunk] = []

        # Serializes window processing for this meeting so a slow Gemini
        # call cannot overlap with the next window's call.
        self._lock = asyncio.Lock()

        # Tracks every fire-and-forget window task so flush() can await them.
        self._inflight: set[asyncio.Task] = set()

    # ------------------------------------------------------------------
    # Public API — called from the chunker
    # ------------------------------------------------------------------

    async def add_persisted_chunks(self, chunks: List[PersistedChunk]) -> None:
        """
        Ingest chunks that have just been written to ``meeting_chunks``.
        Schedules window processing whenever a 5-minute boundary is crossed.

        ``await``-able because we may need to schedule multiple windows in a
        row (e.g. the chunker flushed a backlog spanning >5 minutes); the
        scheduling itself is non-blocking.
        """
        print(f"[DEBUG TopicProcessor] add_persisted_chunks called with {len(chunks)} chunks")
        if not chunks:
            return

        for chunk in chunks:
            if self._window_start is None:
                self._window_start = chunk.start
            self._pending.append(chunk)

            # A window closes when the latest chunk's END crosses the
            # boundary — using ``end`` (not ``start``) makes sure we don't
            # short-flush on a chunk that straddles the boundary.
            window_end = self._window_start + self._window_seconds
            if chunk.end >= window_end:
                print(f"[DEBUG TopicProcessor] chunk.end ({chunk.end}) >= window_end ({window_end}). Closing window.")
                self._close_current_window(window_end)

    async def flush(self) -> None:
        """
        Drain everything: the trailing partial window (if any), then await
        every in-flight window task. Called on WebSocket / session close.
        """
        print("[DEBUG TopicProcessor] flush called")
        # Final partial window — if there's any pending chunk, push it as a
        # forced close regardless of the audio-time boundary.
        if self._pending:
            print(f"[DEBUG TopicProcessor] flush forcing close of partial window with {len(self._pending)} chunks")
            self._close_current_window(window_end=None)

        # Await all scheduled window tasks. We snapshot first because tasks
        # remove themselves from ``_inflight`` on completion via the
        # done-callback; iterating the live set would race.
        pending = list(self._inflight)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    # ------------------------------------------------------------------
    # Internal: window scheduling
    # ------------------------------------------------------------------

    def _close_current_window(self, window_end: Optional[float]) -> None:
        """
        Move chunks belonging to the closing window into a snapshot, advance
        the window anchor, and schedule ``_process_window`` as a task.

        ``window_end`` is None for a forced flush (final partial window).
        """
        print(f"[DEBUG TopicProcessor] _close_current_window called with window_end={window_end}, pending={len(self._pending)}")
        if not self._pending:
            return

        if window_end is None:
            # Forced flush: take everything pending, leave nothing behind.
            window_chunks = self._pending
            leftover: List[PersistedChunk] = []
        else:
            # A chunk belongs to the closing window iff its start time is
            # before the boundary. A chunk that starts exactly on the
            # boundary or later belongs to the next window.
            window_chunks = [c for c in self._pending if c.start < window_end]
            leftover = [c for c in self._pending if c.start >= window_end]

        if not window_chunks:
            # All pending chunks have advanced past the boundary already
            # (rare, but possible if we got a single chunk that is itself
            # longer than the window). Reset anchor to the first leftover
            # so we don't lose it.
            self._pending = leftover
            self._window_start = leftover[0].start if leftover else None
            return

        # Advance the anchor to the next window's start. For a forced flush
        # the anchor goes back to None (the meeting is ending anyway).
        if window_end is None:
            self._window_start = None
        else:
            self._window_start = (
                leftover[0].start if leftover else window_end
            )
        self._pending = leftover

        task = asyncio.create_task(self._process_window(window_chunks))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    # ------------------------------------------------------------------
    # Internal: per-window processing
    # ------------------------------------------------------------------

    async def _process_window(self, window_chunks: List[PersistedChunk]) -> None:
        """
        Full pipeline for one closed window. Never raises.
        """
        async with self._lock:
            try:
                await self._process_window_locked(window_chunks)
            except Exception:
                logger.exception(
                    "TopicProcessor: unhandled error processing window of %d chunks "
                    "for meeting_id=%s",
                    len(window_chunks),
                    self._meeting_id,
                )

    async def _process_window_locked(
        self, window_chunks: List[PersistedChunk]
    ) -> None:
        print(f"[DEBUG TopicProcessor] _process_window_locked starting for {len(window_chunks)} chunks")
        valid_ids = {c.chunk_id for c in window_chunks}

        existing = await self._store.fetch_existing(self._meeting_id)
        existing_summary = [
            ExistingTopicSummary(topic_id=tid, topic=t) for tid, t, _ in existing
        ]

        result = await self._gemini.extract_topics(
            window_chunks=window_chunks,
            existing_topics=existing_summary,
        )
        if result is None or not result.topics:
            return

        # Filter: drop any chunk_id Gemini invented. Drop the whole topic if
        # none of its chunk_ids survive (it would be unattached).
        filtered: List[GeneratedTopic] = []
        for t in result.topics:
            valid_chunk_ids = [cid for cid in t.chunk_ids if cid in valid_ids]
            if not valid_chunk_ids or not t.topic.strip():
                continue
            filtered.append(GeneratedTopic(topic=t.topic.strip(), chunk_ids=valid_chunk_ids))
        if not filtered:
            return

        # Embed all generated topic strings in one batch.
        try:
            topic_embeddings = await embed_texts_async([t.topic for t in filtered])
        except Exception:
            logger.exception(
                "TopicProcessor: embedding generated topics failed for meeting_id=%s",
                self._meeting_id,
            )
            return

        # We mutate this list as we insert: a newly inserted topic becomes
        # an "existing" candidate for the remaining topics in this window,
        # so two near-duplicates emitted by the same Gemini call collapse.
        live: List[Tuple[int, str, List[float]]] = list(existing)

        for gen, gen_emb in zip(filtered, topic_embeddings):
            best_idx, best_sim = self._best_match(gen_emb, live)
            if best_idx is not None and best_sim >= self._threshold:
                topic_id, topic_text, _emb = live[best_idx]
                ok = await self._store.merge_chunk_ids(topic_id, gen.chunk_ids)
                if ok:
                    logger.info(
                        "TopicProcessor: merged %d chunk(s) into existing topic "
                        "%r (sim=%.3f) meeting_id=%s",
                        len(gen.chunk_ids),
                        topic_text,
                        best_sim,
                        self._meeting_id,
                    )
            else:
                new_id = await self._store.insert_topic(
                    meeting_id=self._meeting_id,
                    topic=gen.topic,
                    chunk_ids=gen.chunk_ids,
                    embedding=gen_emb,
                )
                if new_id is not None:
                    # Becomes a candidate for the rest of this window so
                    # near-duplicate topics emitted in the same Gemini call
                    # collapse into the just-inserted row.
                    live.append((new_id, gen.topic, gen_emb))
                    logger.info(
                        "TopicProcessor: inserted new topic %r (topic_id=%s) "
                        "meeting_id=%s",
                        gen.topic,
                        new_id,
                        self._meeting_id,
                    )

    @staticmethod
    def _best_match(
        query: List[float],
        candidates: List[Tuple[int, str, List[float]]],
    ) -> Tuple[Optional[int], float]:
        """Return (index, similarity) of the best candidate, or (None, 0.0)."""
        best_idx: Optional[int] = None
        best_sim = -1.0
        for i, (_id, _topic, emb) in enumerate(candidates):
            sim = _cosine(query, emb)
            if sim > best_sim:
                best_sim = sim
                best_idx = i
        if best_idx is None:
            return None, 0.0
        return best_idx, best_sim
