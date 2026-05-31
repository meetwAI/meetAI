# Standalone Realtime ASR Service

Minimal standalone service for realtime transcription (FasterWhisper), optional diarization (Sortformer), and optional Silero VAD, using Redis streams between a WebSocket gateway and worker.

## Folder layout

```text
src/
  app/        # runtime entrypoints
  core/       # settings and shared data models
  engines/    # asr/vad/diarization backends
  pipeline/   # per-session processing + alignment
  infra/      # redis broker
  web/static/ # browser UI (tab share / mic)
  models/     # bundled model files (silero)
  deploy/     # docker artifacts
```

## Quick start (local)

1) Install deps (from project root):

```bash
./install_deps.sh
```

By default, `install_deps.sh` creates `.venv` with `--system-site-packages` and reuses an existing `torch==2.7.1` with CUDA `12.6` instead of downloading torch again.

2) Start Redis:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

3) Start worker (new terminal, from project root):

```bash
source .venv/bin/activate
python -m src.app.worker
```

4) Start gateway (new terminal, from project root):

```bash
source .venv/bin/activate
python -m src.app.server
```

5) Open UI:

`http://localhost:8000`

Click **Share Tab** for browser tab audio capture (or **Use Microphone**).

### One-command startup

From project root, you can start Redis + worker(s) + gateway with readiness checks:

```bash
./start_server.sh --workers 1
```

Useful options:
- `--workers N` to start multiple workers (`WORKER_ID` 0..N-1)
- `--no-redis` when using an external Redis (`REDIS_URL`)

Logs are written to `.run/` by default (`gateway.log`, `worker_*.log`).

## Docker compose

From `src/deploy/`:

```bash
docker compose up --build
```

This starts:
- `redis`
- `gateway` (FastAPI WebSocket)
- `worker` (inference worker)

## Notes

- Default websocket endpoint: `ws://localhost:8000/asr`
- Silero model files are expected under `src/models/silero_vad_models/`
- Settings are in `src/core/config.py`; copy `src/.env.example` to `.env` to override.
