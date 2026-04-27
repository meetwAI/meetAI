const { pool, query } = require('../../db/client');
const { hashGoogleId, encryptGoogleRefreshToken } = require('../services/googleSecretsService');

const columnExists = async (columnName) => {
  const result = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name = $1
     LIMIT 1`,
    [columnName],
  );

  return Boolean(result.rowCount);
};

const ensureSecureColumns = async () => {
  await query(
    `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS google_id_hash TEXT,
     ADD COLUMN IF NOT EXISTS google_refresh_iv TEXT,
     ADD COLUMN IF NOT EXISTS google_refresh_ciphertext TEXT,
     ADD COLUMN IF NOT EXISTS google_refresh_tag TEXT,
     ADD COLUMN IF NOT EXISTS google_token_expiry TIMESTAMP`,
  );
};

const backfillGoogleIdHashes = async () => {
  if (!(await columnExists('google_id'))) {
    return 0;
  }

  const rowsResult = await query(
    `SELECT id, google_id, google_id_hash
     FROM users
     WHERE COALESCE(google_id, '') <> ''
       AND COALESCE(google_id_hash, '') = ''`,
  );

  let updatedCount = 0;
  for (const row of rowsResult.rows) {
    const googleIdHash = hashGoogleId(row.google_id);
    if (!googleIdHash) {
      continue;
    }

    await query('UPDATE users SET google_id_hash = $1 WHERE id = $2', [googleIdHash, row.id]);
    updatedCount += 1;
  }

  return updatedCount;
};

const backfillEncryptedRefreshTokens = async () => {
  if (!(await columnExists('google_refresh_token'))) {
    return 0;
  }

  const rowsResult = await query(
    `SELECT id,
            google_refresh_token,
            google_refresh_iv,
            google_refresh_ciphertext,
            google_refresh_tag
     FROM users
     WHERE COALESCE(google_refresh_token, '') <> ''`,
  );

  let updatedCount = 0;
  for (const row of rowsResult.rows) {
    const hasEncryptedToken =
      String(row.google_refresh_iv || '').trim() &&
      String(row.google_refresh_ciphertext || '').trim() &&
      String(row.google_refresh_tag || '').trim();

    if (hasEncryptedToken) {
      continue;
    }

    const encrypted = encryptGoogleRefreshToken(row.google_refresh_token);
    if (!encrypted) {
      continue;
    }

    await query(
      `UPDATE users
       SET google_refresh_iv = $1,
           google_refresh_ciphertext = $2,
           google_refresh_tag = $3
       WHERE id = $4`,
      [encrypted.iv, encrypted.ciphertext, encrypted.tag, row.id],
    );

    updatedCount += 1;
  }

  return updatedCount;
};

const ensureGoogleIdHashIndex = async () => {
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_hash_idx
     ON users (google_id_hash)
     WHERE google_id_hash IS NOT NULL`,
  );
};

const dropLegacyColumns = async () => {
  await query(
    `ALTER TABLE users
     DROP COLUMN IF EXISTS google_access_token,
     DROP COLUMN IF EXISTS google_refresh_token,
     DROP COLUMN IF EXISTS google_id`,
  );
};

const runMigration = async () => {
  try {
    await ensureSecureColumns();

    const googleIdBackfilled = await backfillGoogleIdHashes();
    const refreshTokensBackfilled = await backfillEncryptedRefreshTokens();

    await ensureGoogleIdHashIndex();
    await dropLegacyColumns();

    console.log(
      `[auth-service] Google OAuth security migration complete. google_id_hash backfilled: ${googleIdBackfilled}, encrypted refresh tokens backfilled: ${refreshTokensBackfilled}`,
    );
  } finally {
    await pool.end();
  }
};

runMigration().catch((error) => {
  console.error('[auth-service] Google OAuth security migration failed', {
    message: error?.message,
    code: error?.code,
    detail: error?.detail,
  });
  process.exitCode = 1;
});
