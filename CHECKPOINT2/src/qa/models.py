"""
qa/models.py
------------
Pydantic contracts for the QA pipeline.

Three roles:

1.  ``QuestionFilters`` / ``ExtractedQuestion`` — Gemini's structured response
    when we ask it to look at the user's question and pull out optional hints
    (speakers and time ranges). ``ExtractedQuestion`` is what we pass as
    ``response_schema`` so the API guarantees a JSON-decodable shape.

2.  ``RetrievedChunk`` — internal handoff from the retriever to the answer
    streamer. One row per chunk that survived the fused-vector ranking.

3.  ``QARequest`` — what the meeting-service POSTs to the QA service. The
    answer-side response is streamed as SSE, not a single Pydantic model, so
    there is no ``QAResponse`` here.
"""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class TimeRange(BaseModel):
    """
    A timestamp window on the meeting's audio timeline (seconds since session
    start). Both bounds are inclusive. Either bound may be None — Gemini may
    say "after minute 30" (start=1800, end=None) or "before halftime"
    (start=None, end=...). Empty list is the common case.
    """

    start: Optional[float] = None
    end: Optional[float] = None


class ExtractedQuestion(BaseModel):
    """
    Gemini's parse of the user's question. Both fields are optional hints —
    if the question is open-ended ("what did we decide about Q3?") both lists
    will be empty and the retriever falls back to "search every chunk under
    every matching topic".
    """

    speakers: List[str] = Field(default_factory=list)
    time_ranges: List[TimeRange] = Field(default_factory=list)


class RetrievedChunk(BaseModel):
    """
    One chunk row returned by the retriever, already paired with the topic it
    came in through and the fused-vector score. The answer streamer renders
    these into the strict-RAG prompt.
    """

    chunk_id: int
    text: str
    speakers: List[str] = Field(default_factory=list)
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    topic_id: Optional[int] = None
    topic: Optional[str] = None
    fused_score: float


class QARequest(BaseModel):
    """
    Body of ``POST /qa`` from meeting-service. ``user_id`` is forwarded from
    the gateway so the QA service can scope chunk reads (meeting-service
    has already verified the user owns the meeting).
    """

    meeting_id: int
    user_id: int
    question: str
