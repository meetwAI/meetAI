**Project Documentation**

This document summarizes the repository, how to run it, and how to read and update the PostgreSQL database used by the services (including the pgvector-enabled DB).

**Project Overview**:
- **Purpose**: meetAI demo app — services: auth, gateway, meeting-service, and a React frontend.
- **Location**: top-level compose and services live in `server`, `CHECKPOINT2/src`, and `client/meetai-web`. See [docker-compose.yml](docker-compose.yml).

**Services**:
- **Postgres**: database built with pgvector (local Docker build at `server/db/postgres/Dockerfile`). Init SQL scripts are in [server/db/init](server/db/init).
- **Auth service**: `server/auth-service` — login and token logic.
- **Meeting service**: `server/meeting-service` — meeting read/write endpoints.
- **Gateway**: `server/gateway` — proxies API requests to services.
- **AI realtime service**: `CHECKPOINT2/src` — websocket ASR gateway + worker (Redis streams).
- **Frontend**: `client/meetai-web` — React + Vite app.

**Redis defaults**:
- All services use `${REDIS_URL:-redis://redis:6379/0}`.

**How to run (local, Windows)**:
1. From the repo root, build and start all services:

```powershell
docker.exe compose up -d --build
```

2. Check service logs or container status with `docker compose ps` or `docker logs` as needed.

3. If you change the frontend or backend code, rebuild the specific service image or re-run the compose command above.

**Database: connection and env**
- The services use `DATABASE_URL` set in `docker-compose.yml`. The default value used in this project is:

```
postgresql://meetai:meetai_pass@postgres:5432/meetai_dev
```

- The DB init SQL files are mounted to Postgres' `/docker-entrypoint-initdb.d/` path. See [server/db/init](server/db/init) for scripts named `01_*.sql`, `02_*.sql`, etc.

**Reading the DB (psql examples)**
- Run a psql command inside the Postgres container (Windows example):

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public';"
```

- Read a single meeting record (example):

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "SELECT id, full_transcript, start_time, end_time FROM meetings WHERE id = 2;"
```

- Show JSON messages array for a meeting:

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "SELECT full_transcript->'messages' AS messages FROM meetings WHERE id = 2;"
```

**Updating the DB (psql / SQL examples)**
- Append a message to a meeting's `full_transcript.messages` JSONB array (use careful quoting):

```sql
-- Example JSON for one message (replace id/time/text)
UPDATE meetings
SET full_transcript = jsonb_set(
  COALESCE(full_transcript, '{}'::jsonb),
  '{messages}',
  COALESCE(full_transcript->'messages','[]'::jsonb) ||
    '[{"id":"msg-123","role":"user","text":"Hello","time":"2026-02-28T12:34:00.000Z"}]'::jsonb
)
WHERE id = 2;
```

- Run the above from the host (PowerShell example):

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "<PASTE_SQL_HERE>"
```

Notes: use single/double quoting carefully when running JSON via CLI. For complex updates prefer creating a small SQL file and using `-f`:

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -f /docker-entrypoint-initdb.d/your_update.sql
```

**DB migration / adding schema changes**
- Add new migration files to [server/db/init](server/db/init). The Postgres official image executes these during initial database creation only. For iterative development (container already initialized), run the SQL inside the container with `psql -f` as shown above or use a migrations tool.
- For idempotent scripts, use existence checks or `DO $$` blocks when creating types or enums. See `02_user_schema.sql` in the init folder for examples.

**API endpoints (examples)**
- Use the gateway service (check `docker-compose.yml` for port mappings) to call APIs.

- Get recent meetings (most-recent first):

```bash
curl "http://localhost:8080/meetings/recent?limit=3"
```

- Get a meeting by id:

```bash
curl "http://localhost:8080/meetings/2"
```

- Append a message to a meeting (POST) — body: `role` and `text` (gateway proxies to meeting-service):

```bash
curl -X POST -H "Content-Type: application/json" -d '{"role":"user","text":"Hi there"}' \
  http://localhost:8080/meetings/2/messages
```

Response: the API returns the created message object with `id`, `role`, `text`, and `time` (ISO string).

- Create a meeting immediately when user starts capture (POST):

```bash
curl -X POST -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:4010/meetings
```

Response:

```json
{
  "id": 123,
  "startTime": "2026-02-28T18:30:00.000Z"
}
```

- Complete a meeting on stop (sets `end_time` and `duration_minutes`):

```bash
curl -X POST -H "Authorization: Bearer <ACCESS_TOKEN>" \
  http://localhost:4010/meetings/123/complete
```

Response:

```json
{
  "id": 123,
  "startTime": "2026-02-28T18:30:00.000Z",
  "endTime": "2026-02-28T18:52:00.000Z",
  "durationMinutes": 22
}
```

- Delete a meeting (owner-only):

```bash
curl -X DELETE -H "Authorization: Bearer <ACCESS_TOKEN>" \
  http://localhost:4010/meetings/123
```

Response:

```json
{
  "deleted": true,
  "id": 123
}
```

- Rename a meeting title (owner-only):

```bash
curl -X PATCH -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{"title":"Weekly Sync"}' \
  http://localhost:4010/meetings/123/title
```

Response:

```json
{
  "id": 123,
  "title": "Weekly Sync"
}
```

**Recent implementation notes (2026-02-28)**
- Frontend start flow (`MainLayout.jsx`):
  - On `Meet With AI`, create meeting first via `POST /meetings`.
  - Navigate immediately to `/meetings/:meetingId`.
  - During streaming, append assistant outputs to `POST /meetings/:meetingId/messages`.
  - On stop, call `POST /meetings/:meetingId/complete` to persist `end_time` and `duration_minutes`.
- Frontend meetings page (`PreviousMeetings.jsx`):
  - Added `Delete meeting` button using `DELETE /meetings/:meetingId`.
  - Uses React Query cache updates to remove deleted meeting and avoid full reload.
  - Route switching between `/meetings/:id` keeps sidebar mounted and invalidates only `['meeting', meetingId]` instead of hard-loading the full list.
- Gateway and meeting-service:
  - Added proxy + handlers for `POST /meetings`, `POST /meetings/:meetingId/complete`, and `DELETE /meetings/:meetingId`.
  - Enabled `DELETE` in CORS methods.
- Auth payload fix:
  - `buildUser` now maps `id` from `user.id ?? user.sub` so downstream services receive user id correctly.

**Where to edit code**
- Backend DB client: [server/db/client.js](server/db/client.js)
- Auth: [server/auth-service/routes/auth.js](server/auth-service/routes/auth.js)
- Meeting endpoints: [server/meeting-service/index.js](server/meeting-service/index.js)
- Gateway proxies: [server/gateway/app.js](server/gateway/app.js)
- Postgres Dockerfile with pgvector build: [server/db/postgres/Dockerfile](server/db/postgres/Dockerfile)
- Frontend components: [client/meetai-web/src/components](client/meetai-web/src/components) (Dashboard.jsx, PreviousMeetings.jsx, etc.)

**Frontend date formatting**
- The project uses `moment` in `client/meetai-web`. Meeting card dates use `moment(meeting.start_time).format('DD-MMM-YYYY')`. Message timestamps are stored as ISO strings; to include hours/minutes use `moment(message.time).format('DD-MMM-YYYY HH:mm')`.

**Seeding data**
- Initial seeds live in [server/db/init/03_seed_data.sql](server/db/init/03_seed_data.sql) and later seed files. Re-run these with `psql -f` if you need to re-seed a running DB.

**Troubleshooting**
- If Postgres init SQL didn't run (image previously initialized), remove the `pgdata` volume and re-create containers (warning: this will remove DB data):

```powershell
docker.exe compose down
docker volume rm meetai_pgdata
docker.exe compose up -d --build
```

- If `psql` commands fail due to quoting, place the SQL in a file and use `-f`.

**Quick checklist**
- Start: `docker.exe compose up -d --build`
- Inspect DB tables: `docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "SELECT ..."`
- Append message via API: POST to `/meetings/:id/messages` through the gateway.
- Append message via SQL: `UPDATE ... jsonb_set(...)` as shown above.

---

If you want, I can also:
- add this file under a `docs/` folder instead, or
- commit the file and create a short CHANGELOG entry.

File created: `PROJECT_DOCUMENTATION.md`
