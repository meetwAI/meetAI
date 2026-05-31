"""
qa/retriever.py
---------------
Step 2 of the QA pipeline: turn a user question + extracted hints into the
top-K transcript chunks that will be fed to the answer LLM.

Approach: "treat chunk + topic as one object"
---------------------------------------------
Each chunk carries its own 1024-d BGE-M3 embedding; each topic carries the
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

from src.embedder.embeddings import EMBED_DIM, embed_texts_async
from src.qa.models import ExtractedQuestion, RetrievedChunk, TimeRange

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


def _encode_vector(values: Sequence[float]) -> str:
    """Render a 1024-d vector for pgvector's text-input format."""
    return "[" + ",".join(f"{v:.8f}" for v in values) + "]"


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
        t.embedding AS topic_emb,
        1 - (t.embedding <=> q.qv) AS topic_sim
    FROM meeting_topics t, q
    WHERE t.meeting_id = $2
      AND t.embedding IS NOT NULL
      AND t.chunk_ids IS NOT NULL
      AND array_length(t.chunk_ids, 1) > 0
    ORDER BY t.embedding <=> q.qv
    LIMIT $3
),
candidate_chunks AS (
    SELECT
        c.chunk_id,
        c.text,
        c.speakers,
        c.start_time,
        c.end_time,
        c.embedding AS chunk_emb,
        t.topic_id,
        t.topic,
        t.topic_emb
    FROM top_topics t
    JOIN meeting_chunks c ON c.chunk_id = ANY(t.chunk_ids)
    WHERE c.meeting_id = $2
      AND c.embedding IS NOT NULL
      {speaker_clause}
      {time_clause}
)
SELECT
    chunk_id,
    text,
    speakers,
    start_time,
    end_time,
    topic_id,
    topic,
    1 - ((chunk_emb + topic_emb) <=> (SELECT qv FROM q)) AS fused_score
FROM candidate_chunks
ORDER BY fused_score DESC
LIMIT {chunk_limit_placeholder};
"""

_FALLBACK_SQL_TEMPLATE = """
WITH q AS (
    SELECT $1::vector AS qv
),
candidate_chunks AS (
    SELECT
        c.chunk_id,
        c.text,
        c.speakers,
        c.start_time,
        c.end_time,
        c.embedding AS chunk_emb
    FROM meeting_chunks c
    WHERE c.meeting_id = $2
      AND c.embedding IS NOT NULL
      {speaker_clause}
      {time_clause}
)
SELECT
    chunk_id,
    text,
    speakers,
    start_time,
    end_time,
    NULL::bigint AS topic_id,
    NULL::text AS topic,
    1 - (chunk_emb <=> (SELECT qv FROM q)) AS fused_score
FROM candidate_chunks
ORDER BY fused_score DESC
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
    ) -> None:
        self._pool = db_pool
        self._topic_limit = int(topic_limit)
        self._chunk_limit = int(chunk_limit)

    async def retrieve(
        self,
        meeting_id: int,
        question: str,
        hints: Optional[ExtractedQuestion] = None,
    ) -> List[RetrievedChunk]:
        """
        Return the top-K chunks for ``question`` in ``meeting_id``, ordered
        by fused (chunk + topic) similarity. Empty list when the meeting has
        no topics yet, or when the hints filter out every candidate.
        """
        text = (question or "").strip()
        if not text:
            return []

        # 1) Embed the question. One element batch — local mode runs inline,
        #    service mode does one HTTP round-trip.
        vectors = await embed_texts_async([text])
        if not vectors or len(vectors[0]) != EMBED_DIM:
            raise RuntimeError(
                f"Question embedding had unexpected shape: "
                f"{len(vectors)} vectors, dim {len(vectors[0]) if vectors else 0}"
            )
        q_vector = _encode_vector(vectors[0])

        hints = hints or ExtractedQuestion()
        speakers = _normalise_speakers(hints.speakers)

        # 2) Splice in the optional clauses. We hold our parameter indices
        #    explicitly so the time-range builder doesn't have to guess.
        params: list = [q_vector, int(meeting_id), self._topic_limit]
        next_idx = 4  # next available $N

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

        sql = _BASE_SQL_TEMPLATE.format(
            speaker_clause=speaker_clause,
            time_clause=time_clause,
            chunk_limit_placeholder=f"${chunk_limit_idx}",
        )
        
        fallback_sql = _FALLBACK_SQL_TEMPLATE.format(
            speaker_clause=speaker_clause,
            time_clause=time_clause,
            chunk_limit_placeholder=f"${chunk_limit_idx}",
        )

        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(sql, *params)
                if not rows:
                    logger.info("No chunks found using topic fusion. Falling back to simple chunk retrieval for meeting_id=%s", meeting_id)
                    rows = await conn.fetch(fallback_sql, *params)
        except Exception:
            logger.exception(
                "QARetriever: SQL failed for meeting_id=%s (speakers=%s, "
                "time_ranges=%d)",
                meeting_id,
                speakers,
                len(hints.time_ranges),
            )
            raise

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
