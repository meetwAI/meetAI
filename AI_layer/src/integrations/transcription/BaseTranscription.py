from src.integrations.BaseProvider import BaseProvider, ProviderConfig
from typing import Literal, AsyncGenerator, Optional
from abc import abstractmethod
from pydantic import BaseModel, SecretStr

class TranscriptionProviderConfig(BaseModel):
    api_key: SecretStr | None = None
    model: str = "base"
    language: str | None = "en"
    device: Literal["cpu", "cuda", "mps", "auto"] | None = None
    compute_type: Literal["float16", "int8", "float32"] | None = None
    base_url: str | None = None
    download_root: str | None = None
    punctuate: bool = True
    interim_results: bool = True
    
    # Gladia-specific fields
    sample_rate: int = 16000
    bit_depth: int = 16
    channels: int = 1

class BaseTranscription(BaseProvider):
    """
    Transcription-specific abstraction.
    Every real provider (local, openai, deepgram)
    """
    def __init__(self, config: ProviderConfig | None = None):
        super().__init__(config)
        self.config : TranscriptionConfig = config or TranscriptionConfig()

    @abstractmethod
    async def transcribe_stream(
        self,
        audio_stream : AsyncGenerator[bytes, None],
        *,
        language : Optional[str] = None,
        **kwargs,
    )-> AsyncGenerator[dict, None]:
        """ALL transcription providers must normalize to the same event format"""
        yield # type: ignore

    # @abstractmethod
    # async def transcribe_file(self, audio_bytes: bytes, filename: str) -> str:
    #     """Batch transcription — used by 90% of backends"""
    #     pass

    async def load_model(self):
        """Called once at startup for local models. Cloud providers can no-op."""
        pass

    async def unload_model(self):
        """Free VRAM / memory"""
        pass