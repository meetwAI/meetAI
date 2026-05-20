"""
transcription_chunker.py
------------------------
Chunks committed ASRTokens into rows destined for the `meeting_chunks` table.

Rules
-----
- Operates on audio time (token.end), not wall-clock time.
- Flushes every WINDOW_SECONDS (default 30 s) of audio time.
- Each flushed window is then split into sub-chunks of at most MAX_TOKENS
  tiktoken tokens (cl100k_base).
- Splits happen only at sentence boundaries (never mid-sentence).
- If a single sentence exceeds MAX_TOKENS it is emitted as its own chunk
  (unavoidable — we never split mid-sentence).
- No overlapping tokens between chunks.
- Text format: "speaker_N: <words>" with a newline between speakers.
  Speaker id -1 (unknown) is rendered as "speaker_unknown".

Persistence
-----------
After every window flush, chunks are embedded with BAAI/bge-m3 and written
to the `meeting_chunks` Postgres table via ChunkStore.  All I/O is async and
failures are silently logged — they must never crash the pipeline.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Callable, List, Optional, Union

from src.core.chunk_models import _Sentence
from src.core.config import settings
from src.core.timed_objects import ASRToken
from src.infra.chunk_store import ChunkStore
from src.infra.gemini_client import GeminiTopicClient
from src.app.topic_processor import TopicProcessor
from src.app.pipeline.text_segmenter import TextSegmenter, _speaker_label

logger = logging.getLogger(__name__)

WINDOW_SECONDS: float = settings.CHUNKING_WINDOW_SECONDS
MAX_TOKENS: int = settings.MAX_CHUNK_TOKENS
MIN_TOKENS: int = settings.MIN_CHUNK_TOKENS
ENCODING_NAME: str = settings.CHUNKER_ENCODER


class TranscriptionChunker:
    """
    Feed committed ASRTokens via ``add_tokens()``.
    Call ``flush()`` at session end to emit any remaining tokens.
    Retrieve produced chunks via ``chunks`` or ``to_json()``.

    Parameters
    ----------
    tokenizer :
        The sentence-tokenizer callable from ``asr.tokenizer`` —
        accepts a string (or list of strings) and returns a list of sentence
        strings.  Pass ``None`` to fall back to punctuation-based splitting.
    window_seconds :
        How many seconds of audio time accumulate before an automatic flush.
    max_tokens :
        Maximum tiktoken token count per output chunk.
    meeting_id :
        Row ID of the meeting in the main app DB.
    user_id :
        Row ID of the user in the main app DB.
    db_pool :
        asyncpg connection pool shared across the worker process.
        If ``None``, persistence is skipped (useful in tests).
    """

    def __init__(
        self,
        tokenizer: Optional[Callable] = None,
        window_seconds: float = WINDOW_SECONDS,
        max_tokens: int = MAX_TOKENS,
        min_tokens: int = MIN_TOKENS,
        meeting_id: int = 0,
        user_id: int = 0,
        db_pool=None,
    ) -> None:
        self._window_seconds = window_seconds
        # Sub-chunks below this token count are NOT emitted on a normal
        # window flush — their underlying ASR tokens are rolled back into
        # ``_pending`` so they ride the next window's flush. A forced flush
        # (session close) bypasses this rule so trailing data is never lost.
        self._min_tokens = max(0, int(min_tokens))

        self._segmenter = TextSegmenter(
            tokenizer=tokenizer,
            max_tokens=max_tokens,
            encoding_name=ENCODING_NAME,
        )

        # Pending committed tokens not yet flushed into a chunk
        self._pending: List[ASRToken] = []

        # Audio-time anchor for the current 30 s window
        self._window_start: Optional[float] = None

        # Accumulated output — only ever appended to, never cleared
        self.chunks: List[dict] = []
        self._chunk_counter: int = 0

        # Persistence — only active when a pool is provided
        self._store: Optional[ChunkStore] = None
        self._topic_processor: Optional[TopicProcessor] = None
        if db_pool is not None and meeting_id and user_id:
            self._store = ChunkStore(
                meeting_id=meeting_id,
                user_id=user_id,
                db_pool=db_pool,
            )
            # Topic extraction is layered on top of chunk persistence. We
            # only build the TopicProcessor when the kill switch is on AND
            # a Gemini API key is configured — without the key the SDK will
            # fail every call, so it's better to skip the layer cleanly.
            if (
                settings.TOPIC_EXTRACTION_ENABLED
                and settings.GEMINI_API_KEY.strip()
            ):
                print(f"[DEBUG TranscriptionChunker] Topic extraction enabled, initializing TopicProcessor for meeting_id={meeting_id}")
                gemini_client = GeminiTopicClient(
                    api_key=settings.GEMINI_API_KEY,
                    model=settings.GEMINI_MODEL,
                )
                self._topic_processor = TopicProcessor(
                    meeting_id=meeting_id,
                    db_pool=db_pool,
                    gemini_client=gemini_client,
                    window_seconds=settings.TOPIC_WINDOW_SECONDS,
                    similarity_threshold=settings.TOPIC_SIMILARITY_THRESHOLD,
                )
            elif settings.TOPIC_EXTRACTION_ENABLED:
                logger.warning(
                    "Topic extraction is enabled but GEMINI_API_KEY is empty; "
                    "topic layer disabled for meeting_id=%s",
                    meeting_id,
                )
                print(f"[DEBUG TranscriptionChunker] Topic extraction enabled BUT missing GEMINI_API_KEY for meeting_id={meeting_id}")
            else:
                print(f"[DEBUG TranscriptionChunker] Topic extraction disabled via settings for meeting_id={meeting_id}")

        # Tracks every fire-and-forget flush task so the final ``flush()``
        # can await them. Without this the worker can pop the pipeline
        # before the last chunk-persist + topic-extract round-trip
        # completes, dropping the trailing data.
        self._inflight: set[asyncio.Task] = set()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add_tokens(self, tokens: List[ASRToken]) -> None:
        """
        Ingest newly committed tokens.

        Triggers a window flush automatically when the latest token's end
        time crosses the 30 s boundary.  The flush is scheduled as an async
        task so it never blocks the caller.
        """
        if not tokens:
            return

        for token in tokens:
            if self._window_start is None:
                self._window_start = token.start
            self._pending.append(token)
            if token.end - self._window_start >= self._window_seconds:
                self._schedule_flush()

    async def flush(self) -> None:
        """
        Force-flush all remaining pending tokens AND wait for every
        scheduled chunk persist + topic-window task to complete.

        Must be called exactly once at session end (e.g. on WebSocket
        close). The await is what guarantees no chunks are lost when the
        worker pops the pipeline immediately afterwards.
        """
        if self._pending:
            self._schedule_flush(force=True)

        # Drain in-flight flush tasks. Snapshot first because tasks remove
        # themselves from ``_inflight`` via the done-callback.
        pending = list(self._inflight)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        # Final partial topic window — every chunk that was just persisted
        # has now reached the topic processor; tell it to drain.
        if self._topic_processor is not None:
            await self._topic_processor.flush()

    def to_json(self, indent: int = 2) -> str:
        """Return the full accumulated chunk list as a JSON string."""
        return json.dumps(self.chunks, ensure_ascii=False, indent=indent)

    # ------------------------------------------------------------------
    # Internal: schedule async flush without blocking add_tokens
    # ------------------------------------------------------------------

    def _schedule_flush(self, force: bool = False) -> None:
        """Schedule _async_flush as a fire-and-forget asyncio task."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop (e.g. in sync tests) — run synchronously and
            # skip the inflight bookkeeping; there's nothing to await.
            asyncio.run(self._async_flush(force=force))
            return

        task = loop.create_task(self._async_flush(force=force))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    async def _async_flush(self, force: bool = False) -> None:
        """
        Async pipeline: window-flush -> persist chunks -> hand persisted
        chunks to the topic processor.

        We always ``await`` the persist call before invoking the topic
        processor: the topic layer needs the DB-assigned UUIDs returned by
        ``ChunkStore.persist`` so it can write them into ``meeting_topics``.
        """
        new_chunks = self._flush_window(force=force)
        if not new_chunks or self._store is None:
            if not self._store:
                print("[DEBUG TranscriptionChunker] _async_flush: skipped persistence because _store is None")
            return

        persisted = await self._store.persist(new_chunks)
        print(f"[DEBUG TranscriptionChunker] _async_flush: persisted {len(persisted) if persisted else 0} chunks")
        if persisted and self._topic_processor is not None:
            print(f"[DEBUG TranscriptionChunker] _async_flush: sending {len(persisted)} chunks to topic processor")
            await self._topic_processor.add_persisted_chunks(persisted)
        elif self._topic_processor is None:
            print("[DEBUG TranscriptionChunker] _async_flush: skipping topic processor because it is None")

    # ------------------------------------------------------------------
    # Internal: window flush  (synchronous data manipulation only)
    # ------------------------------------------------------------------

    def _flush_window(self, force: bool = False) -> List[dict]:
        """
        Partition pending tokens into those belonging to the current window
        and those that spill into the next, process them into sub-chunks,
        advance the window anchor, and return the *newly emitted* chunks.
        """
        if not self._pending:
            return []

        window_end = (self._window_start or 0.0) + self._window_seconds

        if force:
            tokens_in_window = self._pending
            leftover: List[ASRToken] = []
        else:
            tokens_in_window = [t for t in self._pending if t.start < window_end]
            leftover = [t for t in self._pending if t.start >= window_end]

        if not tokens_in_window:
            return []

        sentence_groups = self._segmenter.tokens_to_sentence_groups(tokens_in_window)

        # MIN-tokens enforcement (skip on force=True so session-close never
        # loses data): if the last sub-chunk is too small, roll back the
        # tokens that produced it into ``leftover`` and drop that group from
        # the emit list. The next window's segmentation will see those
        # tokens as the prefix of a larger group.
        if (
            not force
            and self._min_tokens > 0
            and sentence_groups
        ):
            last_group = sentence_groups[-1]
            last_token_count = sum(s.token_count for s in last_group)
            if last_token_count < self._min_tokens:
                rollback_start = last_group[0].start
                rollback_tokens = [
                    t for t in tokens_in_window if t.start >= rollback_start
                ]
                if rollback_tokens:
                    sentence_groups = sentence_groups[:-1]
                    leftover = rollback_tokens + leftover

        if not sentence_groups:
            # Everything in this window rolled forward — keep state as-is
            # so the next add_tokens() can grow the buffer further.
            self._window_start = leftover[0].start if leftover else self._window_start
            self._pending = leftover
            return []

        before = len(self.chunks)
        for group in sentence_groups:
            self._emit_chunk(group)
        new_chunks = self.chunks[before:]

        # Advance window anchor
        if leftover:
            self._window_start = leftover[0].start
            self._pending = leftover
        else:
            self._window_start = None
            self._pending = []

        return new_chunks

    # ------------------------------------------------------------------
    # Internal: build and store a chunk dict
    # ------------------------------------------------------------------

    def _emit_chunk(self, sentence_group: List[_Sentence]) -> None:
        if not sentence_group:
            return

        self._chunk_counter += 1

        # Merge consecutive same-speaker sentences into a single line
        lines: List[str] = []
        current_speaker: Optional[int] = None
        current_words: List[str] = []

        def _commit_line() -> None:
            if current_words:
                lines.append(
                    f"{_speaker_label(current_speaker)}: {' '.join(current_words)}"
                )

        for sent in sentence_group:
            if sent.speaker != current_speaker:
                _commit_line()
                current_speaker = sent.speaker
                current_words = [sent.text]
            else:
                current_words.append(sent.text)
        _commit_line()

        full_text = "\n".join(lines)
        token_count = self._segmenter.count_tokens(full_text)

        # Preserve speaker order of appearance, deduplicated
        seen: set = set()
        speakers: List[str] = []
        for sent in sentence_group:
            label = _speaker_label(sent.speaker)
            if label not in seen:
                speakers.append(label)
                seen.add(label)

        self.chunks.append(
            {
                "text": full_text,
                "start": round(sentence_group[0].start, 3),
                "end": round(sentence_group[-1].end, 3),
                "speakers": speakers,
                "token_count": token_count,
            }
        )
