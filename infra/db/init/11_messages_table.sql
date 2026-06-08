-- Migration 11: dedicated messages table
-- Replaces storage of chat messages in full_transcript->>'messages' JSON with a
-- proper relational table.  No legacy support / backfill — new rows only.

CREATE TABLE IF NOT EXISTS messages (
  id        BIGSERIAL PRIMARY KEY,
  chat_id   BIGINT      NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  role      TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content   TEXT        NOT NULL DEFAULT '',
  date      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_chat_id_date_idx ON messages (chat_id, date);
