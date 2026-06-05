"""
chunk_models.py
---------------
Shared data structures for the transcription chunking pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from aiengine.models.timed import ASRToken


@dataclass
class _SpeakerRun:
    """A contiguous run of tokens belonging to one speaker."""

    speaker: str
    tokens: List[ASRToken] = field(default_factory=list)

    @property
    def start(self) -> float:
        return self.tokens[0].start if self.tokens else 0.0

    @property
    def end(self) -> float:
        return self.tokens[-1].end if self.tokens else 0.0


@dataclass
class _Sentence:
    """A sentence extracted from a single-speaker run."""

    speaker: int
    text: str
    start: float
    end: float
    token_count: int  # tiktoken count for the rendered "speaker_N: <text>" form
