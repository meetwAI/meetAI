DO $$
DECLARE
  admin_id BIGINT;
BEGIN
  SELECT id INTO admin_id FROM users WHERE user_name = 'admin' LIMIT 1;

  IF admin_id IS NULL THEN
    SELECT id INTO admin_id FROM users WHERE username = 'admin' LIMIT 1;
  END IF;

  IF admin_id IS NULL THEN
    RAISE EXCEPTION 'admin user not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM meetings
    WHERE user_id = admin_id
      AND COALESCE(full_transcript->>'title', '') = 'Design Review — Dashboard'
  ) THEN
    INSERT INTO meetings (user_id, summarisation, full_transcript, date, start_time, duration_minutes, end_time)
    VALUES (
      admin_id,
      'Validated hierarchy, defined data density guardrails.',
      jsonb_build_object(
        'title', 'Design Review — Dashboard',
        'durationMinutes', 45,
        'participants', jsonb_build_array('Ava', 'Liam', 'Nia', 'Mia'),
        'actionItems', jsonb_build_array('Tighten spacing tokens', 'Review chart legends', 'Confirm mobile behavior'),
        'messages', '[]'::jsonb
      ),
      TIMESTAMP '2026-02-22 14:00:00',
      TIMESTAMP '2026-02-22 14:00:00',
      45,
      TIMESTAMP '2026-02-22 14:45:00'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM meetings
    WHERE user_id = admin_id
      AND COALESCE(full_transcript->>'title', '') = 'Customer Feedback Debrief'
  ) THEN
    INSERT INTO meetings (user_id, summarisation, full_transcript, date, start_time, duration_minutes, end_time)
    VALUES (
      admin_id,
      'Top themes: faster search, export options, ownership clarity.',
      jsonb_build_object(
        'title', 'Customer Feedback Debrief',
        'durationMinutes', 38,
        'participants', jsonb_build_array('Zane', 'Nia', 'Ishaan'),
        'actionItems', jsonb_build_array('Prioritize search improvements', 'Define export MVP', 'Assign owners for top requests'),
        'messages', '[]'::jsonb
      ),
      TIMESTAMP '2026-02-25 09:30:00',
      TIMESTAMP '2026-02-25 09:30:00',
      38,
      TIMESTAMP '2026-02-25 10:08:00'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM meetings
    WHERE user_id = admin_id
      AND COALESCE(full_transcript->>'title', '') = 'Sprint Planning'
  ) THEN
    INSERT INTO meetings (user_id, summarisation, full_transcript, date, start_time, duration_minutes, end_time)
    VALUES (
      admin_id,
      'Locked sprint scope and clarified dependencies for infra and frontend.',
      jsonb_build_object(
        'title', 'Sprint Planning',
        'durationMinutes', 60,
        'participants', jsonb_build_array('Ava', 'Nia', 'Liam', 'Ishaan', 'Zane'),
        'actionItems', jsonb_build_array('Finalize backlog order', 'Document dependency risks', 'Confirm QA plan'),
        'messages', '[]'::jsonb
      ),
      TIMESTAMP '2026-02-27 11:00:00',
      TIMESTAMP '2026-02-27 11:00:00',
      60,
      TIMESTAMP '2026-02-27 12:00:00'
    );
  END IF;
END$$;
