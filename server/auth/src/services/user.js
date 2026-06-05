const { query, pool } = require('@meetai/shared/db');
const { encryptGoogleRefreshToken } = require('./google/secrets');

const getUserByUsername = async (username) => {
  const result = await query(
    `SELECT u.id, u.name, u.username, u.email, u.avatar_url,
            ap.password_hash as password,
            (SELECT provider_user_id FROM auth_providers WHERE user_id = u.id AND provider = 'google' LIMIT 1) as google_id_hash
     FROM users u
     LEFT JOIN auth_providers ap ON u.id = ap.user_id AND ap.provider = 'password'
     WHERE u.username = $1
     LIMIT 1`,
    [username],
  );
  return result.rows[0] || null;
};

const getUserByEmail = async (email) => {
  const result = await query(
    `SELECT u.id, u.name, u.username, u.email, u.avatar_url,
            ap.password_hash as password,
            (SELECT provider_user_id FROM auth_providers WHERE user_id = u.id AND provider = 'google' LIMIT 1) as google_id_hash
     FROM users u
     LEFT JOIN auth_providers ap ON u.id = ap.user_id AND ap.provider = 'password'
     WHERE u.email = $1
     LIMIT 1`,
    [email],
  );
  return result.rows[0] || null;
};

const getUserById = async (userId) => {
  const result = await query(
    `SELECT u.id, u.name, u.username, u.email, u.avatar_url,
            (SELECT provider_user_id FROM auth_providers WHERE user_id = u.id AND provider = 'google' LIMIT 1) as google_id_hash
     FROM users u
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
};

const getUserByGoogleIdHash = async (googleIdHash) => {
  const result = await query(
    `SELECT u.id, u.name, u.username, u.email, u.avatar_url,
            ap_pass.password_hash as password,
            ap_goog.provider_user_id as google_id_hash
     FROM auth_providers ap_goog
     JOIN users u ON ap_goog.user_id = u.id
     LEFT JOIN auth_providers ap_pass ON u.id = ap_pass.user_id AND ap_pass.provider = 'password'
     WHERE ap_goog.provider = 'google' AND ap_goog.provider_user_id = $1
     LIMIT 1`,
    [googleIdHash],
  );
  return result.rows[0] || null;
};

const createUser = async ({ name, email, username, passwordHash, googleIdHash, avatarUrl }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO users (name, email, username, avatar_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, username, avatar_url`,
      [name, email, username, avatarUrl || null],
    );
    const user = result.rows[0];

    if (passwordHash) {
      await client.query(
        `INSERT INTO auth_providers (user_id, provider, provider_user_id, password_hash)
         VALUES ($1, 'password', $2, $3)`,
        [user.id, user.id.toString(), passwordHash],
      );
    }
    
    if (googleIdHash) {
      await client.query(
        `INSERT INTO auth_providers (user_id, provider, provider_user_id)
         VALUES ($1, 'google', $2)`,
        [user.id, googleIdHash],
      );
    }

    await client.query('COMMIT');
    return { ...user, google_id_hash: googleIdHash || null } || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const updateUserPassword = async (userId, passwordHash) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const providerResult = await client.query(
      `SELECT id FROM auth_providers WHERE user_id = $1 AND provider = 'password'`,
      [userId]
    );
    if (providerResult.rowCount > 0) {
      await client.query(
        `UPDATE auth_providers SET password_hash = $1 WHERE user_id = $2 AND provider = 'password'`,
        [passwordHash, userId]
      );
    } else {
      await client.query(
        `INSERT INTO auth_providers (user_id, provider, provider_user_id, password_hash)
         VALUES ($1, 'password', $2, $3)`,
        [userId, userId.toString(), passwordHash]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const updateGoogleIdentityFields = async ({ userId, googleIdHash, avatarUrl }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    if (avatarUrl) {
      await client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatarUrl, userId]);
    }

    if (googleIdHash) {
      const providerResult = await client.query(
        `SELECT id FROM auth_providers WHERE user_id = $1 AND provider = 'google'`,
        [userId]
      );
      if (providerResult.rowCount === 0) {
        await client.query(
          `INSERT INTO auth_providers (user_id, provider, provider_user_id)
           VALUES ($1, 'google', $2)`,
          [userId, googleIdHash]
        );
      } else {
        await client.query(
          `UPDATE auth_providers SET provider_user_id = $1 WHERE user_id = $2 AND provider = 'google'`,
          [googleIdHash, userId]
        );
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const updateUserProfile = async ({ userId, name, age, phone, location }) => {
  const result = await query(
    `UPDATE users
     SET name     = COALESCE(NULLIF($1, ''), name),
         age      = COALESCE($2,            age),
         phone    = COALESCE($3,            phone),
         location = COALESCE($4,            location)
     WHERE id = $5
     RETURNING id, name, username, age, phone, location`,
    [name || null, age, phone, location, userId],
  );

  return result.rows[0] || null;
};

const getGoogleCalendarTokensByUserId = async (userId) => {
  const result = await query(
    `SELECT u.id, 
            COALESCE(gca.google_sub, (SELECT provider_user_id FROM auth_providers WHERE user_id = u.id AND provider = 'google' LIMIT 1)) as google_id_hash,
            gca.refresh_token_iv as google_refresh_iv,
            gca.refresh_token_ciphertext as google_refresh_ciphertext,
            gca.refresh_token_tag as google_refresh_tag
     FROM users u
     LEFT JOIN google_calendar_accounts gca ON u.id = gca.user_id AND gca.is_primary = true
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  
  if (!result.rows[0]) {
    return null;
  }

  if (result.rows[0].google_refresh_iv) {
    return result.rows[0];
  }

  const fallbackResult = await query(
    `SELECT u.id, 
            COALESCE(gca.google_sub, (SELECT provider_user_id FROM auth_providers WHERE user_id = u.id AND provider = 'google' LIMIT 1)) as google_id_hash,
            gca.refresh_token_iv as google_refresh_iv,
            gca.refresh_token_ciphertext as google_refresh_ciphertext,
            gca.refresh_token_tag as google_refresh_tag
     FROM users u
     LEFT JOIN google_calendar_accounts gca ON u.id = gca.user_id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  return fallbackResult.rows[0] || result.rows[0];
};

const persistGoogleTokensForUser = async ({ userId, refreshToken, accessTokenExpiry }) => {
  if (!userId) {
    return;
  }

  const encryptedRefreshToken = encryptGoogleRefreshToken(refreshToken);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const existing = await client.query(
      `SELECT id FROM google_calendar_accounts WHERE user_id = $1`,
      [userId]
    );

    if (existing.rowCount > 0) {
      await client.query(
        `UPDATE google_calendar_accounts
         SET refresh_token_iv = COALESCE($1, refresh_token_iv),
             refresh_token_ciphertext = COALESCE($2, refresh_token_ciphertext),
             refresh_token_tag = COALESCE($3, refresh_token_tag),
             access_token_expiry = COALESCE($4, access_token_expiry),
             updated_at = NOW()
         WHERE user_id = $5`,
        [
          encryptedRefreshToken?.iv || null,
          encryptedRefreshToken?.ciphertext || null,
          encryptedRefreshToken?.tag || null,
          accessTokenExpiry || null,
          userId,
        ],
      );
    } else {
      if (!encryptedRefreshToken) {
        await client.query('COMMIT');
        return;
      }
      const userRes = await client.query(
        `SELECT email, (SELECT provider_user_id FROM auth_providers WHERE user_id = users.id AND provider = 'google' LIMIT 1) as google_id_hash FROM users WHERE id = $1`,
        [userId]
      );
      const user = userRes.rows[0];
      if (user) {
        await client.query(
          `INSERT INTO google_calendar_accounts (user_id, google_sub, email, refresh_token_iv, refresh_token_ciphertext, refresh_token_tag, access_token_expiry, is_primary)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
          [
            userId,
            user.google_id_hash || userId.toString(),
            user.email,
            encryptedRefreshToken?.iv || null,
            encryptedRefreshToken?.ciphertext || null,
            encryptedRefreshToken?.tag || null,
            accessTokenExpiry || null
          ]
        );
      }
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const clearGoogleTokensForUser = async (userId) => {
  await query(
    `UPDATE google_calendar_accounts
     SET refresh_token_iv = NULL,
         refresh_token_ciphertext = NULL,
         refresh_token_tag = NULL,
         access_token_expiry = NULL,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId],
  );
};

module.exports = {
  getUserByUsername,
  getUserByEmail,
  getUserById,
  getUserByGoogleIdHash,
  createUser,
  updateUserPassword,
  updateGoogleIdentityFields,
  updateUserProfile,
  getGoogleCalendarTokensByUserId,
  persistGoogleTokensForUser,
  clearGoogleTokensForUser,
};
