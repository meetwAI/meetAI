import asyncio
from typing import AsyncGenerator, Optional
from gladiaio_sdk import (
    GladiaClient,
    LiveV2InitRequest,
    LiveV2LanguageConfig,
    LiveV2MessagesConfig,
    LiveV2WebSocketMessage,
)

from src.integrations.transcription.BaseTranscription import BaseTranscription
from configs.settings import TranscriptionProviderConfig
from src.core.logging import logger


class GladiaTranscriptionProvider(BaseTranscription):
    """
    Gladia.io using official Python SDK (2025) — real-time transcription.
    Free tier: 50h/month. Docs: https://docs.gladia.io/chapters/live-stt/quickstart
    """

    def __init__(self, api_key: str, config: TranscriptionProviderConfig | None = None):
        super().__init__(config)
        
        logger.debug("Initializing GladiaTranscriptionProvider", extra={
            "has_api_key": api_key is not None,
            "api_key_length": len(api_key) if api_key else 0,
            "config_model": config.model if config else "No config",
        })
        
        if not api_key:
            logger.error("Gladia API key is missing!")
            raise ValueError("Gladia API key is required but was not provided!")
        
        try:
            self.client = GladiaClient(api_key=api_key)
            logger.debug("GladiaClient initialized successfully")
            
            self.live_client = self.client.live_v2_async()
            logger.info("Gladia live_v2_async client ready")
        except Exception as e:
            logger.error(f"Failed to initialize Gladia client", extra={"error": str(e)})
            raise

    async def transcribe_stream(
        self,
        audio_stream: AsyncGenerator[bytes, None],
        *,
        language: Optional[str] = None,
        **kwargs,
    ) -> AsyncGenerator[dict, None]:
        """
        Transcribe audio stream in real-time using Gladia SDK.
        """
        # Build init request - Note: no 'model' field in LiveV2InitRequest
        init_request = LiveV2InitRequest(
            encoding="wav/pcm",
            sample_rate=self.config.sample_rate,
            bit_depth=self.config.bit_depth,
            channels=self.config.channels,
            language_config=LiveV2LanguageConfig(
                languages=[language] if language else [],
                code_switching=False,
            ),
            messages_config=LiveV2MessagesConfig(
                receive_partial_transcripts=self.config.interim_results,
                receive_final_transcripts=True,
                receive_speech_events=True,
                receive_errors=True,
            ),
        )

        logger.debug("Starting Gladia session", extra={
            "sample_rate": self.config.sample_rate,
            "language": language or "auto",
        })

        # Start session - returns session object directly (no await needed)
        live_session = self.live_client.start_session(init_request)

        # Event queue for async communication
        event_queue: asyncio.Queue[dict] = asyncio.Queue()
        session_active = True

        def on_message(message: LiveV2WebSocketMessage):
            """Called by SDK when message arrives"""
            asyncio.create_task(event_queue.put({"type": "message", "data": message}))

        def on_error(error: Exception):
            """Called by SDK on error"""
            logger.error(f"Gladia error: {error}")
            asyncio.create_task(event_queue.put({"type": "error", "data": str(error)}))

        def on_started(response):
            """Called when session starts"""
            logger.info("Gladia session started", extra={"session_id": getattr(response, 'id', 'unknown')})

        def on_ended(ended):
            """Called when session ends"""
            nonlocal session_active
            session_active = False
            logger.info("Gladia session ended")
            asyncio.create_task(event_queue.put({"type": "ended"}))

        # Register event handlers
        live_session.on("message", on_message)
        live_session.on("error", on_error)
        live_session.once("started", on_started)
        live_session.once("ended", on_ended)

        try:
            # Send audio chunks in background
            async def send_audio():
                try:
                    chunk_count = 0
                    async for chunk in audio_stream:
                        if chunk and len(chunk) > 0:
                            live_session.send_audio(chunk)
                            chunk_count += 1
                            if chunk_count % 50 == 0:
                                logger.debug(f"Sent {chunk_count} audio chunks")
                    
                    logger.info(f"Audio stream ended, sent {chunk_count} chunks total")
                    live_session.stop_recording()
                except Exception as e:
                    logger.error(f"Error sending audio: {e}")
                    asyncio.create_task(event_queue.put({"type": "error", "data": str(e)}))

            send_task = asyncio.create_task(send_audio())

            # Process events from queue
            while session_active or not event_queue.empty():
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
                    
                    if event["type"] == "message":
                        async for result in self._process_message(event["data"]):
                            yield result
                    elif event["type"] == "error":
                        yield {"error": event["data"]}
                    elif event["type"] == "ended":
                        logger.debug("Session ended event received")
                        break
                        
                except asyncio.TimeoutError:
                    # Timeout is normal, just check if we should continue
                    if send_task.done() and event_queue.empty() and not session_active:
                        break
                    continue

            # Wait for send task to complete
            if not send_task.done():
                await send_task

        except Exception as e:
            logger.error(f"Transcription error: {e}", exc_info=True)
            yield {"error": str(e)}
        finally:
            try:
                await live_session.close()
                logger.info("Gladia session closed successfully")
            except Exception as e:
                logger.warning(f"Error closing session: {e}")

    async def _process_message(self, message: LiveV2WebSocketMessage):
        """Normalize SDK message to standard dict format"""
        msg_type = getattr(message, "type", None)

        if msg_type == "transcript":
            data = getattr(message, "data", None)
            if data:
                utterance = getattr(data, "utterance", None)
                text = getattr(utterance, "text", "") if utterance else ""
                is_final = getattr(data, "is_final", False)
                
                if text:  # Only yield non-empty transcripts
                    yield {
                        "text": text.strip(),
                        "is_final": is_final,
                        "start": getattr(data, "start", None),
                        "end": getattr(data, "end", None),
                        "language": getattr(data, "language", None),
                        "confidence": getattr(data, "confidence", None),
                    }

        elif msg_type == "speech_start":
            yield {
                "event": "speech_start",
                "timestamp": getattr(message, "timestamp", None)
            }

        elif msg_type == "speech_end":
            yield {
                "event": "speech_end",
                "timestamp": getattr(message, "timestamp", None)
            }

        elif msg_type == "error":
            yield {"error": str(getattr(message, "data", "Unknown error"))}

    async def close(self):
        """Cleanup resources"""
        logger.debug("GladiaTranscriptionProvider closed")
        pass