import logging
import threading
import wave
from typing import List, Optional

import numpy as np
import torch

from aiengine.models.timed import SpeakerSegment


logger = logging.getLogger(__name__)


class StreamingSortformerState:
    def __init__(self):
        self.spkcache = None
        self.spkcache_lengths = None
        self.spkcache_preds = None
        self.fifo = None
        self.fifo_lengths = None
        self.fifo_preds = None
        self.spk_perm = None
        self.mean_sil_emb = None
        self.n_sil_frames = None


class SortformerDiarization:
    def __init__(
        self,
        model_name: str = "nvidia/diar_streaming_sortformer_4spk-v2",
        require_gpu: bool = True,
    ):
        self._load_model(model_name, require_gpu=require_gpu)

    def _load_model(self, model_name: str, require_gpu: bool = True):
        try:
            from nemo.collections.asr.models import SortformerEncLabelModel
        except ImportError as exc:
            raise ImportError(
                "Sortformer diarization requires NeMo. Install: "
                'pip install "git+https://github.com/NVIDIA/NeMo.git@main#egg=nemo_toolkit[asr]"'
            ) from exc

        cuda_available = torch.cuda.is_available()
        if require_gpu and not cuda_available:
            raise RuntimeError(
                "DIARIZATION_REQUIRE_GPU=true but CUDA is not available."
            )

        self.diar_model = SortformerEncLabelModel.from_pretrained(model_name)
        self.diar_model.eval()
        device = torch.device("cuda" if cuda_available else "cpu")
        self.diar_model.to(device)
        logger.info(
            "Sortformer loaded on device=%s cuda_available=%s",
            device.type.upper(),
            cuda_available,
        )

        self.diar_model.sortformer_modules.chunk_len = 10
        self.diar_model.sortformer_modules.subsampling_factor = 10
        self.diar_model.sortformer_modules.chunk_right_context = 0
        self.diar_model.sortformer_modules.chunk_left_context = 10
        self.diar_model.sortformer_modules.spkcache_len = 188
        self.diar_model.sortformer_modules.fifo_len = 188
        self.diar_model.sortformer_modules.spkcache_update_period = 144
        self.diar_model.sortformer_modules.log = False
        self.diar_model.sortformer_modules._check_streaming_parameters()


class SortformerDiarizationOnline:
    def __init__(self, shared_model: SortformerDiarization, sample_rate: int = 16000):
        try:
            from nemo.collections.asr.modules import AudioToMelSpectrogramPreprocessor
        except ImportError as exc:
            raise ImportError(
                "NeMo is required for SortformerDiarizationOnline"
            ) from exc

        self.sample_rate = sample_rate
        self.diarization_segments = []
        self.buffer_audio = np.array([], dtype=np.float32)
        self.segment_lock = threading.Lock()
        self.global_time_offset = 0.0
        self.debug = False

        self.diar_model = shared_model.diar_model
        self.audio2mel = AudioToMelSpectrogramPreprocessor(
            window_size=0.025,
            normalize="NA",
            n_fft=512,
            features=128,
            pad_to=0,
        )
        self.audio2mel.to(self.diar_model.device)

        self.chunk_duration_seconds = (
            self.diar_model.sortformer_modules.chunk_len
            * self.diar_model.sortformer_modules.subsampling_factor
            * self.diar_model.preprocessor._cfg.window_stride
        )

        self._init_streaming_state()
        self._previous_chunk_features = None
        self._chunk_index = 0
        self._len_prediction = None
        self.audio_buffer = []

    def _init_streaming_state(self):
        batch_size = 1
        device = self.diar_model.device
        modules = self.diar_model.sortformer_modules

        self.streaming_state = StreamingSortformerState()
        self.streaming_state.spkcache = torch.zeros(
            (batch_size, modules.spkcache_len, modules.fc_d_model), device=device
        )
        self.streaming_state.spkcache_preds = torch.zeros(
            (batch_size, modules.spkcache_len, modules.n_spk), device=device
        )
        self.streaming_state.spkcache_lengths = torch.zeros(
            (batch_size,), dtype=torch.long, device=device
        )
        self.streaming_state.fifo = torch.zeros(
            (batch_size, modules.fifo_len, modules.fc_d_model), device=device
        )
        self.streaming_state.fifo_lengths = torch.zeros(
            (batch_size,), dtype=torch.long, device=device
        )
        self.streaming_state.mean_sil_emb = torch.zeros(
            (batch_size, modules.fc_d_model), device=device
        )
        self.streaming_state.n_sil_frames = torch.zeros(
            (batch_size,), dtype=torch.long, device=device
        )
        self.total_preds = torch.zeros((batch_size, 0, modules.n_spk), device=device)

    def insert_silence(self, silence_duration: Optional[float]):
        if not silence_duration:
            return
        with self.segment_lock:
            self.global_time_offset += silence_duration

    def insert_audio_chunk(self, pcm_array: np.ndarray):
        if self.debug:
            self.audio_buffer.append(pcm_array.copy())
        self.buffer_audio = np.concatenate([self.buffer_audio, pcm_array.copy()])

    async def diarize(self):
        threshold = int(self.chunk_duration_seconds * self.sample_rate)
        if len(self.buffer_audio) < threshold:
            return []

        audio = self.buffer_audio[:threshold]
        self.buffer_audio = self.buffer_audio[threshold:]

        device = self.diar_model.device
        audio_signal_chunk = torch.tensor(audio, device=device).unsqueeze(0)
        audio_signal_length_chunk = torch.tensor(
            [audio_signal_chunk.shape[1]], device=device
        )

        processed_signal_chunk, _ = self.audio2mel.get_features(
            audio_signal_chunk, audio_signal_length_chunk
        )
        processed_signal_chunk = processed_signal_chunk.to(device)

        if self._previous_chunk_features is not None:
            to_add = self._previous_chunk_features[:, :, -99:].to(device)
            total_features = torch.concat([to_add, processed_signal_chunk], dim=2).to(
                device
            )
        else:
            total_features = processed_signal_chunk.to(device)

        self._previous_chunk_features = processed_signal_chunk.to(device)
        chunk_feat_seq_t = torch.transpose(total_features, 1, 2).to(device)

        with torch.inference_mode():
            left_offset = 8 if self._chunk_index > 0 else 0
            right_offset = 8
            self.streaming_state, self.total_preds = (
                self.diar_model.forward_streaming_step(
                    processed_signal=chunk_feat_seq_t,
                    processed_signal_length=torch.tensor(
                        [chunk_feat_seq_t.shape[1]]
                    ).to(device),
                    streaming_state=self.streaming_state,
                    total_preds=self.total_preds,
                    left_offset=left_offset,
                    right_offset=right_offset,
                )
            )

        new_segments = self._process_predictions()
        self._chunk_index += 1
        return new_segments

    def _process_predictions(self):
        preds_np = self.total_preds[0].cpu().numpy()
        active_speakers = np.argmax(preds_np, axis=1)

        if self._len_prediction is None:
            self._len_prediction = len(active_speakers)

        frame_duration = self.chunk_duration_seconds / self._len_prediction
        current_chunk_preds = active_speakers[-self._len_prediction :]

        new_segments = []
        with self.segment_lock:
            base_time = (
                self._chunk_index * self.chunk_duration_seconds
                + self.global_time_offset
            )
            current_spk = current_chunk_preds[0]
            start_time = round(base_time, 2)
            current_time = start_time
            for idx, spk in enumerate(current_chunk_preds):
                current_time = round(base_time + idx * frame_duration, 2)
                if spk != current_spk:
                    new_segments.append(
                        SpeakerSegment(
                            speaker=current_spk, start=start_time, end=current_time
                        )
                    )
                    start_time = current_time
                    current_spk = spk
            new_segments.append(
                SpeakerSegment(speaker=current_spk, start=start_time, end=current_time)
            )
        return new_segments

    def get_segments(self) -> List[SpeakerSegment]:
        with self.segment_lock:
            return self.diarization_segments.copy()

    def close(self):
        logger.info("Closing SortformerDiarization")
        with self.segment_lock:
            self.diarization_segments.clear()

        if self.debug and self.audio_buffer:
            concatenated_audio = np.concatenate(self.audio_buffer)
            audio_data_int16 = (concatenated_audio * 32767).astype(np.int16)
            with wave.open("diarization_audio.wav", "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(audio_data_int16.tobytes())
