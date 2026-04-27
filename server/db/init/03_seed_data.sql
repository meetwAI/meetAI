DO $$
DECLARE
  has_username BOOLEAN;
  admin_id BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'username'
  ) INTO has_username;

  IF NOT has_username THEN
    RAISE EXCEPTION 'users table missing username column';
  END IF;

  INSERT INTO users (name, email, username, password)
  VALUES
    ('Admin User', 'admin@meetai.local', 'admin', 'scrypt$16384$8$1$I2YIvX09PRmLayMTWYyNjQ$-yGfxtKDkmfaqePKWxNtmLhrQl_5wQYD0J3QWEVj1mOlaoSTKW5Y36Mdsgg9aR2xqKm4biEfS4RvUlNKbLDAwg'),
    ('Demo User', 'demo@meetai.local', 'demo', 'scrypt$16384$8$1$fKrD0f0a0Jz1zEjK7keM3Q$TMiu5dRJpAwgRwHZaZ9I14R0PxKz_WDd_HOqoGFqQ_TYKfRrSUi0mzu8OY8qOp-d2QcP69q3nzAy3_JZSF9E6w')
  ON CONFLICT (username) DO UPDATE
  SET
    name = EXCLUDED.name,
    email = EXCLUDED.email,
    password = EXCLUDED.password;

  SELECT id INTO admin_id FROM users WHERE username = 'admin' LIMIT 1;

  IF admin_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meetings m
    WHERE m.user_id = admin_id
      AND m.summarisation = 'Aligned on onboarding scope and confirmed launch risks.'
  ) THEN
    INSERT INTO meetings (user_id, summarisation, full_transcript, date)
    VALUES (
      admin_id,
      'Aligned on onboarding scope and confirmed launch risks.',
      jsonb_build_object(
        'title', 'Weekly Product Sync',
        'durationMinutes', 52,
        'participants', jsonb_build_array('Ava', 'Nia', 'Zane', 'Ishaan'),
        'actionItems', jsonb_build_array(
          'Finalize onboarding checklist',
          'Confirm analytics event list',
          'Review launch risk mitigations'
        ),
        'messages', '[]'::jsonb
      ),
      TIMESTAMP '2026-01-31 10:00:00'
    );
  END IF;
END$$;
