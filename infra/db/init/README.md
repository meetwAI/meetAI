# Database init scripts

These `*.sql` files are mounted into the Postgres container at
`/docker-entrypoint-initdb.d/` and run **once, in filename order, only when the
data volume is empty** (i.e. a fresh `pgdata`). They do not re-run on an
existing volume.

The custom Postgres image (`infra/db/postgres/Dockerfile`) builds the
[`pgvector`](https://github.com/pgvector/pgvector) extension from source so the
`vector` type and `ivfflat` indexes used below are available.

## Run order

| File | Purpose |
|---|---|
| `01_create_schema.sql` | `CREATE EXTENSION vector`; core `users` table + ivfflat index |
| `02_user_schema.sql` | user columns |
| `02a_auth_schema.sql` | `auth_providers` (password / OAuth credentials) |
| `03_seed_data.sql` | demo `admin` user + one demo meeting (**no password** — see below) |
| `04_meeting_time_columns.sql` | meeting time columns |
| `05_seed_more_meetings.sql` | three more demo meetings under `admin` |
| `06_user_profile_fields.sql` | profile fields |
| `07_migrate_user_name_to_username.sql` | `name` → `username` |
| `08_google_calendar_tokens.sql` | Google Calendar token storage |
| `09_meeting_chunks_and_topics.sql` | `meeting_chunks` + `meeting_topics` (384-d) + ivfflat ANN indexes |
| `10_resize_embedding_to_384.sql` | drop/recreate chunk+topic tables at 384-d (for DBs first built at 1024-d); recreates ANN indexes |

Filenames are intentionally **not renumbered** (the `02a_` outlier stays) so
existing dev volumes keep matching the scripts they already applied.

## No default admin password

`03_seed_data.sql` creates an `admin` demo user but **does not** seed a
password credential. The previous hardcoded `admin123` scrypt hash was removed —
it was a public, well-known credential and a real risk on any internet-facing
deployment. The demo meetings still seed (they only need the user row).

To enable password login for a bootstrap admin, insert a real hash into
`auth_providers` yourself (a `scripts/seed-admin` helper is a planned follow-up).

## pgvector ANN indexes on an existing DB

The `ivfflat` indexes on `meeting_chunks.embedding` and
`meeting_topics.embedding` were added to `09`/`10`. Because init scripts only
run on a fresh volume, a **pre-existing** dev database will not have them. To
add them by hand:

```sql
CREATE INDEX IF NOT EXISTS meeting_chunks_embedding_ivfflat
    ON meeting_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS meeting_topics_embedding_ivfflat
    ON meeting_topics USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ivfflat needs row statistics to be useful; run after a meaningful backfill:
ANALYZE meeting_chunks;
ANALYZE meeting_topics;
```
