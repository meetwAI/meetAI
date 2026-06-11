import logging
from typing import List, Optional

import numpy as np

from aiengine.models.timed import ASRToken


logger = logging.getLogger(__name__)


class FasterWhisperASR:
    sep = ""

    def __init__(
        self,
        language: str = "en",
        model_size: str = "small",
        model_dir: Optional[str] = None,
        cache_dir: Optional[str] = None,
        device: str = "auto",
        compute_type: str = "auto",
        buffer_trimming: str = "segment",
        buffer_trimming_sec: float = 15.0,
        confidence_validation: bool = False,
        use_auth_token: str = "",
    ):
        self.original_language = None if language == "auto" else language
        self.buffer_trimming = buffer_trimming
        self.buffer_trimming_sec = buffer_trimming_sec
        self.confidence_validation = confidence_validation
        self.tokenizer = None
        self.transcribe_kargs: dict = {}

        self._device = device
        self._compute_type = compute_type
        self._model_size = model_size
        self._model_dir = model_dir
        self._cache_dir = cache_dir

        self.use_auth_token = use_auth_token
        self.model = self.load_model()
        self._log_runtime_device()
        self._detected_language = self.original_language

        

    def load_model(self):
        from faster_whisper import WhisperModel
        from huggingface_hub import login
        
        # Log in first if a token is provided
        if self.use_auth_token:
            login(token=self.use_auth_token)

        model_size_or_path = self._model_dir if self._model_dir else self._model_size
        logger.info(
            "Loading FasterWhisper model=%s device=%s compute_type=%s",
            model_size_or_path,
            self._device,
            self._compute_type,
        )
        return WhisperModel(
            model_size_or_path,
            device=self._device,
            compute_type=self._compute_type,
            download_root=self._cache_dir,
        )

    def _log_runtime_device(self):
        model_device = getattr(self.model, "device", None)
        model_inner = getattr(self.model, "model", None)
        inner_device = getattr(model_inner, "device", None) if model_inner else None
        logger.info(
            "FasterWhisper runtime initialized: requested_device=%s requested_compute_type=%s runtime_device=%s inner_device=%s",
            self._device,
            self._compute_type,
            model_device,
            inner_device,
        )

    def transcribe(self, audio: np.ndarray, init_prompt: str = "") -> list:
        segments, info = self.model.transcribe(
            audio,
            language=self.original_language,
            initial_prompt=init_prompt,
            beam_size=2,
            word_timestamps=True,
            condition_on_previous_text=False, # Default True
            
            compression_ratio_threshold=None,
            temperature=0.0,                  # no sampling fallback retries
            best_of=1,
            log_prob_threshold=None,          # skips log prob check
            no_speech_threshold=None,

            **self.transcribe_kargs,
        )
        if info is not None and getattr(info, "language", None):
            self._detected_language = info.language
        return list(segments)

    def ts_words(self, segments) -> List[ASRToken]:
        tokens: List[ASRToken] = []
        for segment in segments:
            if getattr(segment, "no_speech_prob", 0.0) > 0.9:
                continue
            for word in segment.words:
                tokens.append(
                    ASRToken(
                        word.start,
                        word.end,
                        word.word,
                        probability=word.probability,
                        detected_language=self._detected_language,
                    )
                )
        return tokens

    def segments_end_ts(self, segments) -> List[float]:
        return [segment.end for segment in segments]

    def use_vad(self):
        self.transcribe_kargs["vad_filter"] = True
