from dataclasses import dataclass
from typing import Optional
import logging

import numpy as np

from src.core.config import settings
from src.core.timed_objects import FrontData, Silence, State
import time
from src.engines.online_asr import OnlineASRProcessor
from src.engines.vad import FixedVADIterator, OnnxWrapper
from src.app.pipeline.tokens_alignment import TokensAlignment
from src.app.pipeline.transcription_chunker import TranscriptionChunker


MIN_DURATION_REAL_SILENCE = 5.0
MIN_TRANSCRIPTION_BUFFER_SEC = 0.5
logger = logging.getLogger(__name__)


@dataclass
class _AlignmentArgs:
    diarization: bool = False


class AudioPipeline:
    def __init__(
        self,
        session_id: str,
        *,
        asr,
        diarization=None,
        vad_session=None,
        vad_threshold: float = 0.5,
        use_vad: bool = True,
        meeting_id: int = 0,
        user_id: int = 0,
        db_pool=None,
    ):
        self.session_id = session_id
        self.sample_rate = 16000
        self.state = State()
        self.transcription = OnlineASRProcessor(asr)
        self.diarization = diarization

        self.vad: Optional[FixedVADIterator] = None
        if use_vad and vad_session is not None:
            self.vad = FixedVADIterator(
                OnnxWrapper(session=vad_session), threshold=vad_threshold
            )

        self.current_silence: Optional[Silence] = None
        self.in_silence = False
        self.total_pcm_samples = 0
        self.pending_asr_duration = 0.0
        self.stopped = False

        self.tokens_alignment = TokensAlignment(
            self.state,
            _AlignmentArgs(diarization=bool(self.diarization)),
            self.transcription.asr.sep,
        )
        self.chunker = TranscriptionChunker(
            tokenizer=asr.tokenizer,
            window_seconds=settings.CHUNKING_WINDOW_SECONDS,
            max_tokens=settings.MAX_CHUNK_TOKENS,
            min_tokens=settings.MIN_CHUNK_TOKENS,
            meeting_id=meeting_id,
            user_id=user_id,
            db_pool=db_pool,
        )

    async def process_audio(self, pcm_bytes: bytes) -> dict:
        if self.stopped:
            return self._build_front_data()

        # if not pcm_bytes:
        #     return self._build_front_data()

        # # Guard against malformed frames (odd byte length), which would crash
        # # int16 decoding and restart the worker.
        # if len(pcm_bytes) % 2 != 0:
        #     logger.warning(
        #         "Skipping malformed PCM frame: session_id=%s byte_len=%s",
        #         self.session_id,
        #         len(pcm_bytes),
        #     )
        #     return self._build_front_data()

        pcm_array = (
            np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        )
        if pcm_array.size == 0:
            return self._build_front_data()

        chunk_duration = len(pcm_array) / self.sample_rate
        self.total_pcm_samples += len(pcm_array)

        if self.vad:
            vad_event = self.vad(pcm_array)
            if vad_event:
                self._handle_vad_event(vad_event)

        if self.diarization:
            self.diarization.insert_audio_chunk(pcm_array)
            while True:
                diar_segments = await self.diarization.diarize()
                if not diar_segments:
                    break
                self.state.new_diarization.extend(diar_segments)
                diar_end = max(getattr(s, "end", 0.0) for s in diar_segments)
                self.state.end_attributed_speaker = max(
                    self.state.end_attributed_speaker, diar_end
                )

        if not self.in_silence:
            self.transcription.insert_audio_chunk(
                pcm_array, self.total_pcm_samples / self.sample_rate
            )
            self.pending_asr_duration += chunk_duration
            if self.pending_asr_duration >= MIN_TRANSCRIPTION_BUFFER_SEC:
                self._process_transcription_iteration()

        return self._build_front_data()

    async def finish(self) -> dict:
        if self.stopped:
            return self._build_front_data()

        self.stopped = True

        if not self.in_silence and self.pending_asr_duration > 0:
            self._process_transcription_iteration()

        remaining_tokens, final_processed_upto = self.transcription.finish()
        remaining_tokens = remaining_tokens or []
        if remaining_tokens:
            self.state.tokens.extend(remaining_tokens)
            self.state.new_tokens.extend(remaining_tokens)

        self.state.end_buffer = max(self.state.end_buffer, final_processed_upto)

        if self.current_silence and not self.current_silence.has_ended:
            self.current_silence.end = self.total_pcm_samples / self.sample_rate
            self.current_silence.has_ended = True
            self.current_silence.is_starting = False
            self.current_silence.compute_duration()
            if (self.current_silence.duration or 0.0) >= MIN_DURATION_REAL_SILENCE:
                self.state.new_tokens.append(self.current_silence)
            self.current_silence = None

        if self.diarization:
            self.diarization.close()

        final_data = self._build_front_data()
        # Await the final chunk persist + topic-window flush so the worker
        # cannot pop this pipeline before the trailing data is safely in
        # Postgres. This is the WebSocket-close guarantee.
        await self.chunker.flush()
        return final_data

    def _handle_vad_event(self, event: dict) -> None:
        if "end" in event and not self.in_silence:
            silence_start = float(event["end"]) / self.sample_rate
            self.current_silence = Silence(start=silence_start, is_starting=True)
            self.in_silence = True

            committed_tokens, current_audio_processed_upto = (
                self.transcription.start_silence()
            )
            self.pending_asr_duration = 0.0
            self._apply_transcription_output(
                committed_tokens or [], current_audio_processed_upto
            )

        if "start" in event and self.in_silence and self.current_silence:
            silence_end = float(event["start"]) / self.sample_rate
            self.current_silence.end = silence_end
            self.current_silence.has_ended = True
            self.current_silence.is_starting = False
            self.current_silence.compute_duration()
            duration = self.current_silence.duration or 0.0

            self.transcription.end_silence(
                duration,
                self.state.tokens[-1].end if self.state.tokens else 0.0,
            )

            if duration >= MIN_DURATION_REAL_SILENCE:
                self.state.new_tokens.append(self.current_silence)

            if self.diarization:
                self.diarization.insert_silence(duration)

            self.current_silence = None
            self.in_silence = False

    def _process_transcription_iteration(self) -> None:
        committed_tokens, current_audio_processed_upto = (
            self.transcription.process_iter()
        )
        self.pending_asr_duration = 0.0
        self._apply_transcription_output(
            committed_tokens or [], current_audio_processed_upto
        )

    def _apply_transcription_output(
        self, committed_tokens: list, current_audio_processed_upto: float
    ) -> None:
        buffer_transcript = self.transcription.get_buffer()

        self.state.tokens.extend(committed_tokens)
        self.state.new_tokens.extend(committed_tokens)
        self.state.new_tokens_buffer = buffer_transcript
        self.state.buffer_transcription = buffer_transcript

        candidate_end_times = [self.state.end_buffer, current_audio_processed_upto]
        if committed_tokens:
            candidate_end_times.append(committed_tokens[-1].end)
        if buffer_transcript.end is not None:
            candidate_end_times.append(buffer_transcript.end)
        self.state.end_buffer = max(candidate_end_times)
        self.chunker.add_tokens(committed_tokens)

    def _build_front_data(self) -> dict:
        self.tokens_alignment.update()
        lines, buffer_diarization, _ = self.tokens_alignment.get_lines(
            diarization=bool(self.diarization),
            translation=False,
            current_silence=self.current_silence,
            audio_time=self.total_pcm_samples / self.sample_rate,
        )
        buffer_transcription = (
            self.state.buffer_transcription.text
            if self.state.buffer_transcription
            else ""
        )

        status = "active_transcription"
        if not lines and not buffer_transcription and not buffer_diarization:
            status = "no_audio_detected"

        payload = FrontData(
            status=status,
            lines=lines,
            buffer_transcription=buffer_transcription,
            buffer_diarization=buffer_diarization,
            buffer_translation="",
            remaining_time_transcription=0.0,
            remaining_time_diarization=0.0,
        )
        return payload.to_dict()
