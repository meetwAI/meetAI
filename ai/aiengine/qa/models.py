"""
qa/models.py
------------
Pydantic contracts for the QA pipeline.
"""


from __future__ import annotations

from typing import Dict, List, Optional

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

    ``resolved_question`` is the self-contained rewrite of the user's
    question with pronouns and vague references resolved from conversation
    history (e.g. "more on that" → "more details about the Q3 budget
    discussion").  When there is no history or the question is already
    self-contained, this equals the original question text.
    """

    speakers: List[str] = Field(default_factory=list)
    time_ranges: List[TimeRange] = Field(default_factory=list)
    metadata_only: bool = False
    resolved_question: Optional[str] = None


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
    current_duration: Optional[float] = None
    speaker_map: Optional[Dict[str, str]] = None


class MOMRequest(BaseModel):
    """
    Body of ``POST /mom``.
    """
    meeting_id: int
    user_id: int
    speaker_map: Optional[Dict[str, str]] = None