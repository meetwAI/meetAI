def __init__(self, **kwargs):
    super().__init__(**kwargs)
    
    # Import logger here to avoid circular imports
    from src.core.logging import logger

    yaml_data = self._load_providers_yaml()

    if not yaml_data:
        logger.warning("No providers.yaml found or it's empty")
        return

    logger.debug("Loaded providers.yaml", extra={
        "transcription_providers": list(yaml_data.get("transcription", {}).get("providers", {}).keys()),
        "default_transcription": yaml_data.get("transcription", {}).get("default_provider")
    })

    # Build updated config from YAML
    transcription_providers = {}
    for name, cfg in yaml_data.get("transcription", {}).get("providers", {}).items():
        try:
            transcription_providers[name] = TranscriptionProviderConfig(**cfg)
            logger.debug(f"Loaded transcription provider config: {name}", extra={
                "has_api_key": "api_key" in cfg and cfg["api_key"],
                "model": cfg.get("model", "N/A")
            })
        except Exception as e:
            logger.error(f"Failed to load provider config: {name}", extra={"error": str(e)})
            raise
    
    qna_providers = {
        name: QnAProviderConfig(**cfg)
        for name, cfg in yaml_data.get("qna", {}).get("providers", {}).items()
    }

    updated = ProvidersConfig(
        transcription=TranscriptionModuleConfig(
            default_provider=yaml_data.get("transcription", {}).get("default_provider", "deepgram"),
            providers=transcription_providers,
        ),
        qna=QnAModuleConfig(
            default_provider=yaml_data.get("qna", {}).get("default_provider", "openai"),
            providers=qna_providers,
        ),
    )

    self.providers = updated
    logger.info("Provider configurations loaded successfully")