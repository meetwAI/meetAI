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
   - IMPORTANT — when a KNOWN SPEAKERS list is provided below, you MUST
     resolve every name the user mentions to the closest match in that list.
     Apply this resolution for ALL of the following cases:
       a) Typos / extra letters  : "akramm" -> "akram", "maro" -> "mario"
       b) Missing letters        : "jon" -> "john", "ale" -> "alex"
       c) Arabic name or transliteration of a known speaker's name:
            "اكرم" or "أكرم"  -> "akram"
            "محمد" or "مو"    -> "mohamed" (if that is in the known list)
            "ماريو"           -> "mario"
       d) Common nickname / short form: "mike" -> "michael" if "michael" is
            in the known list and "mike" is not.
   - Always return the KNOWN SPEAKERS spelling (lowercased), not whatever
     the user typed, when a confident match exists.
   - If the name does NOT match any known speaker (genuinely absent from the
     meeting), you MUST still return it in English (Latin script):
       * If the user typed it in Arabic or any non-Latin script, transliterate
         it to its standard English romanisation before returning it.
       * NEVER return a name in Arabic, Hebrew, or any other non-Latin script.
       * NEVER invent or substitute a name that IS in the known list when the
         user clearly meant someone different.
       * Examples of the not-in-list case (known speakers: akram, mario):
           "ماذا قال خالد؟"  -> ["khaled"]   // not in list, transliterated
           "what did sara say?" -> ["sara"]   // not in list, already English
   - If no KNOWN SPEAKERS list is provided, apply the same transliteration
     rule: always return names in English (Latin) script, lowercased.
   - If the user did not name anyone specific, return [].
   - Examples (assuming known speakers: akram, mario, john):
       "what did akramm say?"   -> ["akram"]
       "anything from maro?"    -> ["mario"]
       "ماذا قال اكرم؟"          -> ["akram"]
       "what did جون decide?"   -> ["john"]
       "what did we decide about Q3?" -> []

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
        self,
        question: str,
        current_duration: Optional[float] = None,
        known_speakers: Optional[list[str]] = None,
    ) -> ExtractedQuestion:
        """
        Parse one user question into ``ExtractedQuestion``.

        Args:
            question: The raw user question.
            current_duration: Latest audio timestamp in seconds, used to
                resolve relative time expressions like "last 10 minutes".
            known_speakers: Display names of all speakers in this meeting
                (values from the speaker_map). When provided, the LLM will
                resolve typos, Arabic transliterations, and nicknames to the
                canonical name from this list instead of returning whatever
                the user typed.

        Always returns an ``ExtractedQuestion`` — empty lists on any error,
        so the caller never has to handle ``None``. Logs the underlying
        error so a recurrent extraction failure is still visible in ops.
        """
        text = (question or "").strip()
        if not text:
            return ExtractedQuestion()

        logger.info(
            "QuestionExtractor.extract called: question_len=%s current_duration=%s known_speakers=%s",
            len(text),
            current_duration,
            known_speakers,
        )

        duration_text = (
            f"{float(current_duration):.3f} seconds"
            if current_duration is not None and current_duration >= 0
            else "not provided"
        )

        if known_speakers:
            speakers_block = ", ".join(known_speakers)
            known_speakers_section = f"KNOWN SPEAKERS (resolve all user-mentioned names to the closest match here):\n{speakers_block}\n\n"
        else:
            known_speakers_section = ""

        prompt = (
            f"{_PROMPT_INSTRUCTIONS}\n\n"
            f"{known_speakers_section}"
            f"CURRENT MEETING DURATION:\n{duration_text}\n\n"
            f"USER QUESTION:\n{text}\n"
        )
        # Prompt preview may contain user content; keep it to a reasonable length
        logger.debug("QuestionExtractor prompt preview: %s", prompt[:1000])

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
        # Log raw SDK response for debugging
        raw_text = getattr(response, "text", None)
        logger.debug("QuestionExtractor raw SDK text preview: %s", raw_text[:1000] if raw_text else None)

        if isinstance(parsed, ExtractedQuestion):
            try:
                logger.info("QuestionExtractor parsed hints: %s", parsed.model_dump())
            except Exception:
                logger.info("QuestionExtractor parsed hints (no dump available)")
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
