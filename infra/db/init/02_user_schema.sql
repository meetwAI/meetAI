-- =========================
-- ENUM TYPES
-- =========================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_role_enum') THEN
    CREATE TYPE message_role_enum AS ENUM ('user', 'assistant', 'system');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_status_enum') THEN
    CREATE TYPE chat_status_enum AS ENUM ('active', 'archived', 'deleted');
  END IF;
END$$;


-- =========================
-- USERS TABLE
-- =========================

-- If a `users` table exists but is missing columns, alter it; otherwise create it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
    CREATE TABLE users (
        id BIGSERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password TEXT
    );
  ELSE
    -- Ensure columns exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='name') THEN
      ALTER TABLE users ADD COLUMN name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email') THEN
      ALTER TABLE users ADD COLUMN email TEXT UNIQUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN
      ALTER TABLE users ADD COLUMN username TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password') THEN
      ALTER TABLE users ADD COLUMN password TEXT;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='user_name')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN
      UPDATE users
      SET username = user_name
      WHERE username IS NULL AND user_name IS NOT NULL;
      ALTER TABLE users DROP COLUMN IF EXISTS user_name;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='user_name')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN
      ALTER TABLE users RENAME COLUMN user_name TO username;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN
      ALTER TABLE users ALTER COLUMN username SET NOT NULL;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_key') THEN
        ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password') THEN
      ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
    END IF;
  END IF;
END$$;


-- =========================
-- MEETINGS TABLE
-- =========================

CREATE TABLE IF NOT EXISTS meetings (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    summarisation TEXT,
    full_transcript JSONB,
    speaker_map JSONB,
    date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);



-- =========================
-- CHATS TABLE
-- =========================

CREATE TABLE IF NOT EXISTS chats (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    meeting_ids BIGINT[],   -- better than serial[]
    title TEXT,
    date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status chat_status_enum DEFAULT 'active'
);


-- =========================
-- MESSAGES TABLE
-- =========================

CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role message_role_enum NOT NULL,
    content TEXT,
    date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
