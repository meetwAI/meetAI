from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Literal

import yaml
import os

from pydantic import BaseModel, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent
PROVIDERS_YAML_PATH = BASE_DIR / "configs" / "providers.yaml"


# ——— Individual provider configs ———
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


class QnAProviderConfig(BaseModel):
    api_key: SecretStr | None = None
    model: str = "gpt-4o"
    temperature: float = 0.7


# ——— Module wrappers ———
class TranscriptionModuleConfig(BaseModel):
    default_provider: str = "gladia"
    providers: Dict[str, TranscriptionProviderConfig] = Field(default_factory=dict)


class QnAModuleConfig(BaseModel):
    default_provider: str = "openai"
    providers: Dict[str, QnAProviderConfig] = Field(default_factory=dict)


# ——— Top-level ———
class ProvidersConfig(BaseModel):
    transcription: TranscriptionModuleConfig = Field(default_factory=TranscriptionModuleConfig)
    qna: QnAModuleConfig = Field(default_factory=QnAModuleConfig)


# ——— Main Settings ———
class Settings(BaseSettings):
    PROJECT_NAME: str = "MeetAI"
    PROJECT_VERSION: str = "0.1.0"
    ENV: str = "DEV"
    LOG_LEVEL: str = "INFO"

    QNA_PREFIX: str 
    STREAMING_PREFIX: str

    GLADIA_API_KEY: str = ""  # Default to empty string to avoid validation errors

    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @classmethod
    def _load_providers_yaml(cls) -> dict:
        """Load and parse providers.yaml with environment variable resolution."""
        # CRITICAL: Load .env file first so os.getenv() can find the variables
        from dotenv import load_dotenv
        load_dotenv(BASE_DIR / ".env")
        
        if not PROVIDERS_YAML_PATH.exists():
            print(f"⚠️  providers.yaml not found at {PROVIDERS_YAML_PATH}")
            return {}

        with open(PROVIDERS_YAML_PATH) as f:
            raw = yaml.safe_load(f) or {}

        def resolve_env(val: Any) -> Any:
            """Recursively resolve ${ENV_VAR} references."""
            if isinstance(val, dict):
                return {k: resolve_env(v) for k, v in val.items()}
            if isinstance(val, list):
                return [resolve_env(v) for v in val]
            if isinstance(val, str) and val.startswith("${") and val.endswith("}"):
                key = val[2:-1]
                resolved = os.getenv(key)
                if resolved is None:
                    print(f"⚠️  Environment variable not found: {key}")
                    return ""  # Return empty string instead of None
                # Don't print the actual value for security
                print(f"✓ Resolved env var: {key}")
                return resolved
            return val

        resolved_data = resolve_env(raw)
        print(f"✓ Loaded providers.yaml from {PROVIDERS_YAML_PATH}")
        return resolved_data

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        yaml_data = self._load_providers_yaml()

        if not yaml_data:
            return

        # Build updated config from YAML
        transcription_providers = {}
        for name, cfg in yaml_data.get("transcription", {}).get("providers", {}).items():
            try:
                transcription_providers[name] = TranscriptionProviderConfig(**cfg)
                has_key = cfg.get("api_key") and cfg.get("api_key") != ""
                print(f"✓ Loaded transcription provider: {name} (has_api_key: {has_key})")
            except Exception as e:
                print(f"✗ Failed to load provider config: {name} - {e}")
                raise
        
        qna_providers = {
            name: QnAProviderConfig(**cfg)
            for name, cfg in yaml_data.get("qna", {}).get("providers", {}).items()
        }

        updated = ProvidersConfig(
            transcription=TranscriptionModuleConfig(
                default_provider=yaml_data.get("transcription", {}).get("default_provider", "gladia"),
                providers=transcription_providers,
            ),
            qna=QnAModuleConfig(
                default_provider=yaml_data.get("qna", {}).get("default_provider", "openai"),
                providers=qna_providers,
            ),
        )

        self.providers = updated
        print(f"✓ Provider configurations loaded successfully")


@lru_cache
def get_settings() -> Settings:
    return Settings()


# Singleton — import this everywhere
settings = get_settings()