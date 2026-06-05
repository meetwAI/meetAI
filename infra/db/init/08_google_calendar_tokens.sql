-- Cleanup: remove secure Google OAuth storage columns from users table as they are now in auth_providers / google_calendar_accounts
ALTER TABLE users
  DROP COLUMN IF EXISTS google_id_hash,
  DROP COLUMN IF EXISTS google_refresh_iv,
  DROP COLUMN IF EXISTS google_refresh_ciphertext,
  DROP COLUMN IF EXISTS google_refresh_tag,
  DROP COLUMN IF EXISTS google_token_expiry;

DROP INDEX IF EXISTS users_google_id_hash_idx;
