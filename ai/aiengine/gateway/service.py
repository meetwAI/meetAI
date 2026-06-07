import asyncio
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from aiengine.config.settings import settings
from aiengine.broker.audio import AudioBroker


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import socket
    logger.info("Standalone ASR Gateway starting (hosted on %s)", socket.gethostname())
    app.state.broker = AudioBroker(
        settings.REDIS_URL, stream_maxlen=settings.REDIS_STREAM_MAXLEN
    )
    app.state.active_sessions = set()
    app.state.session_context = {}
    yield
    await app.state.broker.close()


# The legacy demo UI under src/web/static was removed in the CHECKPOINT2 → ai-engine
# refactor; the React client at client/meetai-web is now the only consumer and
# only uses /health and the /asr websocket. No StaticFiles mount needed.
app = FastAPI(title="Standalone ASR Gateway", lifespan=lifespan)


@app.get("/health")
async def health():
    return JSONResponse({"ok": True, "active_sessions": len(app.state.active_sessions)})


@app.websocket("/asr")
async def websocket_asr(websocket: WebSocket):
    raw_user_id = websocket.query_params.get("user_id", "")
    raw_meeting_id = websocket.query_params.get("meeting_id", "")

    try:
        user_id = int(raw_user_id)
        meeting_id = int(raw_meeting_id)
    except (TypeError, ValueError):
        await websocket.close(code=1008, reason="Missing user_id or meeting_id")
        return

    if user_id <= 0 or meeting_id <= 0:
        await websocket.close(code=1008, reason="Invalid user_id or meeting_id")
        return

    if len(app.state.active_sessions) >= settings.MAX_SESSIONS:
        await websocket.close(code=1013, reason="Server capacity reached")
        return

    await websocket.accept()

    session_id = uuid.uuid4().hex
    app.state.active_sessions.add(session_id)
    app.state.session_context[session_id] = {
        "user_id": user_id,
        "meeting_id": meeting_id,
    }
    logger.info(
        "ASR session started: session_id=%s user_id=%s meeting_id=%s",
        session_id,
        user_id,
        meeting_id,
    )
    broker: AudioBroker = app.state.broker

    await broker.register_session(
        session_id,
        settings.NUM_WORKERS,
        meeting_id=meeting_id,
        user_id=user_id,
    )

    await websocket.send_json(
        {
            "type": "config",
            "session_id": session_id,
            "sample_rate": 16000,
            "encoding": "s16le",
            "channels": 1,
            "useAudioWorklet": True,
            "user_id": user_id,
            "meeting_id": meeting_id,
        }
    )

    stop_event = asyncio.Event()

    async def relay_results():
        try:
            async for result in broker.consume_results(session_id, start_id="$"):
                result["user_id"] = user_id
                result["meeting_id"] = meeting_id
                await websocket.send_json(result)
                if result.get("type") == "ready_to_stop":
                    stop_event.set()
                    return
        except Exception:
            stop_event.set()

    relay_task = asyncio.create_task(relay_results())

    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type")
            if msg_type == "websocket.disconnect":
                break

            chunk = message.get("bytes")
            if chunk is None:
                text = message.get("text")
                if text:
                    continue
                chunk = b""

            if len(chunk) == 0:
                await broker.unregister_session(session_id, settings.NUM_WORKERS)
                await stop_event.wait()
                break

            await broker.publish_audio(session_id, chunk, settings.NUM_WORKERS)

    except WebSocketDisconnect:
        pass
    finally:
        await broker.unregister_session(session_id, settings.NUM_WORKERS)
        app.state.active_sessions.discard(session_id)
        app.state.session_context.pop(session_id, None)
        logger.info(
            "ASR session closed: session_id=%s user_id=%s meeting_id=%s",
            session_id,
            user_id,
            meeting_id,
        )
        relay_task.cancel()
        await asyncio.gather(relay_task, return_exceptions=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "aiengine.gateway.service:app", host=settings.HOST, port=settings.PORT, reload=False
    )
