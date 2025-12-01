from typing import Dict, Type, Optional
from src.core.logging import logger
from .BaseTranscription import BaseTranscription
from .Gladio import GladiaTranscriptionProvider
# from .deepgram import DeepgramTranscriptionProvider
# from .faster_whisper import FasterWhisperProvider
# from .openai import OpenAIRealtimeProvider

# Registry of all available providers
TRANSCRIPTION_PROVIDERS: Dict[str, Type[BaseTranscription]] = {
    "gladia": GladiaTranscriptionProvider,
    # "deepgram": DeepgramTranscriptionProvider,
    # "faster_whisper": FasterWhisperProvider,
    # "openai": OpenAIRealtimeProvider,
}
def get_transcription_provider(
    name: Optional[str] = None,
    **override_kwargs,
) -> BaseTranscription:
    """
    Factory function — used everywhere (routes, services, tests).
    Automatically reads from settings if name is None.
    """
    from configs.settings import settings
    from src.core.logging import logger

    # 1. Determine which provider to use
    provider_name = name or settings.providers.transcription.default_provider
    logger.debug(f"Using transcription provider", extra={"provider": provider_name})

    if provider_name not in TRANSCRIPTION_PROVIDERS:
        raise ValueError(
            f"Unknown transcription provider: {provider_name}\n"
            f"Available: {list(TRANSCRIPTION_PROVIDERS.keys())}"
        )

    # 2. Get config from settings
    try:
        config_obj = settings.providers.transcription.providers[provider_name]
        logger.debug(f"Config loaded", extra={
            "provider": provider_name,
            "has_api_key": hasattr(config_obj, "api_key") and config_obj.api_key is not None,
            "model": getattr(config_obj, "model", "N/A")
        })
    except KeyError:
        raise ValueError(f"Provider '{provider_name}' not configured in providers.yaml")

    # 3. Extract api_key (most providers need it)
    api_key = None
    if hasattr(config_obj, "api_key") and config_obj.api_key:
        api_key = config_obj.api_key.get_secret_value()
        logger.debug(f"API key extracted", extra={
            "key_length": len(api_key) if api_key else 0,
            "key_preview": api_key[:10] + "..." if api_key else "None"
        })
    else:
        logger.warning(f"No API key found in config for provider: {provider_name}")

    # 4. Apply any overrides to the config object if provided
    if override_kwargs:
        logger.debug(f"Applying config overrides", extra={"overrides": override_kwargs})
        config_dict = config_obj.model_dump(exclude={"api_key"})
        config_dict.update(override_kwargs)
        config_obj = type(config_obj)(**config_dict)

    # 5. Instantiate and return
    provider_class = TRANSCRIPTION_PROVIDERS[provider_name]
    logger.info(f"Instantiating transcription provider", extra={
        "class": provider_class.__name__,
        "has_api_key": api_key is not None
    })
    return provider_class(api_key=api_key, config=config_obj)