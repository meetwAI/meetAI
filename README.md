# meetAI

## Run everything with Docker

From the repository root:

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

If you want a single command that builds, starts and waits for services to be ready (recommended for other users), run the appropriate helper:

PowerShell (Windows):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-all.ps1
```

POSIX (macOS / Linux / WSL):

```bash
./scripts/start-all.sh
```

Services started:
- Frontend (Vite): `http://0.0.0.0:5173`
- Gateway: `http://0.0.0.0:4010`
- Auth service: `http://0.0.0.0:4020`
- Meeting service: `http://0.0.0.0:4001`
- AI realtime gateway: internal `http://ai-gateway:8000`
- Redis: internal `redis:6379` (not published to host by default)

Redis URL defaults are unified in compose:
- All services: `${REDIS_URL:-redis://redis:6379/0}`

AI realtime service source is located at `ai/aiengine/`.

Stop all services:

```bash
docker compose -f infra/docker/docker-compose.yml down
```