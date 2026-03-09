# Database and Operations

This document centralizes DB schema notes, runtime commands, and troubleshooting.

## Database Setup

Postgres service is built with pgvector support:

- Dockerfile: `server/db/postgres/Dockerfile`
- Init scripts: `server/db/init`

Default service connection string:

```text
postgresql://meetai:meetai_pass@postgres:5432/meetai_dev
```

## Init Scripts

- `01_create_schema.sql`
  - Enables `vector` extension
  - Creates baseline `users` table with `embedding vector(1536)`

- `02_user_schema.sql`
  - Creates/patches core app schema:
    - `users`
    - `meetings`
    - `meeting_chunks`
    - `chats`
    - `messages`
  - Uses idempotent `DO $$` guards for enum/table/column safety

- `04_meeting_time_columns.sql`
  - Adds meeting time fields:
    - `start_time`
    - `duration_minutes`
    - `end_time`
  - Backfills existing rows
  - Adds index `meetings_end_time_idx`

## How to Run (Windows)

From repository root:

```powershell
docker.exe compose up -d --build
```

Useful checks:

```powershell
docker.exe compose ps
```

## psql Access Examples

List tables:

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public';"
```

Inspect a meeting:

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "SELECT id, full_transcript, start_time, end_time FROM meetings WHERE id = 2;"
```

Read transcript messages array:

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "SELECT full_transcript->'messages' AS messages FROM meetings WHERE id = 2;"
```

## JSONB Message Append via SQL

```sql
UPDATE meetings
SET full_transcript = jsonb_set(
  COALESCE(full_transcript, '{}'::jsonb),
  '{messages}',
  COALESCE(full_transcript->'messages','[]'::jsonb) ||
    '[{"id":"msg-123","role":"user","text":"Hello","time":"2026-02-28T12:34:00.000Z"}]'::jsonb
)
WHERE id = 2;
```

Run from host:

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -c "<PASTE_SQL_HERE>"
```

For complex SQL, prefer file-based execution:

```powershell
docker.exe compose exec -T postgres psql -U meetai -d meetai_dev -f /docker-entrypoint-initdb.d/your_update.sql
```

## Migration/Change Workflow

- Add new SQL files under `server/db/init` for initial bootstrap scenarios.
- Important: entrypoint scripts run automatically only on first DB initialization.
- For existing volumes, apply SQL manually with `psql -f`.
- Prefer idempotent SQL (`IF NOT EXISTS`, guarded `DO $$` blocks).

## Seed Data

- Core seed file: `server/db/init/03_seed_data.sql`
- Additional seed file(s): e.g. `05_seed_more_meetings.sql`

## Troubleshooting

If init scripts did not apply because DB volume already existed:

```powershell
docker.exe compose down
docker volume rm meetai_pgdata
docker.exe compose up -d --build
```

Warning: removing volume deletes DB data.

If command-line quoting is difficult for JSON SQL:

- place SQL in a `.sql` file
- execute with `psql -f`
