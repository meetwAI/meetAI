"""
qa/answer_streamer.py
---------------------
Gemini call #2 of the QA pipeline: turn the retrieved chunks into a streamed
answer, token by token.

Strict RAG
----------
The prompt forces the model to answer ONLY from the provided chunks. If the
retrieved context doesn't cover the question, the model must say so plainly
instead of hallucinating from background knowledge. The model is also asked
to cite chunk_ids inline so the UI can later highlight the source spans —
this is a low-cost win because Gemini already sees the chunk_ids in the
prompt; we just ask it to keep referring to them.

Streaming
---------
google-genai's ``models.generate_content_stream`` is a synchronous iterator.
We wrap it so the FastAPI endpoint can ``async for`` over deltas without
blocking the event loop. Each ``next()`` call on the underlying iterator is
offloaded to a worker thread (``asyncio.to_thread``); we yield each chunk's
``.text`` immediately as soon as it arrives.

Failure mode
------------
- Empty context (retriever returned no chunks) → yield a single fixed
  refusal string, then end. We don't waste a Gemini call when there is
  nothing to ground on.
- Network or schema error mid-stream → yield an error sentinel object so
  the server can emit an SSE ``error`` event without breaking the stream
  contract. The QA server is the only caller and it knows how to interpret
  the sentinel.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import AsyncIterator, List, Optional

from google import genai
from google.genai import types as genai_types

from src.qa.models import RetrievedChunk

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
    for c in chunks:
        meta_bits: List[str] = [f"chunk_id={c.chunk_id}", f"topic={c.topic!r}"]
        if c.speakers:
            meta_bits.append(f"speakers={','.join(c.speakers)}")
        if c.start_time is not None:
            meta_bits.append(f"start={c.start_time:.1f}s")
        lines.append(f"[{' | '.join(meta_bits)}]\n{c.text.strip()}")
    return "\n\n".join(lines)


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
    ) -> AsyncIterator[str | StreamError]:
        """
        Yield text deltas as Gemini produces them.

        Yields:
            - ``str`` — a non-empty piece of answer text. Concatenating every
              yielded string gives the full answer.
            - ``StreamError`` — once, on failure, then the iterator ends.

        For the "no context" case there is no Gemini call: yield the fixed
        refusal once and return.
        """
        text = (question or "").strip()
        if not text:
            # Defensive — the server should reject empty questions earlier.
            yield self.REFUSAL_NO_CONTEXT
            return

        if not chunks:
            yield self.REFUSAL_NO_CONTEXT
            return

        prompt = (
            f"{_PROMPT_INSTRUCTIONS}\n\n"
            f"USER QUESTION:\n{text}\n\n"
            f"TRANSCRIPT CHUNKS:\n{_format_chunks(chunks)}\n"
        )

        # Open the streaming call in a worker thread; google-genai's stream
        # iterator is synchronous. We then pull from it one chunk at a time,
        # also in a worker thread, so the event loop never blocks.
        try:
            stream = await asyncio.to_thread(
                self._client.models.generate_content_stream,
                model=self._model,
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    # No structured-output schema here: free text is the
                    # whole point of the answer streamer.
                    response_mime_type="text/plain",
                ),
            )
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
                    return
                # google-genai chunk objects carry incremental ``.text``.
                # Some chunks are tool-call / safety placeholders with no
                # text; skip those without ending the stream.
                delta = getattr(item, "text", None)
                if delta:
                    yield delta
        except Exception as exc:
            logger.exception("AnswerStreamer: error mid-stream")
            yield StreamError(message=f"Gemini stream interrupted: {exc}")
            return


# Re-export so the QA server can do ``isinstance(item, StreamError)`` without
# importing the dataclass from a different module path.
__all__ = ["AnswerStreamer", "StreamError"]
