from abc import ABC, abstractmethod
from typing import Any, AsyncGenerator, Protocol
from pydantic import BaseModel

class ProviderConfig(BaseModel):
    """Shared config model – every provider gets one"""
    model: str = "default"
    temperature: float = 0.7
    language: str | None = None
    # and other params that are shared across any and all providers.

class BaseProvider(ABC):
    """
    Absolute minimal shared interface.
    Only things that literally every single provider (transcription, QnA, summarizationhas.
    """
    def __init__(self, config: ProviderConfig | None = None):
        self.config = config or ProviderConfig()

    @abstractmethod
    async def close(self):
        """Optional graceful shutdown (connections, threads, etc.)"""
        pass