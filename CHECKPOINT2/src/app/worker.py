import asyncio
import logging

from src.core.config import settings
from src.engines.asr_backend import FasterWhisperASR
from src.engines.diarization import SortformerDiarization, SortformerDiarizationOnline
from src.engines.vad import load_onnx_session
from src.infra.broker import AudioBroker
from src.infra.db import create_pool, close_pool
from src.pipeline.audio_pipeline import AudioPipeline


logging.basicConfig(level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO))
logger = logging.getLogger(__name__)


class WorkerRuntime:
    def __init__(self):
        self.broker = AudioBroker(
            settings.REDIS_URL, stream_maxlen=settings.REDIS_STREAM_MAXLEN
        )
        self.pipelines: dict[str, AudioPipeline] = {}
        self.closed_sessions: set[str] = set()
        # Stores {session_id: {"meeting_id": int, "user_id": int}}
        self.session_meta: dict[str, dict] = {}
        self.db_pool = None  # initialised in run()

        self.asr = FasterWhisperASR(
            language=settings.WHISPER_LANGUAGE,
            model_size=settings.WHISPER_MODEL_SIZE,
            device=settings.WHISPER_DEVICE,
            compute_type=settings.WHISPER_COMPUTE_TYPE,
            buffer_trimming=settings.BUFFER_TRIMMING,
            buffer_trimming_sec=settings.BUFFER_TRIMMING_SEC,
            confidence_validation=settings.CONFIDENCE_VALIDATION,
        )

        self.vad_session = None
        if settings.VAD_ENABLED:
            self.vad_session = load_onnx_session(force_onnx_cpu=settings.VAD_FORCE_CPU)

        self.shared_diarization = None
        if settings.DIARIZATION_ENABLED:
            try:
                self.shared_diarization = SortformerDiarization(
                    settings.DIARIZATION_MODEL_NAME
                )
            except Exception as exc:
                logger.exception(
                    "Failed to initialize diarization model '%s'; continuing without diarization.",
                    settings.DIARIZATION_MODEL_NAME,
                )
                logger.warning("Diarization disabled for this worker: %s", exc)

    def _create_pipeline(self, session_id: str, meeting_id: int, user_id: int) -> AudioPipeline:
        diarization = None
        if self.shared_diarization is not None:
            diarization = SortformerDiarizationOnline(self.shared_diarization)

        return AudioPipeline(
            session_id,
            asr=self.asr,
            diarization=diarization,
            vad_session=self.vad_session,
            vad_threshold=settings.VAD_THRESHOLD,
            use_vad=settings.VAD_ENABLED,
            meeting_id=meeting_id,
            user_id=user_id,
            db_pool=self.db_pool,
        )

    async def run(self):
        self.db_pool = await create_pool(settings.DATABASE_URL)
        logger.info(
            "Worker started: worker_id=%s num_workers=%s",
            settings.WORKER_ID,
            settings.NUM_WORKERS,
        )
        async for event in self.broker.consume_audio(settings.WORKER_ID, start_id="$"):
            session_id = event["session_id"]
            event_type = event["type"]

            if event_type == "register":
                self.closed_sessions.discard(session_id)
                meeting_id = event.get("meeting_id", 0)
                user_id = event.get("user_id", 0)
                self.session_meta[session_id] = {
                    "meeting_id": meeting_id,
                    "user_id": user_id,
                }
                if session_id not in self.pipelines:
                    self.pipelines[session_id] = self._create_pipeline(
                        session_id, meeting_id, user_id
                    )
                continue

            if event_type == "close":
                self.closed_sessions.add(session_id)
                pipeline = self.pipelines.pop(session_id, None)
                self.session_meta.pop(session_id, None)
                if pipeline is not None:
                    final_payload = await pipeline.finish()
                    await self.broker.publish_result(session_id, final_payload)
                await self.broker.publish_result(session_id, {"type": "ready_to_stop"})
                continue

            if event_type != "audio":
                continue

            if session_id in self.closed_sessions:
                continue

            pipeline = self.pipelines.get(session_id)
            if pipeline is None:
                meta = self.session_meta.get(session_id, {})
                pipeline = self._create_pipeline(
                    session_id,
                    meta.get("meeting_id", 0),
                    meta.get("user_id", 0),
                )
                self.pipelines[session_id] = pipeline

            payload = await pipeline.process_audio(event["pcm"])
            await self.broker.publish_result(session_id, payload)

    async def close(self):
        logger.info("Flushing pipelines before shutdown...")
        for session_id, pipeline in self.pipelines.items():
            try:
                await pipeline.finish()
            except Exception:
                logger.exception("Failed to flush pipeline for session %s", session_id)
        self.pipelines.clear()
        await self.broker.close()
        if self.db_pool is not None:
            await close_pool(self.db_pool)


async def _main():
    runtime = WorkerRuntime()
    try:
        await runtime.run()
    finally:
        await runtime.close()


if __name__ == "__main__":
    asyncio.run(_main())
