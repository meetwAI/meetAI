"""
gemini_client.py
----------------
Thin async wrapper around ``google-genai`` for the topic-extraction pipeline.

Why structured output
---------------------
We rely on Gemini's ``response_json_schema`` feature so the API guarantees a
JSON-decodable response that matches ``GeneratedTopicList``. Without it we
would have to parse free-form prose and recover from arbitrary formatting
quirks; with it, the only failure modes that matter are network errors and
semantic violations (e.g. a chunk_id that wasn't in our request) — both of
which we handle by logging and returning ``None`` so the caller can skip the
window without crashing the audio pipeline.

Concurrency
-----------
The official SDK call is synchronous. We offload it to the default asyncio
executor so the event loop stays responsive while waiting on the network.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import List, Optional

from google import genai
from google.genai import types as genai_types

from aiengine.models.topic import (
    ExistingTopicSummary,
    GeneratedTopicList,
    PersistedChunk,
)

logger = logging.getLogger(__name__)


_PROMPT_INSTRUCTIONS = """\
You extract conversation topics from a 5-minute window of a meeting transcript.

RULES:
- Each topic is 3 to 7 words. No participant names. No filler words.
- Topics are short, descriptive noun phrases (e.g. "Q3 hiring plan", "deployment rollback strategy"), not sentences.
- CONSOLIDATE TOPICS: Do NOT create multiple topics with the same or highly similar meanings. Group related chunks under a single, unified topic.
- STRICT 1:1 MAPPING: Each chunk_id MUST be assigned to EXACTLY ONE topic. Do not assign a chunk to multiple topics. 
- Every chunk_id you emit MUST appear in the input chunks. Do not invent IDs.
- If the window continues an EXISTING topic listed below, REUSE that exact topic string verbatim instead of paraphrasing it or creating a duplicate.
- Return only the JSON object that matches the response schema; no prose.
"""


def _format_chunks(chunks: List[PersistedChunk]) -> str:
    """Render the window's chunks as a compact, ID-tagged transcript."""
    lines = []
    for c in chunks:
        lines.append(f"[chunk_id={c.chunk_id}] {c.text}")
    return "\n".join(lines)


def _format_existing(existing: List[ExistingTopicSummary]) -> str:
    """Render the existing-topics list (or a placeholder if empty)."""
    if not existing:
        return "(none — this is the first window for this meeting)"
    return "\n".join(f"- {t.topic}" for t in existing)


class GeminiTopicClient:
    """
    Calls Gemini once per closed 5-minute window and returns parsed topics.

    The client is cheap to construct — the SDK lazily opens a connection on
    the first request — so we instantiate one per ``TopicProcessor`` and
    reuse it across all windows of a given meeting.
    """

    def __init__(self, api_key: str, model: str) -> None:
        self._model = model
        # ``genai.Client`` accepts api_key=None and falls back to env var; we
        # force the explicit key here so misconfiguration fails loudly when
        # the worker first tries to extract topics, not silently.
        self._client = genai.Client(api_key=api_key)

    async def extract_topics(
        self,
        window_chunks: List[PersistedChunk],
        existing_topics: List[ExistingTopicSummary],
    ) -> Optional[GeneratedTopicList]:
        """
        Send one window to Gemini. Returns the parsed ``GeneratedTopicList``,
        or ``None`` on any failure (network, schema, parse, validation).
        """
        logger.debug(f"extract_topics called: window_chunks_count={len(window_chunks)}, existing_topics_count={len(existing_topics)}")
        if not window_chunks:
            logger.debug("window_chunks is empty, skipping.")
            return None

        prompt = (
            f"{_PROMPT_INSTRUCTIONS}\n\n"
            f"EXISTING TOPICS for this meeting:\n{_format_existing(existing_topics)}\n\n"
            f"NEW WINDOW CHUNKS:\n{_format_chunks(window_chunks)}\n"
        )

        logger.debug(f"calling gemini model={self._model}")
        try:
            response = await asyncio.to_thread(
                self._client.models.generate_content,
                model=self._model,
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=GeneratedTopicList,
                ),
            )
        except Exception:
            logger.exception("Gemini call failed; skipping window.")
            return None

        # The SDK exposes both ``response.parsed`` (already a Pydantic
        # instance when ``response_schema`` is set) and ``response.text``
        # (the raw JSON string). Prefer the parsed form; fall back to a
        # manual ``model_validate_json`` if the SDK didn't populate it.
        parsed = getattr(response, "parsed", None)
        if isinstance(parsed, GeneratedTopicList):
            logger.debug(f"parsed directly from response: topics={len(parsed.topics)}")
            return parsed

        raw_text = getattr(response, "text", None)
        if not raw_text:
            logger.warning("Gemini returned an empty response; skipping window.")
            logger.debug("empty raw_text response from Gemini")
            return None

        logger.debug(f"falling back to parse raw text: {raw_text[:100]}...")
        try:
            parsed = GeneratedTopicList.model_validate_json(raw_text)
            logger.debug(f"parsed from raw text: topics={len(parsed.topics)}")
            return parsed
        except Exception:
            # Last-ditch: try parsing as a generic dict so we can log a
            # useful diagnostic, then surrender.
            try:
                preview = json.dumps(json.loads(raw_text))[:300]
            except Exception:
                preview = raw_text[:300]
            logger.exception(
                "Gemini response failed schema validation. Preview: %s", preview
            )
            return None
