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

  INSERT INTO users (name, email, username)
  VALUES ('Admin User', 'admin@meet.ai', 'admin')
  ON CONFLICT (username) DO UPDATE
  SET name  = EXCLUDED.name,
      email = EXCLUDED.email;

  SELECT id INTO admin_id FROM users WHERE username = 'admin' LIMIT 1;

  -- NOTE: The 'admin' demo user is created WITHOUT a password credential.
  -- The previous hardcoded scrypt hash for 'admin123' was removed (it was a
  -- public, well-known credential — a security risk on any internet-facing
  -- deploy). To enable password login for a bootstrap admin, run a dedicated
  -- seed script that prompts for / generates a real password and inserts the
  -- hash into auth_providers (see scripts/, TODO: seed-admin). This keeps the
  -- demo meeting data below available while shipping no usable default login.

  IF admin_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM meetings m
    WHERE m.user_id = admin_id
      AND m.summarisation = 'Aligned on onboarding scope and confirmed launch risks.'
  ) THEN
    INSERT INTO meetings (user_id, title, summarisation, full_transcript, date)
    VALUES (
      admin_id,
      'Weekly Product Sync',
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
