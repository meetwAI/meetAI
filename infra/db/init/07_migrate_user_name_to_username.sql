-- Migration: unify users table on username and remove legacy user_name column
DO $$
BEGIN
  -- If only legacy column exists, rename it to username.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'user_name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'username'
  ) THEN
    ALTER TABLE users RENAME COLUMN user_name TO username;
  END IF;

  -- If both columns exist, backfill username then drop user_name.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'user_name'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'username'
  ) THEN
    UPDATE users
    SET username = user_name
    WHERE (username IS NULL OR username = '')
      AND user_name IS NOT NULL;

    ALTER TABLE users DROP COLUMN IF EXISTS user_name;
  END IF;

  -- Enforce username contract.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'username'
  ) THEN
    ALTER TABLE users ALTER COLUMN username SET NOT NULL;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_key') THEN
      ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
    END IF;
  END IF;
END$$;
