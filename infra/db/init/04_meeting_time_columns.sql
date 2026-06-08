ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS start_time TIMESTAMP,
  ADD COLUMN IF NOT EXISTS duration_minutes INT,
  ADD COLUMN IF NOT EXISTS end_time TIMESTAMP,
  ADD COLUMN IF NOT EXISTS speaker_map JSONB;

UPDATE meetings
SET title = COALESCE(title, full_transcript->>'title', CONCAT('Meeting ', id::text))
WHERE title IS NULL OR title = '';

UPDATE meetings
SET
  start_time = COALESCE(start_time, date),
  duration_minutes = COALESCE(
    duration_minutes,
    NULLIF((full_transcript->>'durationMinutes')::INT, NULL),
    0
  )
WHERE start_time IS NULL OR duration_minutes IS NULL;

UPDATE meetings
SET end_time = COALESCE(
  end_time,
  start_time + (COALESCE(duration_minutes, 0) * INTERVAL '1 minute')
)
WHERE end_time IS NULL;

CREATE INDEX IF NOT EXISTS meetings_end_time_idx ON meetings (end_time DESC);
