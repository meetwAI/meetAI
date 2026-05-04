-- Drop existing tables to replace with correct schema
DROP TABLE IF EXISTS meeting_chunks CASCADE;
DROP TABLE IF EXISTS meeting_topics CASCADE;

-- Table 1: Meeting Chunks
-- meeting_id and user_id are BIGINT to match the integer PKs used by
-- the meetings and users tables in the main app schema.
CREATE TABLE meeting_chunks (
    chunk_id   BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT  NOT NULL,
    user_id    BIGINT  NOT NULL,
    text       TEXT    NOT NULL,
    speakers   TEXT[],          -- output of diarization pipeline
    start_time NUMERIC,         -- audio timestamp (seconds, float)
    end_time   NUMERIC,
    embedding  VECTOR(1024)
);

CREATE INDEX IF NOT EXISTS meeting_chunks_meeting_idx ON meeting_chunks (meeting_id);
CREATE INDEX IF NOT EXISTS meeting_chunks_user_idx    ON meeting_chunks (user_id);

-- Table 2: Meeting Topics
CREATE TABLE meeting_topics (
    topic_id   BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT  NOT NULL,
    topic      TEXT    NOT NULL,
    chunk_ids  BIGINT[],           -- references meeting_chunks.chunk_id
    embedding  VECTOR(1024)
);

CREATE INDEX IF NOT EXISTS meeting_topics_meeting_idx ON meeting_topics (meeting_id);
