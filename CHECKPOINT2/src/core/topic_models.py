"""
topic_models.py
---------------
Pydantic contracts for the 5-minute topic-extraction pipeline.

These models serve three distinct roles:

1.  ``PersistedChunk`` — internal handoff between ``ChunkStore`` and the
    ``TopicProcessor``. Carries the DB-assigned ``chunk_id`` plus the
    metadata needed to build the Gemini prompt and to compute window
    boundaries on the audio timeline.

2.  ``GeneratedTopic`` / ``GeneratedTopicList`` — the structured response we
    require Gemini to return. ``GeneratedTopicList`` is what we pass as the
    ``response_schema`` to the Gemini SDK so the API guarantees a
    JSON-decodable shape; downstream code only ever sees parsed Python
    objects, never raw text.

3.  ``ExistingTopicSummary`` — the bare ``(topic_id, topic)`` view of an
    existing ``meeting_topics`` row that the prompt sends to Gemini, so the
    model can choose to extend an already-known topic instead of inventing a
    near-duplicate. The 0.85 cosine threshold is the *safety net* that
    enforces this on our side; the prompt is the *hint*.
"""
from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field


class PersistedChunk(BaseModel):
    """
    A chunk that has been written to ``meeting_chunks`` and is now ready to
    be considered for topic extraction. The ``start`` / ``end`` timestamps
    are on the ASR audio timeline (seconds since session start) and are what
    the topic processor uses to decide when a 5-minute window has closed.
    """

    chunk_id: int
    text: str
    start: float
    end: float
    speakers: List[str] = Field(default_factory=list)


class GeneratedTopic(BaseModel):
    """
    One topic produced by Gemini for a single 5-minute window.

    ``chunk_ids`` MUST be a subset of the chunk IDs we sent in the request.
    We re-validate this server-side after parsing — any unknown UUID is
    silently dropped (best-effort, no retry).
    """

    topic: str
    chunk_ids: List[int]


class GeneratedTopicList(BaseModel):
    """
    Top-level Gemini response. Wrapping the list in an object is required
    because Gemini's ``response_schema`` expects an object at the root, not
    a bare array.
    """

    topics: List[GeneratedTopic]


class ExistingTopicSummary(BaseModel):
    """
    Compact view of an existing ``meeting_topics`` row — just enough to nudge
    Gemini toward merging into the existing topic instead of generating a
    near-duplicate. The embedding is intentionally NOT sent to Gemini; we
    only ever compare embeddings locally.
    """

    topic_id: int
    topic: str
