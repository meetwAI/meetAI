# meetAI

## Run everything with Docker

From the repository root:

```bash
docker compose up --build
```

If you want a single command that builds, starts and waits for services to be ready (recommended for other users), run the appropriate helper:

PowerShell (Windows):

```powershell
powershell -ExecutionPolicy Bypass -File .\start-all.ps1
```

POSIX (macOS / Linux / WSL):

```bash
./start-all.sh
```

Services started:
- Frontend (Vite): `http://localhost:5173`
- Gateway: `http://localhost:4010`
- Auth service: `http://localhost:4020`
- Meeting service: `http://localhost:4001`
- AI realtime gateway: internal `http://ai-gateway:8000`
- Redis: internal `redis:6379` (not published to host by default)

Redis URL defaults are unified in compose:
- All services: `${REDIS_URL:-redis://redis:6379/0}`

AI realtime service source is located at `CHECKPOINT2/src`.

Stop all services:

```bash
docker compose down
```