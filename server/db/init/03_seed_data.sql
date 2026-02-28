DO $$
DECLARE
  has_user_name BOOLEAN;
  has_username BOOLEAN;
  admin_id BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'user_name'
  ) INTO has_user_name;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'username'
  ) INTO has_username;

  IF has_user_name AND has_username THEN
    INSERT INTO users (name, email, user_name, username, password)
    VALUES
      ('Admin User', 'admin@meetai.local', 'admin', 'admin', 'admin123'),
      ('Demo User', 'demo@meetai.local', 'demo', 'demo', 'demo123')
    ON CONFLICT (user_name) DO UPDATE
    SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      username = EXCLUDED.username,
      password = EXCLUDED.password;
  ELSIF has_user_name THEN
    INSERT INTO users (name, email, user_name, password)
    VALUES
      ('Admin User', 'admin@meetai.local', 'admin', 'admin123'),
      ('Demo User', 'demo@meetai.local', 'demo', 'demo123')
    ON CONFLICT (user_name) DO UPDATE
    SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      password = EXCLUDED.password;
  ELSIF has_username THEN
    INSERT INTO users (name, email, username, password)
    VALUES
      ('Admin User', 'admin@meetai.local', 'admin', 'admin123'),
      ('Demo User', 'demo@meetai.local', 'demo', 'demo123')
    ON CONFLICT (username) DO UPDATE
    SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      password = EXCLUDED.password;
  ELSE
    RAISE EXCEPTION 'users table has neither user_name nor username';
  END IF;

  IF has_user_name THEN
    EXECUTE 'SELECT id FROM users WHERE user_name = $1 LIMIT 1' INTO admin_id USING 'admin';
  ELSE
    EXECUTE 'SELECT id FROM users WHERE username = $1 LIMIT 1' INTO admin_id USING 'admin';
  END IF;

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
