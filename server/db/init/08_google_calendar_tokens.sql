-- Migration: add secure Google OAuth storage columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_id_hash TEXT,
  ADD COLUMN IF NOT EXISTS google_refresh_iv TEXT,
  ADD COLUMN IF NOT EXISTS google_refresh_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS google_refresh_tag TEXT,
  ADD COLUMN IF NOT EXISTS google_token_expiry TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_hash_idx
  ON users (google_id_hash)
  WHERE google_id_hash IS NOT NULL;
