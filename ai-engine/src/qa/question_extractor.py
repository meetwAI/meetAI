"""
qa/question_extractor.py
------------------------
Gemini call #1 of the QA pipeline.

Takes the user's question and asks Gemini to pull out optional retrieval
hints — which speakers are referenced, and which time ranges. Both are
*soft hints*: the retriever uses them to narrow the chunk pool when present,
and falls back to searching every chunk under every matching topic when
they're absent.

Why structured output
---------------------
Same reasoning as the topic-extraction client: ``response_json_schema``
guarantees a JSON-decodable response that matches our Pydantic model. Free
text would force us to parse natural language hedges ("around the start",
"maybe Alice or Bob"); structured output makes the boundaries explicit.

Failure mode
------------
On any error (network, schema, parse), return an ``ExtractedQuestion`` with
both lists empty. That's the same behaviour as "Gemini saw the question and
extracted nothing actionable" — the retriever already handles that case as a
no-op filter, so the QA pipeline keeps moving instead of bailing on the user.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from google import genai
from google.genai import types as genai_types

from src.qa.models import ExtractedQuestion

logger = logging.getLogger(__name__)


_PROMPT_INSTRUCTIONS = """\
You analyse a single user question about a recorded meeting and extract any
RETRIEVAL HINTS that will help find the right transcript chunks. You do NOT
answer the question. You ONLY return the structured hints.

Three kinds of hints, all optional:

1. speakers
   - List of speaker names or labels referenced by the question.
   - Use the names exactly as the user wrote them, lowercased and trimmed.
   - Examples:
       "what did Alice say about pricing?"  -> ["alice"]
       "did anyone disagree with Bob or Carol?" -> ["bob", "carol"]
       "what did we decide about Q3?" -> []
   - If the user did not name anyone specific, return [].

2. time_ranges
   - List of {start, end} objects in SECONDS from the start of the meeting.
   - Convert minute/hour phrasing to seconds. Both bounds may be null.
   - Examples:
       "what did we say in the first ten minutes?"
           -> [{"start": 0, "end": 600}]
       "after minute 30, did anyone bring up budget?"
           -> [{"start": 1800, "end": null}]
       "around the 45-minute mark"
           -> [{"start": 2400, "end": 3000}]   // ±5 min window
       "what did we decide about Q3?"
           -> []
   - If the user did not reference timing, return [].

3. metadata_only
   - true when the question can be answered by selecting transcript chunks by
     metadata only, without semantic meaning in the question.
   - Use true for pure recency/time/speaker-summary requests such as:
       "what was said in the last 10 minutes?"
       "summarize the first five minutes"
       "what did Alice say between minute 3 and minute 8?"
   - Use false when the question asks about a topic, decision, action item,
     or concept that needs semantic search, even if it also has time/speaker
     hints.

When CURRENT MEETING DURATION is provided, it is the latest available audio
timestamp in seconds. Use it to convert relative recency questions into
absolute time ranges:
   "last 10 minutes" with duration 1500 -> [{"start": 900, "end": 1500}]
Clamp the start to 0 when the requested lookback is longer than the meeting.
If CURRENT MEETING DURATION is not provided and the user asks for "last X
minutes", leave time_ranges empty rather than inventing an end timestamp.

Return ONLY the JSON object that matches the response schema. No prose, no
explanation. If the question contains no hints at all, return
{"speakers": [], "time_ranges": [], "metadata_only": false}.
"""


class QuestionExtractor:
    """
    Wraps the Gemini client used for QA call #1.

    The client is cheap to construct — google-genai opens the connection
    lazily on the first request — so callers can build one per process and
    reuse it across every question.
    """

    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise RuntimeError(
                "QuestionExtractor: GEMINI_API_KEY is empty. Set it in the env "
                "or in CHECKPOINT1/.env before starting the QA service."
            )
        self._model = model
        self._client = genai.Client(api_key=api_key)

    async def extract(
        self, question: str, current_duration: Optional[float] = None
    ) -> ExtractedQuestion:
        """
        Parse one user question into ``ExtractedQuestion``.

        Always returns an ``ExtractedQuestion`` — empty lists on any error,
        so the caller never has to handle ``None``. Logs the underlying
        error so a recurrent extraction failure is still visible in ops.
        """
        text = (question or "").strip()
        if not text:
            return ExtractedQuestion()

        duration_text = (
            f"{float(current_duration):.3f} seconds"
            if current_duration is not None and current_duration >= 0
            else "not provided"
        )
        prompt = (
            f"{_PROMPT_INSTRUCTIONS}\n\n"
            f"CURRENT MEETING DURATION:\n{duration_text}\n\n"
            f"USER QUESTION:\n{text}\n"
        )

        try:
            response = await asyncio.to_thread(
                self._client.models.generate_content,
                model=self._model,
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=ExtractedQuestion,
                ),
            )
        except Exception:
            logger.exception(
                "QuestionExtractor: Gemini call failed; treating question as "
                "having no hints."
            )
            return ExtractedQuestion()

        parsed: Optional[ExtractedQuestion] = getattr(response, "parsed", None)
        if isinstance(parsed, ExtractedQuestion):
            return parsed

        # Fallback path: SDK didn't populate ``response.parsed`` (rare but
        # observed when the schema validation runs after the parse step).
        raw_text = getattr(response, "text", None)
        if not raw_text:
            logger.warning(
                "QuestionExtractor: empty Gemini response; treating as no hints."
            )
            return ExtractedQuestion()

        try:
            return ExtractedQuestion.model_validate_json(raw_text)
        except Exception:
            logger.exception(
                "QuestionExtractor: response failed schema validation; "
                "preview=%r",
                raw_text[:300],
            )
            return ExtractedQuestion()
