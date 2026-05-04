from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    REDIS_URL: str = Field(default="redis://localhost:6379/0")
    REDIS_STREAM_MAXLEN: int = Field(default=5000)

    WHISPER_MODEL_SIZE: str = Field(default="small")
    WHISPER_LANGUAGE: str = Field(default="en")
    WHISPER_COMPUTE_TYPE: str = Field(default="auto")
    WHISPER_DEVICE: str = Field(default="auto")
    BUFFER_TRIMMING: str = Field(default="segment")
    BUFFER_TRIMMING_SEC: float = Field(default=15.0)
    CONFIDENCE_VALIDATION: bool = Field(default=False)

    DIARIZATION_ENABLED: bool = Field(default=False)
    DIARIZATION_MODEL_NAME: str = Field(
        default="nvidia/diar_streaming_sortformer_4spk-v2"
    )

    VAD_ENABLED: bool = Field(default=True)
    VAD_THRESHOLD: float = Field(default=0.5)
    VAD_FORCE_CPU: bool = Field(default=True)

    MAX_CHUNK_TOKENS: int = Field(default=100)
    MIN_CHUNK_TOKENS: int = Field(default=20)
    CHUNKING_WINDOW_SECONDS: float = Field(default=30.0)
    CHUNKER_ENCODER : str = Field(default="cl100k_base")

    NUM_WORKERS: int = Field(default=1)
    WORKER_ID: int = Field(default=0)

    TOPIC_EXTRACTION_ENABLED: bool = Field(default=True)
    TOPIC_WINDOW_SECONDS: float = Field(default=300.0)
    TOPIC_SIMILARITY_THRESHOLD: float = Field(default=0.85)
    GEMINI_API_KEY: str = Field(default="")
    GEMINI_MODEL: str = Field(default="gemini-2.5-flash")

    DATABASE_URL: str = Field(default="postgresql://meetai:meetai_pass@localhost:5433/meetai_dev")

    HOST: str = Field(default="0.0.0.0")
    PORT: int = Field(default=8000)
    LOG_LEVEL: str = Field(default="INFO")
    MAX_SESSIONS: int = Field(default=100)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
