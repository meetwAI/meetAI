"""
qa/server.py
------------
The FastAPI app that ties the QA pipeline together and exposes it over SSE.

Endpoint
--------
``POST /qa`` with body ``{"meeting_id": int, "user_id": int, "question": str}``
returns ``text/event-stream`` with the following events, in order:

    event: meta
    data: {"chunks":[{chunk_id, topic_id, topic, fused_score, start_time, end_time, speakers}, ...],
           "hints":{"speakers":[...], "time_ranges":[...]}}

    event: delta
    data: {"text": "<token piece>"}        # zero or more times

    event: done
    data: {"answer": "<full concatenated text>"}

    event: error
    data: {"message": "<reason>"}          # at most once, replaces `done`

Why SSE and not plain chunked JSON
----------------------------------
Browsers parse SSE natively (EventSource and fetch()+ReadableStream both),
event names cleanly separate the meta/delta/done/error phases, and proxies
along the way (gateway, meeting-service) can copy bytes through without
parsing — they just need to disable response buffering.

Why one CTE-style flow per request, no concurrency
--------------------------------------------------
The pipeline is question-extract → retrieve → stream. Each step depends on
the previous one's output, so there is no parallelism to exploit. Keeping it
linear also makes the SSE event ordering trivial (meta is emitted before any
delta, done is emitted after the last delta).

Lifecycle
---------
- ``startup``: open the asyncpg pool; build the QuestionExtractor,
  QARetriever, AnswerStreamer singletons. Each is reused across every
  request — google-genai is connection-cheap, asyncpg pool is shared.
- ``shutdown``: close the pool.
"""
from __future__ import annotations

import json
import logging
import re
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from src.core.config import settings
from src.infra.db import create_pool, close_pool
from src.qa.answer_streamer import AnswerStreamer, StreamError
from src.qa.models import QARequest, RetrievedChunk
from src.qa.question_extractor import QuestionExtractor
from src.qa.retriever import QARetriever

logger = logging.getLogger(__name__)

app = FastAPI(title="meetAI QA service", version="1.0")

# Module-level singletons populated by the startup hook. We avoid passing
# them through ``request.app.state`` so the type checker can see them and
# unit tests can monkeypatch directly.
_db_pool = None
_extractor: QuestionExtractor | None = None
_retriever: QARetriever | None = None
_streamer: AnswerStreamer | None = None


@app.on_event("startup")
async def _startup() -> None:
    global _db_pool, _extractor, _retriever, _streamer

    _db_pool = await create_pool(settings.DATABASE_URL)
    _extractor = QuestionExtractor(
        api_key=settings.GEMINI_API_KEY,
        model=settings.GEMINI_MODEL,
    )
    _retriever = QARetriever(_db_pool)
    _streamer = AnswerStreamer(
        api_key=settings.GEMINI_API_KEY,
        model=settings.GEMINI_MODEL,
    )
    import socket
    logger.info("QA service ready (model=%s) (hosted on %s)", settings.GEMINI_MODEL, socket.gethostname())


@app.on_event("shutdown")
async def _shutdown() -> None:
    global _db_pool
    if _db_pool is not None:
        await close_pool(_db_pool)
        _db_pool = None


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "db": _db_pool is not None,
        "model": settings.GEMINI_MODEL,
    }


def _sse_event(name: str, payload: dict) -> str:
    """
    Render one SSE event. SSE wire format:
        event: <name>\n
        data: <json>\n
        \n
    JSON is emitted on a single ``data:`` line so the receiver doesn't need
    to deal with multi-line payload reassembly.
    """
    return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _meta_payload(
    chunks: list[RetrievedChunk],
    hints_speakers: list[str],
    hints_time_ranges: list,
    metadata_only: bool,
) -> dict:
    return {
        "chunks": [
            {
                "chunk_id": c.chunk_id,
                "topic_id": c.topic_id,
                "topic": c.topic,
                "fused_score": round(c.fused_score, 4),
                "start_time": c.start_time,
                "end_time": c.end_time,
                "speakers": c.speakers,
            }
            for c in chunks
        ],
        "hints": {
            "speakers": hints_speakers,
            "time_ranges": [
                {"start": tr.start, "end": tr.end} for tr in hints_time_ranges
            ],
            "metadata_only": metadata_only,
        },
    }


def _normalise_speaker_map(raw: dict[str, str] | None) -> dict[str, str]:
    """Return non-empty speaker label -> display name mappings."""
    out: dict[str, str] = {}
    for label, display in (raw or {}).items():
        label_text = str(label or "").strip()
        display_text = str(display or "").strip()
        if label_text and display_text:
            out[label_text] = display_text
    return out


def _reverse_map_hint_speakers(
    speakers: list[str], speaker_map: dict[str, str]
) -> list[str]:
    """
    Convert display names from the extractor back to stored diarization labels.

    If a hint is already a stored label, keep it. Unknown names also pass
    through so old clients without speaker maps behave as before.
    """
    if not speaker_map:
        return speakers

    display_to_label = {
        display.strip().lower(): label
        for label, display in speaker_map.items()
        if display.strip()
    }
    label_lookup = {label.strip().lower(): label for label in speaker_map}

    mapped: list[str] = []
    seen: set[str] = set()
    for speaker in speakers:
        key = str(speaker or "").strip().lower()
        if not key:
            continue
        value = display_to_label.get(key) or label_lookup.get(key) or speaker
        if value not in seen:
            mapped.append(value)
            seen.add(value)
    return mapped


def _display_map_chunks(
    chunks: list[RetrievedChunk], speaker_map: dict[str, str]
) -> list[RetrievedChunk]:
    """Replace stored speaker labels with display names in retrieved context."""
    if not speaker_map:
        return chunks

    labels = sorted(speaker_map, key=len, reverse=True)
    if not labels:
        return chunks

    pattern = re.compile(
        r"(?<![A-Za-z0-9_])("
        + "|".join(re.escape(label) for label in labels)
        + r")(?![A-Za-z0-9_])"
    )
    label_lookup = {label.lower(): display for label, display in speaker_map.items()}

    def replace_label(match: re.Match[str]) -> str:
        return speaker_map.get(match.group(1), match.group(1))

    mapped_chunks: list[RetrievedChunk] = []
    for chunk in chunks:
        mapped_speakers = [
            label_lookup.get(str(speaker).lower(), speaker)
            for speaker in chunk.speakers
        ]
        mapped_chunks.append(
            chunk.model_copy(
                update={
                    "text": pattern.sub(replace_label, chunk.text),
                    "speakers": mapped_speakers,
                }
            )
        )
    return mapped_chunks


async def _stream_answer(req: QARequest) -> AsyncIterator[str]:
    """
    Drive the full pipeline for one request and yield SSE-formatted strings.

    Order of events:
        1. ``meta``  — once, with retrieved chunks + hints (so the client can
           paint citation chips before the first token arrives).
        2. ``delta`` — zero or more times, one per Gemini text fragment.
        3. ``done``  — once, with the full concatenated answer for clients
           that prefer a final canonical string (and for meeting-service to
           persist).
        4. ``error`` — replaces ``done`` if the pipeline failed mid-stream.

    All exceptions are caught here and turned into ``error`` events so the
    SSE response always closes cleanly.
    """
    assert _extractor is not None and _retriever is not None and _streamer is not None

    # 1) Hints — never raises; on Gemini failure returns empty lists.
    speaker_map = _normalise_speaker_map(req.speaker_map)
    hints = await _extractor.extract(
        req.question,
        current_duration=req.current_duration,
    )
    retrieval_hints = hints.model_copy(
        update={
            "speakers": _reverse_map_hint_speakers(hints.speakers, speaker_map)
        }
    )

    # 2) Retrieve — raises on DB error. Catch and turn into SSE error event.
    try:
        chunks = await _retriever.retrieve(
            meeting_id=req.meeting_id,
            question=req.question,
            hints=retrieval_hints,
            current_duration=req.current_duration,
        )
        chunks = _display_map_chunks(chunks, speaker_map)
    except Exception as exc:
        logger.exception(
            "QA retrieve failed: meeting_id=%s user_id=%s",
            req.meeting_id,
            req.user_id,
        )
        yield _sse_event("error", {"message": f"retrieval failed: {exc}"})
        return

    # 3) Emit meta before any delta so the UI can render the citations panel.
    yield _sse_event(
        "meta",
        _meta_payload(chunks, hints.speakers, hints.time_ranges, hints.metadata_only),
    )

    # 4) Stream the answer. Concatenate as we go so we can emit the canonical
    #    text on ``done`` for downstream persistence.
    full_parts: list[str] = []
    stream_failed: str | None = None

    async for item in _streamer.stream_answer(req.question, chunks):
        if isinstance(item, StreamError):
            stream_failed = item.message
            break
        full_parts.append(item)
        yield _sse_event("delta", {"text": item})

    if stream_failed is not None:
        yield _sse_event("error", {"message": stream_failed})
        return

    full_answer = "".join(full_parts).strip()
    yield _sse_event("done", {"answer": full_answer})


@app.post("/qa")
async def qa_endpoint(req: QARequest) -> StreamingResponse:
    """
    SSE endpoint. Validation lives in QARequest's Pydantic shape; we only
    add the "non-empty question" guard here because Pydantic doesn't reject
    blank strings by default.
    """
    if _db_pool is None:
        # Startup hasn't completed (or shutdown ran). Treat as 503.
        raise HTTPException(status_code=503, detail="QA service not ready")
    if not req.question or not req.question.strip():
        raise HTTPException(status_code=400, detail="question must be non-empty")
    if req.meeting_id <= 0 or req.user_id <= 0:
        raise HTTPException(
            status_code=400, detail="meeting_id and user_id must be positive integers"
        )

    return StreamingResponse(
        _stream_answer(req),
        media_type="text/event-stream",
        # Required for proxies along the path (the meeting-service SSE proxy
        # in particular) so events flush as they're produced instead of
        # being buffered until the response closes.
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
