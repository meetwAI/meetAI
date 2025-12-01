from __future__ import annotations

from fastapi import Depends
from src.api.routes.BaseRouter import Router
from configs.settings import settings
from fastapi import status, WebSocket, WebSocketDisconnect
from src.integrations.transcription import get_transcription_provider

class StreamingRouter(Router):
    def __init__(self, dependencies: list | None = None):
        super().__init__(
            dependencies=dependencies,
            prefix = settings.STREAMING_PREFIX, 
            tags = ["Streaming", "Bidirectional"], 
            )
        
    def _setup_routes(self) -> None:
        @self.router.get(
            "/health",
            status_code=status.HTTP_200_OK,
            summary= "Health check for streaming router",
            description= "Check if the streaming service is opertional or not"
        )
        async def health_check():
            """Simple health check for the streaming router"""
            return {"status": "healthy", "service": "streaming"}
        
        @self.router.websocket(
            "/",
        )
        async def stream(websocket: WebSocket):
            await websocket.accept()
    
            # Optional: receive initial config (language, model, etc.)
            try:
                init_data = await websocket.receive_json()
                language = init_data.get("language")
                print(f"Client requested language: {language}")
            except:
                language = None

            # Get provider (gladia via SDK, or any other)
            provider = get_transcription_provider()

            # Generator that reads raw bytes from the WebSocket
            async def audio_stream():
                try:
                    while True:
                        message = await websocket.receive()
                        if "bytes" in message:
                            data = message["bytes"]
                            if len(data) == 0:
                                continue
                            yield data
                        elif "text" in message:
                            # Client can send JSON commands (e.g. {"type": "stop"})
                            pass
                except WebSocketDisconnect:
                    print("Client disconnected")
                    return

            try:
                async for event in provider.transcribe_stream(audio_stream(), language=language):
                    await websocket.send_json(event)
            # ← sends {"text": "...", "is_final": true}
            except Exception as e:
                await websocket.send_json({"error": str(e)})
            finally:
                await websocket.close()