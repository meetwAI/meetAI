-- Switch chunk/topic embedding dim from 1024 (BAAI/bge-m3) to 384
-- (BAAI/bge-small-en-v1.5). Rows embedded with the previous model cannot
-- be reused across vector spaces, so we drop and recreate. For fresh
-- databases 09_*.sql already creates the tables at 384 — this migration
-- exists to bring DBs that were initialised at 1024 onto the new dim.
DROP TABLE IF EXISTS meeting_chunks CASCADE;
DROP TABLE IF EXISTS meeting_topics CASCADE;

CREATE TABLE meeting_chunks (
    chunk_id   BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT  NOT NULL,
    user_id    BIGINT  NOT NULL,
    text       TEXT    NOT NULL,
    speakers   TEXT[],
    start_time NUMERIC,
    end_time   NUMERIC,
    embedding  VECTOR(384)
);

CREATE INDEX IF NOT EXISTS meeting_chunks_meeting_idx ON meeting_chunks (meeting_id);
CREATE INDEX IF NOT EXISTS meeting_chunks_user_idx    ON meeting_chunks (user_id);

CREATE TABLE meeting_topics (
    topic_id   BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT  NOT NULL,
    topic      TEXT    NOT NULL,
    chunk_ids  BIGINT[],
    embedding  VECTOR(384)
);

CREATE INDEX IF NOT EXISTS meeting_topics_meeting_idx ON meeting_topics (meeting_id);
