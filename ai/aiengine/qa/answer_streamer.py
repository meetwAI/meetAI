from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Dict, List, Optional

from google import genai
from google.genai import types as genai_types

from aiengine.qa.models import RetrievedChunk, ExtractedQuestion

logger = logging.getLogger(__name__)


_PROMPT_INSTRUCTIONS = """\
You are answering a user's question about a recorded meeting. The transcript
chunks below are the ONLY information you may use. Do not bring in outside
knowledge, do not speculate, and do not paraphrase the user's question back
at them.

RULES:
- If the chunks contain the answer, give it directly and concisely. Quote
  short phrases when they make the answer crisper, but do not transcribe
  whole chunks.
- If the chunks DO NOT contain enough information to answer, reply exactly:
    "I don't have enough information from this meeting to answer that."
  Do NOT add caveats, suggestions, or general knowledge after that line.
- Never invent speakers, timestamps, or chunk_ids. Only refer to the ones
  shown below.
- Plain prose. No bullet lists unless the answer is genuinely a list of
  items the speakers enumerated.
"""

_MOM_PROMPT_INSTRUCTIONS = """\
You are an expert meeting assistant. Your task is to write the Minutes of Meeting (MOM) for the provided meeting transcript chunks. 
The transcript chunks are presented chronologically. 

RULES:
- Provide a structured summary with clear sections (e.g., Overview, Key Topics Discussed, Action Items).
- Be concise and professional.
- Rely ONLY on the provided transcript chunks. Do not hallucinate or invent information.
- Mention speakers by name when relevant.
- Do not include technical metadata (like chunk_ids) in the final output.
"""


# Sentinel returned mid-stream when the underlying SDK raises. The QA server
# pattern-matches on the type — keeps the public type small.
@dataclass
class StreamError:
    """Yielded once when streaming fails. Stream ends after this value."""

    message: str


def _format_chunks(chunks: List[RetrievedChunk]) -> str:
    """
    Render the retrieved chunks for the prompt. Each chunk gets:
      - its chunk_id (so the model can cite it),
      - the speakers (when known) and the start-time on the audio timeline
        (so the model can disambiguate "what did Alice say at minute 12"),
      - the chunk text itself.
    """
    lines: List[str] = []
    try:
        logger.debug("Formatting %d chunks for prompt: %s", len(chunks), [c.chunk_id for c in chunks])
    except Exception:
        pass
    for c in chunks:
        meta_bits: List[str] = [f"chunk_id={c.chunk_id}", f"topic={c.topic!r}"]
        if c.speakers:
            meta_bits.append(f"speakers={','.join(c.speakers)}")
        if c.start_time is not None:
            meta_bits.append(f"start={c.start_time:.1f}s")
        lines.append(f"[{' | '.join(meta_bits)}]\n{c.text.strip()}")
    return "\n\n".join(lines)


def _format_seconds(total: float) -> str:
    """
    Convert a raw second count into a compact human-readable string.

    Examples::

        _format_seconds(0)     -> "0s"
        _format_seconds(90)    -> "1m 30s"
        _format_seconds(3661)  -> "1h 01m 01s"
    """
    total = int(total)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"


def _build_empty_context_message(hints: ExtractedQuestion) -> str | None:
    """
    When the retriever returned no chunks but the question carried specific
    hints, produce a precise, contextual explanation instead of the generic
    "I don't have enough information" refusal.

    Returns ``None`` when the hints are empty (no speakers, no time ranges),
    signalling that the caller should fall back to the generic refusal.

    Cases handled
    -------------
    * speakers + time ranges → "<names> did not speak between <start> and <end>"
    * speakers only          → "<names> did not speak at all in this meeting"
    * time ranges only       → "<start>–<end> appears to be silence / no speech"
    """
    has_speakers = bool(hints.speakers)
    has_times = bool(hints.time_ranges)

    if not has_speakers and not has_times:
        return None

    # --- helpers -------------------------------------------------------------
    def _speaker_str() -> str:
        names = [s.title() for s in hints.speakers]
        if len(names) == 1:
            return names[0]
        return ", ".join(names[:-1]) + f" and {names[-1]}"

    def _range_str(tr) -> str:
        if tr.start is not None and tr.end is not None:
            return f"{_format_seconds(tr.start)} – {_format_seconds(tr.end)}"
        if tr.start is not None:
            return f"after {_format_seconds(tr.start)}"
        if tr.end is not None:
            return f"before {_format_seconds(tr.end)}"
        return "the requested period"

    # --- build message -------------------------------------------------------
    if has_speakers and has_times:
        speaker_part = _speaker_str()
        range_parts = ", ".join(_range_str(tr) for tr in hints.time_ranges)
        plural = "that period" if len(hints.time_ranges) == 1 else "those periods"
        return (
            f"There is no record of {speaker_part} speaking during "
            f"{range_parts} in this meeting — "
            f"{speaker_part} appears to have been silent for {plural}."
        )

    if has_speakers:
        speaker_part = _speaker_str()
        verb = "does" if len(hints.speakers) == 1 else "do"
        return (
            f"There is no record of {speaker_part} speaking anywhere in "
            f"this meeting's transcript — {speaker_part} {verb} not appear "
            f"to have contributed during the recorded session."
        )

    # has_times only
    range_parts = ", ".join(_range_str(tr) for tr in hints.time_ranges)
    plural = "that window" if len(hints.time_ranges) == 1 else "those windows"
    return (
        f"No speech was found between {range_parts} in this meeting — "
        f"{plural} appears to be silence or was not captured in the transcript."
    )

def _format_history_for_answer(
    history: Optional[List[Dict[str, str]]],
) -> str:
    """
    Render conversation history into a prompt section for the answer streamer.

    Returns an empty string when there is no history so the prompt is
    unchanged for first-question requests.
    """
    if not history:
        return ""

    lines: List[str] = []
    for turn in history:
        role = turn.get("role", "user")
        content = (turn.get("content") or "").strip()
        if not content:
            continue
        # Truncate very long answers to keep the prompt within budget.
        if len(content) > 500:
            content = content[:500] + "..."
        label = "User" if role == "user" else "Assistant"
        lines.append(f"{label}: {content}")

    if not lines:
        return ""

    block = "\n".join(lines)
    return (
        f"PREVIOUS CONVERSATION (for context only — you MUST still answer "
        f"using ONLY the transcript chunks below, do not repeat previous "
        f"answers):\n{block}\n\n"
    )

class AnswerStreamer:
    """
    Wraps the Gemini client used for QA call #2. One instance per QA service.
    """

    REFUSAL_NO_CONTEXT = (
        "I don't have enough information from this meeting to answer that."
    )

    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise RuntimeError(
                "AnswerStreamer: GEMINI_API_KEY is empty. Set it in the env "
                "or in CHECKPOINT1/.env before starting the QA service."
            )
        self._model = model
        self._client = genai.Client(api_key=api_key)

    async def stream_answer(
        self,
        question: str,
        chunks: List[RetrievedChunk],
        hints: Optional[ExtractedQuestion] = None,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> AsyncIterator[str | StreamError]:
        """
        Yield text deltas as Gemini produces them.

        Yields:
            - ``str`` — a non-empty piece of answer text. Concatenating every
              yielded string gives the full answer.
            - ``StreamError`` — once, on failure, then the iterator ends.

        For the "no context" case there is no Gemini call:
        - If ``hints`` carries speaker or time-range information we emit a
          precise, contextual message (e.g. "Alice did not speak between
          2m 00s – 5m 00s") instead of the generic refusal.
        - Otherwise fall back to the generic refusal string.
        """
        text = (question or "").strip()
        if not text:
            # Defensive — the server should reject empty questions earlier.
            yield self.REFUSAL_NO_CONTEXT
            return

        if not chunks:
            # Try to produce a specific, contextual message before falling back
            # to the generic refusal. No Gemini call in either branch.
            contextual = (
                _build_empty_context_message(hints) if hints is not None else None
            )
            yield contextual if contextual is not None else self.REFUSAL_NO_CONTEXT
            return
        

        try:
            logger.info(
                "AnswerStreamer.stream_answer called: question_len=%s chunks=%s",
                len(text),
                [c.chunk_id for c in chunks],
                len(history) if history else 0,
            )
        except Exception:
            pass

        history_section = _format_history_for_answer(history)

        prompt = (
            f"{_PROMPT_INSTRUCTIONS}\n\n"
            f"{history_section}"
            f"USER QUESTION:\n{text}\n\n"
            f"TRANSCRIPT CHUNKS:\n{_format_chunks(chunks)}\n"
        )
        logger.debug("Answer prompt preview (len=%d): %s", len(prompt), prompt[:1000])
        async for item in self._stream_prompt(prompt, self._model):
            yield item

    async def stream_minutes_of_meeting(
        self,
        chunks: List[RetrievedChunk],
        model: str,
    ) -> AsyncIterator[str | StreamError]:
        """
        Generate MOM using the specified model.
        """
        if not chunks:
            yield self.REFUSAL_NO_CONTEXT
            return

        prompt = (
            f"{_MOM_PROMPT_INSTRUCTIONS}\n\n"
            f"TRANSCRIPT CHUNKS:\n{_format_chunks(chunks)}\n"
        )
        logger.debug("MOM prompt preview (len=%d): %s", len(prompt), prompt[:1000])
        async for item in self._stream_prompt(prompt, model):
            yield item

    async def _stream_prompt(
        self,
        prompt: str,
        model: str,
    ) -> AsyncIterator[str | StreamError]:
        # Open the streaming call in a worker thread; google-genai's stream
        # iterator is synchronous. We then pull from it one chunk at a time,
        # also in a worker thread, so the event loop never blocks.
        try:
            logger.info("Opening Gemini stream: model=%s prompt_len=%d", model, len(prompt))
            logger.debug("Stream prompt preview: %s", prompt[:1000])
            stream = await asyncio.to_thread(
                self._client.models.generate_content_stream,
                model=model,
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    # No structured-output schema here: free text is the
                    # whole point of the answer streamer.
                    response_mime_type="text/plain",
                ),
            )
            logger.info("Gemini stream opened successfully: model=%s", model)
        except Exception as exc:
            logger.exception("AnswerStreamer: failed to open Gemini stream")
            yield StreamError(message=f"Gemini stream open failed: {exc}")
            return

        # The SDK exposes the stream as a sync iterator. ``next(it)`` blocks
        # on network I/O, so wrap each step in ``to_thread``. Sentinel
        # ``_DONE`` distinguishes end-of-stream from a real ``None`` value.
        _DONE: object = object()

        def _next_chunk(it):
            try:
                return next(it)
            except StopIteration:
                return _DONE

        iterator = iter(stream)
        try:
            while True:
                item = await asyncio.to_thread(_next_chunk, iterator)
                if item is _DONE:
                    logger.info("Gemini stream closed cleanly: model=%s", model)
                    return
                # google-genai chunk objects carry incremental ``.text``.
                # Some chunks are tool-call / safety placeholders with no
                # text; skip those without ending the stream.
                delta = getattr(item, "text", None)
                if delta:
                    logger.debug("Gemini delta chunk: %s", delta)
                    yield delta
        except Exception as exc:
            logger.exception("AnswerStreamer: error mid-stream")
            yield StreamError(message=f"Gemini stream interrupted: {exc}")
            return


# Re-export so the QA server can do ``isinstance(item, StreamError)`` without
# importing the dataclass from a different module path.
__all__ = ["AnswerStreamer", "StreamError"]
