"""
qa/retriever.py
---------------
Step 2 of the QA pipeline: turn a user question + extracted hints into the
top-K transcript chunks that will be fed to the answer LLM.

Approach: "treat chunk + topic as one object"
---------------------------------------------
Each chunk carries its own EMBED_DIM-d embedding; each topic carries the
mean-ish embedding of the topic phrase Gemini produced for the window it
came from. We add those two vectors together, then cosine-compare the sum
against the question embedding. The intuition the user asked for: a vague
chunk that wouldn't rank on its own can still rank if its topic vector
points at the question — the topic acts as a contextual booster, not a
hard filter.

Pipeline per question
---------------------
1. Embed the question (one HTTP call to the embedder microservice if
   ``EMBED_SERVICE_URL`` is set, local MLX otherwise).
2. Run a single SQL statement that:
     - picks the top-N topics by cosine-similarity of topic.embedding vs the
       question embedding, scoped to ``meeting_id``;
     - joins those topics' ``chunk_ids`` arrays back to ``meeting_chunks``
       (also scoped to ``meeting_id``, plus optional speaker / time-range
       filters from ``ExtractedQuestion``);
     - computes the fused score 1 - cosine_distance(chunk_emb + topic_emb,
       question_emb) for each candidate;
     - returns the top-K chunks ordered by that fused score.
3. Map the rows to ``RetrievedChunk`` objects.

Why one SQL statement (CTE) and not two round-trips
---------------------------------------------------
pgvector exposes ``+`` (element-wise vector addition) and ``<=>`` (cosine
distance) as native operators, so the fused score is computable in-DB. The
alternative — fetch top-N topics, then a second query for chunks, then sum
in Python — would round-trip twice and would still need to push the
question vector down for the chunk-side ranking. One CTE is faster, simpler,
and keeps all of pgvector's index-friendly path inside the database.

Failure mode
------------
Any DB exception is logged and re-raised. The QA server turns it into an SSE
``error`` event the client can render — there is no useful "empty answer"
fallback when retrieval itself broke.
"""
from __future__ import annotations

import logging
from typing import List, Optional, Sequence

import asyncpg
import asyncio

from aiengine.config.settings import settings
from aiengine.embedder.embeddings import EMBED_DIM, embed_texts_async
from aiengine.qa.models import ExtractedQuestion, RetrievedChunk, TimeRange

logger = logging.getLogger(__name__)


# Defaults tuned for a typical 30-60 minute meeting:
#   - 3 topics covers most "what did we say about X" questions; the relevant
#     window usually maps to 1-2 topics, the third is insurance against
#     near-duplicate-topic drift.
#   - 8 chunks fits comfortably in the answer LLM's prompt (each chunk is
#     ~30-60s of speech, ~100-200 tokens) without spending too much budget on
#     low-relevance tail chunks.
DEFAULT_TOPIC_LIMIT = 1
DEFAULT_CHUNK_LIMIT = 4
DEFAULT_CHUNK_WEIGHT = 0.7
DEFAULT_TOPIC_WEIGHT = 0.3


# Encode helper lives in aiengine.embedder.vector_utils so precision and
# parsing semantics stay in lock-step with store/topics.py.
from aiengine.embedder.vector_utils import encode_vector as _encode_vector  # noqa: E402


def _normalise_speakers(speakers: Sequence[str]) -> List[str]:
    """
    Lowercase + trim, drop empties and dups while preserving order.
    The extractor already lowercases, but the chunk-store's ``speakers``
    column can hold mixed casing depending on the diarization label, so we
    push case-folding into the SQL via ``LOWER(unnest(...))`` rather than
    relying on the data being normalised at write time.
    """
    seen: set[str] = set()
    out: List[str] = []
    for s in speakers:
        n = (s or "").strip().lower()
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _build_time_clause(
    time_ranges: Sequence[TimeRange], param_offset: int
) -> tuple[str, list[float | None]]:
    """
    Build an OR-of-ranges clause for chunk timestamps.

    Semantics: a chunk matches if it overlaps ANY of the requested ranges.
    Overlap rule for [chunk.start, chunk.end] vs [r.start, r.end]:
        chunk.end   >= r.start  (or r.start IS NULL)
        chunk.start <= r.end    (or r.end   IS NULL)

    Returns (clause_sql, params). ``param_offset`` is the index of the next
    placeholder (e.g. 4 means the first placeholder we emit is ``$4``).
    """
    if not time_ranges:
        return "", []

    parts: list[str] = []
    params: list[float | None] = []
    idx = param_offset
    for tr in time_ranges:
        # Each range contributes (start_ok AND end_ok). Both placeholders are
        # nullable and the SQL collapses NULL into "no bound on that side".
        parts.append(
            f"(c.end_time >= COALESCE(${idx}, c.end_time) "
            f"AND c.start_time <= COALESCE(${idx + 1}, c.start_time))"
        )
        params.append(tr.start)
        params.append(tr.end)
        idx += 2
    return "(" + " OR ".join(parts) + ")", params


# Built once and parameterised. Filters that depend on the extracted hints
# are spliced in below — Postgres caches the prepared statement per shape.
_BASE_SQL_TEMPLATE = """
WITH q AS (
    SELECT $1::vector AS qv
),
top_topics AS (
    SELECT
        t.topic_id,
        t.topic,
        t.chunk_ids,
        -- We only need the scalar similarity score now, not the vector!
        1 - (t.embedding <=> q.qv) AS topic_sim
    FROM meeting_topics t, q
    WHERE t.meeting_id = $2
      AND t.embedding IS NOT NULL
      AND t.chunk_ids IS NOT NULL
      AND array_length(t.chunk_ids, 1) > 0
    ORDER BY t.embedding <=> q.qv
    LIMIT $3
),
topic_candidates AS (
    SELECT
        c.chunk_id,
        c.text,
        c.speakers,
        c.start_time,
        c.end_time,
        t.topic_id,
        t.topic,
        -- Score-level fusion: (Chunk Weight * Chunk Sim) + (Topic Weight * Topic Sim)
        ($5::float * (1 - (c.embedding <=> (SELECT qv FROM q)))) + ($6::float * t.topic_sim) AS fused_score
    FROM top_topics t
    JOIN meeting_chunks c ON c.chunk_id = ANY(t.chunk_ids)
    WHERE c.meeting_id = $2
      AND c.embedding IS NOT NULL
      {speaker_clause}
      {time_clause}
),
{recent_candidates_cte}
ranked_candidates AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY chunk_id
            ORDER BY fused_score DESC, topic_id NULLS LAST
        ) AS rn
    FROM (
        SELECT * FROM topic_candidates
        {recent_candidates_union}
    ) candidates
)
SELECT
    chunk_id,
    text,
    speakers,
    start_time,
    end_time,
    topic_id,
    topic,
    fused_score
FROM ranked_candidates
WHERE rn = 1
ORDER BY fused_score DESC
LIMIT {chunk_limit_placeholder};
"""

# Injected into _BASE_SQL_TEMPLATE only when there is no time-range filter.
# When the user scoped their question to a specific window we trust the topic
# search to cover it; when they asked an open question we always pull the last
# TOPIC_WINDOW_SECONDS of chunks too so very recent speech (not yet
# topic-indexed) is never invisible to the retriever.
_RECENT_CANDIDATES_CTE_TEMPLATE = """recent_candidates AS (
    SELECT
        c.chunk_id,
        c.text,
        c.speakers,
        c.start_time,
        c.end_time,
        NULL::bigint AS topic_id,
        NULL::text   AS topic,
        1 - (c.embedding <=> (SELECT qv FROM q)) AS fused_score
    FROM meeting_chunks c
    WHERE c.meeting_id = $2
      AND c.embedding IS NOT NULL
      AND c.end_time::float >= GREATEST($7::float - $4::float, 0.0)
      {speaker_clause}
      {time_clause}
),"""

_METADATA_SQL_TEMPLATE = """
SELECT
    c.chunk_id,
    c.text,
    c.speakers,
    c.start_time,
    c.end_time,
    NULL::bigint AS topic_id,
    NULL::text AS topic,
    1.0::float AS fused_score
FROM meeting_chunks c
WHERE c.meeting_id = $1
  {speaker_clause}
  {time_clause}
ORDER BY c.start_time ASC NULLS LAST, c.chunk_id ASC
LIMIT {chunk_limit_placeholder};
"""


class QARetriever:
    """
    Stateless retriever — one instance per QA service, reused across every
    request. Holds the asyncpg pool reference; everything else lives in the
    function arguments.
    """

    def __init__(
        self,
        db_pool: asyncpg.Pool,
        topic_limit: int = DEFAULT_TOPIC_LIMIT,
        chunk_limit: int = DEFAULT_CHUNK_LIMIT,
        recent_window_seconds: float = settings.TOPIC_WINDOW_SECONDS,
        chunk_weight: float = DEFAULT_CHUNK_WEIGHT,
        topic_weight: float = DEFAULT_TOPIC_WEIGHT,
    ) -> None:
        self._pool = db_pool
        self._topic_limit = int(topic_limit)
        self._chunk_limit = int(chunk_limit)
        self._recent_window_seconds = float(recent_window_seconds)
        self._chunk_weight = float(chunk_weight)
        self._topic_weight = float(topic_weight)

    async def retrieve(
        self,
        meeting_id: int,
        question: str,
        hints: Optional[ExtractedQuestion] = None,
        current_duration: Optional[float] = None,
    ) -> List[RetrievedChunk]:
        """
        Return the top-K chunks for ``question`` in ``meeting_id``, ordered
        by fused (chunk + topic) similarity. Empty list when the meeting has
        no topics yet, or when the hints filter out every candidate.
        """
        text = (question or "").strip()
        if not text:
            return []

        hints = hints or ExtractedQuestion()
        speakers = _normalise_speakers(hints.speakers)
        if hints.metadata_only:
            return await self._retrieve_metadata_only(
                meeting_id, hints, speakers, chunk_limit=self._chunk_limit
            )

        # 1) Embed the question. One element batch — local mode runs inline,
        #    service mode does one HTTP round-trip.

        try:
            async with asyncio.timeout(10.0):  # 10-second hard ceiling for embedder service
                vectors = await embed_texts_async([text])
        except TimeoutError:
            logger.error("QA pipeline failed: Embedding microservice timed out.")
            raise RuntimeError("Embedding service unavailable")
        if not vectors or len(vectors[0]) != EMBED_DIM:
            raise RuntimeError(
                f"Question embedding had unexpected shape: "
                f"{len(vectors)} vectors, dim {len(vectors[0]) if vectors else 0}"
            )
        q_vector = _encode_vector(vectors[0])

        # 2) Splice in the optional clauses. We hold our parameter indices
        #    explicitly so the time-range builder doesn't have to guess.
        #    Fixed params:
        #      $1 q_vector  $2 meeting_id  $3 topic_limit  $4 recent_window_seconds
        #      $5 chunk_weight  $6 topic_weight  $7 current_duration
        params: list = [
            q_vector,
            int(meeting_id),
            self._topic_limit,
            self._recent_window_seconds,
            self._chunk_weight,
            self._topic_weight,
            float(current_duration) if current_duration is not None else 0.0,
        ]
        next_idx = 8  # next available $N

        speaker_clause = ""
        if speakers:
            speaker_clause = (
                f"AND EXISTS ("
                f"  SELECT 1 FROM unnest(c.speakers) s "
                f"  WHERE LOWER(s) = ANY(${next_idx}::text[])"
                f")"
            )
            params.append(speakers)
            next_idx += 1

        time_clause, time_params = _build_time_clause(hints.time_ranges, next_idx)
        if time_clause:
            time_clause = f"AND {time_clause}"
            params.extend(time_params)
            next_idx += len(time_params)

        # The chunk-limit goes last so its placeholder index is dynamic.
        chunk_limit_idx = next_idx
        params.append(self._chunk_limit)

        # Recent chunks are always included — they capture content that hasn't
        # been topic-indexed yet (e.g. the last few minutes of a live meeting).
        # When a time filter is present we apply it here too, so we only pull
        # recent chunks that actually fall inside the requested window.
        recent_candidates_cte = _RECENT_CANDIDATES_CTE_TEMPLATE.format(
            speaker_clause=speaker_clause,
            time_clause=time_clause,
        )
        recent_candidates_union = "UNION ALL\n        SELECT * FROM recent_candidates"

        sql = _BASE_SQL_TEMPLATE.format(
            speaker_clause=speaker_clause,
            time_clause=time_clause,
            recent_candidates_cte=recent_candidates_cte,
            recent_candidates_union=recent_candidates_union,
            chunk_limit_placeholder=f"${chunk_limit_idx}",
        )

        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(sql, *params)
        except Exception:
            logger.exception(
                "QARetriever: SQL failed for meeting_id=%s (speakers=%s, "
                "time_ranges=%d)",
                meeting_id,
                speakers,
                len(hints.time_ranges),
            )
            raise

        return _rows_to_chunks(rows)

    async def _retrieve_metadata_only(
        self,
        meeting_id: int,
        hints: ExtractedQuestion,
        speakers: Sequence[str],
        *,
        chunk_limit: int,
    ) -> List[RetrievedChunk]:
        """
        Return chronological chunks using only metadata filters.

        This deliberately avoids embedding pure recency/speaker questions;
        there is no semantic signal to gain from phrases like "last 5 minutes".
        """
        params: list = [int(meeting_id)]
        next_idx = 2

        speaker_clause = ""
        if speakers:
            speaker_clause = (
                f"AND EXISTS ("
                f"  SELECT 1 FROM unnest(c.speakers) s "
                f"  WHERE LOWER(s) = ANY(${next_idx}::text[])"
                f")"
            )
            params.append(list(speakers))
            next_idx += 1

        time_clause, time_params = _build_time_clause(hints.time_ranges, next_idx)
        if time_clause:
            time_clause = f"AND {time_clause}"
            params.extend(time_params)
            next_idx += len(time_params)

        chunk_limit_idx = next_idx
        params.append(int(chunk_limit))

        sql = _METADATA_SQL_TEMPLATE.format(
            speaker_clause=speaker_clause,
            time_clause=time_clause,
            chunk_limit_placeholder=f"${chunk_limit_idx}",
        )

        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(sql, *params)
        except Exception:
            logger.exception(
                "QARetriever: metadata SQL failed for meeting_id=%s "
                "(speakers=%s, time_ranges=%d)",
                meeting_id,
                list(speakers),
                len(hints.time_ranges),
            )
            raise

        return _rows_to_chunks(rows)


def _rows_to_chunks(rows) -> List[RetrievedChunk]:
    """Map asyncpg rows from any QA retrieval path into RetrievedChunk."""
    results: List[RetrievedChunk] = []
    for r in rows:
        results.append(
            RetrievedChunk(
                chunk_id=int(r["chunk_id"]),
                text=str(r["text"]),
                speakers=list(r["speakers"] or []),
                start_time=(
                    float(r["start_time"]) if r["start_time"] is not None else None
                ),
                end_time=(
                    float(r["end_time"]) if r["end_time"] is not None else None
                ),
                topic_id=(
                    int(r["topic_id"]) if r["topic_id"] is not None else None
                ),
                topic=(
                    str(r["topic"]) if r["topic"] is not None else None
                ),
                fused_score=float(r["fused_score"]),
            )
        )
    return results
