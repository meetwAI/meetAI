# Session Memory

## What this project is
- Standalone realtime transcription service under `src/` (outside `WHISPERLIVEKIT`).
- WebSocket gateway (`FastAPI`) + Redis streams + worker process.
- Frontend captures tab/mic audio with `AudioWorklet` and sends PCM (`s16le`, `16kHz`, mono).

## Current folder layout
- `src/app/`: runtime entrypoints (`server.py`, `worker.py`)
- `src/core/`: settings and timed data objects
- `src/engines/`: `asr_backend`, `online_asr`, `vad`, `diarization`
- `src/pipeline/`: per-session pipeline + token alignment
- `src/infra/`: Redis broker
- `src/web/static/`: UI (`index.html`, `app.js`, `style.css`, workers)
- `src/models/silero_vad_models/`: bundled Silero files
- `src/deploy/`: `Dockerfile`, `docker-compose.yml`

## Important module paths
- Gateway: `python -m src.app.server`
- Worker: `python -m src.app.worker`
- Server app import path: `src.app.server:app`

## Runtime notes
- Gateway mounts static files from `src/web/static`.
- VAD model lookup points to `src/models/silero_vad_models`.
- Redis stream routing uses stable session affinity:
  - audio stream: `audio:worker:{worker_id}`
  - result stream: `results:{session_id}`

## Verified in this session
- Python syntax check passed:
  - `python3 -m compileall /home/great/dev/meetAI/src`
- Dependency install now reuses existing Torch when compatible:
  - `install_deps.sh` detects `torch.__version__` and `torch.version.cuda`
  - skips torch from requirements when environment already has `torch==2.7.1` + CUDA `12.6`
  - default venv creation now uses `--system-site-packages` to leverage already-installed libs
- Verified on this machine:
  - system Python torch: `2.7.1+cu126` (CUDA `12.6`)
  - `.venv` torch: `2.7.1+cu126` (CUDA `12.6`)
  - `./install_deps.sh` output confirms: `Using existing torch 2.7.1 (CUDA 12.6); skipping torch download.`

## Progress made this session
- Updated `install_deps.sh` argument parsing and added `--isolated-venv` option.
- Updated `src/README.md` quick-start dependency instructions to use `./install_deps.sh` from project root.
- Documented default dependency behavior in README (reuse existing torch install instead of re-downloading).
- Updated `start_server.sh` to orchestrate all local services with readiness checks:
  - starts Redis (optional via `--no-redis`) and verifies connectivity
  - starts `NUM_WORKERS` worker processes with deterministic `WORKER_ID` assignment
  - starts gateway and waits for `/health` endpoint
  - writes logs to `.run/gateway.log` and `.run/worker_*.log`
  - validates dependencies before startup and can auto-run `install_deps.sh`
- Added `requests==2.32.3` to `src/requirements.txt` because `faster-whisper` imports `requests` at runtime.
- Docker runtime availability re-verified in this environment:
  - `docker --version` works
  - `docker ps` works
- End-to-end startup check passed with `./start_server.sh --workers 1`:
  - script reports `Ready: Redis=redis://localhost:6379/0 Workers=1 Gateway=http://127.0.0.1:8000`
  - `/health` returns `{"ok":true,"active_sessions":0}`
  - Redis container `meetai-redis` is running
  - worker and gateway processes are both up
  - gateway log shows clean startup and shutdown sequence

## Quick start reminder
1. Start Redis: `docker run --rm -p 6379:6379 redis:7-alpine`
2. Start worker: `python -m src.app.worker`
3. Start gateway: `python -m src.app.server`
4. Open: `http://localhost:8000`

## New startup command
- `./start_server.sh --workers 1`
- `./start_server.sh --workers 2`
- `./start_server.sh --workers 1 --no-redis` (use external Redis at `REDIS_URL`)

## Next good steps
- Add lightweight tests (broker routing + websocket relay flow).
- Add retry/timeout hardening around stop/finalization flow.
- Optionally add `Makefile` shortcuts for local dev commands.

## Latest changes (realtime stability pass)
- Implemented session-stop protection in worker and pipeline:
  - `src/app/worker.py` now tracks `closed_sessions` and ignores stale `audio` events after `close`.
  - `register` now clears prior closed marker for the session id before re-creating a pipeline.
  - `src/pipeline/audio_pipeline.py` now has `stopped` flag; `process_audio()` short-circuits once finished.
- Implemented ASR batching threshold to reduce tiny-chunk inference spam:
  - Added `MIN_TRANSCRIPTION_BUFFER_SEC = 0.5` in `src/pipeline/audio_pipeline.py`.
  - Pipeline accumulates incoming chunk duration and only runs `process_iter()` once threshold is reached.
  - `finish()` flushes any remaining buffered audio before final token finalize.
  - VAD silence-start now flushes transcription state and resets pending ASR buffer duration.
- Refactored repeated state-update logic into `_apply_transcription_output()` to keep buffer/line state consistent.
- Validation done: `python3 -m compileall src/pipeline/audio_pipeline.py src/app/worker.py`.

## Latest changes (frontend flicker fix)
- Updated transcript rendering in `src/web/static/app.js` to avoid full container re-renders every update tick.
- `renderTranscript()` now updates transcript rows incrementally and only mutates a row if its HTML changed.
- Added stable empty-state handling so the placeholder is not repeatedly re-inserted.
- Replaced smooth auto-scroll with stick-to-bottom logic using direct `scrollTop` to remove periodic scroll animation jitter.
- Removed expensive visual effects on the transcript panel in `src/web/static/style.css` that can repaint the whole box each update:
  - removed `backdrop-filter` on shared panel style,
  - removed per-line `reveal` animation,
  - set transcript panel/rows to more opaque backgrounds,
  - added `contain: content` on `.transcript` to isolate repaints.

## Latest changes (dependency + startup tracing)
- Updated NeMo dependency format in `src/requirements.txt` to modern direct URL syntax:
  - `nemo_toolkit[asr] @ git+https://github.com/NVIDIA/NeMo.git@main`
  - Reason: pip rejected old `#egg=nemo_toolkit[asr]` format with `invalid-egg-fragment`.
- Re-ran dependency installation successfully with `./install_deps.sh`.
  - Torch reuse behavior still works (`2.7.1+cu126` reused, no torch re-download).
  - NeMo stack resolved and installed in `.venv`.
- Startup trace for `./start_server.sh --workers 1` with `DIARIZATION_ENABLED=true`:
  - Worker readiness failed in script because diarization cold-start exceeded readiness timeout window.
  - Worker log includes `ERROR:numba.cuda.cudadrv.driver: Call to cuInit results in CUDA_ERROR_NO_DEVICE` (probe noise), but direct worker run still proceeded to load Sortformer and emit `Worker started`.
  - Root issue identified as startup/readiness timing under diarization cold start, not confirmed fatal diarization crash.
- Added diarization init safeguard in `src/app/worker.py`:
  - Sortformer initialization is now wrapped in `try/except`.
  - On failure, worker logs exception and continues without diarization instead of crashing startup.
