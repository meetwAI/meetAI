"""
text_segmenter.py
-----------------
Stateless helpers for sentence segmentation and token-count-aware packing.

Responsibilities
----------------
- Group ASRTokens into contiguous single-speaker runs (_SpeakerRun).
- Split each run into _Sentence objects using the ASR tokenizer or a
  punctuation-based fallback.
- Pack sentences greedily into sub-chunks that respect MAX_TOKENS.
"""
from __future__ import annotations

import logging
from typing import Callable, List, Optional

import tiktoken

from aiengine.models.chunk import _Sentence, _SpeakerRun
from aiengine.models.timed import ASRToken

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: speaker label
# ---------------------------------------------------------------------------

def _speaker_label(speaker_id) -> str:
    try:
        if int(speaker_id) < 0:
            return "speaker_unknown"
    except (ValueError, TypeError):
        pass
    return f"speaker_{speaker_id}"


# ---------------------------------------------------------------------------
# Stateless segmenter
# ---------------------------------------------------------------------------

class TextSegmenter:
    """
    Converts a flat list of committed ASRTokens into packed sentence groups
    ready for chunk emission.

    Parameters
    ----------
    tokenizer :
        The sentence-tokenizer callable from ``asr.tokenizer`` —
        accepts a string (or list of strings) and returns a list of sentence
        strings.  Pass ``None`` to fall back to punctuation-based splitting.
    max_tokens :
        Maximum tiktoken token count per output sub-chunk.
    encoding_name :
        tiktoken encoding to use for token counting.
    """

    def __init__(
        self,
        tokenizer: Optional[Callable],
        max_tokens: int,
        encoding_name: str,
    ) -> None:
        self._tokenizer = tokenizer
        self._max_tokens = max_tokens
        self._enc = tiktoken.get_encoding(encoding_name)

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------
    def count_tokens(self, text: str) -> int:
        return len(self._enc.encode(text))
        
    def tokens_to_sentence_groups(
        self, tokens: List[ASRToken]
    ) -> List[List[_Sentence]]:
        """
        Full pipeline: tokens → speaker runs → sentences → packed groups.
        """
        sentences = self._tokens_to_sentences(tokens)
        return self._pack_sentences(sentences)

    # ------------------------------------------------------------------
    # Speaker-run grouping
    # ------------------------------------------------------------------

    def _tokens_to_sentences(self, tokens: List[ASRToken]) -> List[_Sentence]:
        """
        Group tokens into contiguous speaker runs, then sentence-split each
        run.  Returns a flat, time-ordered list of _Sentence objects.
        """
        runs: List[_SpeakerRun] = []
        for token in tokens:
            if runs and token.speaker == -1:
                token.speaker = runs[-1].speaker
            if runs and runs[-1].speaker == token.speaker:
                runs[-1].tokens.append(token)
            else:
                runs.append(_SpeakerRun(speaker=token.speaker, tokens=[token]))

        sentences: List[_Sentence] = []
        for run in runs:
            sentences.extend(self._split_run_into_sentences(run))
        return sentences

    def _split_run_into_sentences(self, run: _SpeakerRun) -> List[_Sentence]:
        """Split a single-speaker token run into _Sentence objects."""
        tokens = run.tokens
        full_text = " ".join(t.text for t in tokens)
        sentence_texts = self._sentence_split(full_text)

        sentences: List[_Sentence] = []
        token_idx = 0

        for sent_text in sentence_texts:
            sent_text = sent_text.strip()
            if not sent_text:
                continue

            sent_tokens: List[ASRToken] = []
            accumulated = ""
            while token_idx < len(tokens) and len(accumulated) < len(sent_text):
                t = tokens[token_idx]
                accumulated = (
                    (accumulated + " " + t.text).strip() if accumulated else t.text
                )
                sent_tokens.append(t)
                token_idx += 1

            if not sent_tokens:
                continue

            label = _speaker_label(run.speaker)
            rendered = f"{label}: {' '.join(t.text for t in sent_tokens).strip()}"
            tok_count = len(self._enc.encode(rendered))

            sentences.append(
                _Sentence(
                    speaker=run.speaker,
                    text=" ".join(t.text for t in sent_tokens).strip(),
                    start=sent_tokens[0].start,
                    end=sent_tokens[-1].end,
                    token_count=tok_count,
                )
            )

        return sentences

    # ------------------------------------------------------------------
    # Sentence splitting
    # ------------------------------------------------------------------

    def _sentence_split(self, text: str) -> List[str]:
        """Delegate to the ASR tokenizer; fall back to punctuation splitting."""
        if self._tokenizer:
            try:
                result = self._tokenizer(text)
                if isinstance(result, list):
                    return result
            except Exception:
                try:
                    result = self._tokenizer([text])
                    if isinstance(result, list):
                        return result
                except Exception:
                    pass
        return self._punctuation_split(text)

    @staticmethod
    def _punctuation_split(text: str) -> List[str]:
        """Punctuation-based sentence splitter (fallback)."""
        from aiengine.models.timed import PUNCTUATION_MARKS

        sentences = []
        current: List[str] = []
        for char in text:
            current.append(char)
            if char in PUNCTUATION_MARKS:
                sentence = "".join(current).strip()
                if sentence:
                    sentences.append(sentence)
                current = []
        remainder = "".join(current).strip()
        if remainder:
            sentences.append(remainder)
        return sentences if sentences else [text]

    # ------------------------------------------------------------------
    # Sentence packing
    # ------------------------------------------------------------------

    def _pack_sentences(
        self, sentences: List[_Sentence]
    ) -> List[List[_Sentence]]:
        """
        Greedily pack sentences into sub-chunks up to MAX_TOKENS each.

        Never splits mid-sentence.  A sentence that alone exceeds MAX_TOKENS
        is emitted as its own chunk (only safe option given the constraint).
        """
        sub_chunks: List[List[_Sentence]] = []
        current_group: List[_Sentence] = []
        current_count = 0

        for sent in sentences:
            # A newline separator between different speaker lines costs
            # 1 extra token; same-speaker continuation is already accounted
            # for inside each sentence's token_count.
            sep_cost = 1 if current_group else 0

            if current_count + sep_cost + sent.token_count > self._max_tokens:
                if current_group:
                    sub_chunks.append(current_group)
                current_group = [sent]
                current_count = sent.token_count
            else:
                current_group.append(sent)
                current_count += sep_cost + sent.token_count

        if current_group:
            sub_chunks.append(current_group)

        return sub_chunks
