const { query } = require('../../db/client');
const { encryptGoogleRefreshToken } = require('./googleSecretsService');

const getUserByUsername = async (username) => {
  const result = await query(
    `SELECT id, name, username, password, email, google_id_hash, avatar_url
     FROM users
     WHERE username = $1
     LIMIT 1`,
    [username],
  );
  return result.rows[0] || null;
};

const getUserByEmail = async (email) => {
  const result = await query(
    `SELECT id, name, username, password, email, google_id_hash, avatar_url
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email],
  );
  return result.rows[0] || null;
};

const getUserByGoogleIdHash = async (googleIdHash) => {
  const result = await query(
    `SELECT id, name, username, password, email, google_id_hash, avatar_url
     FROM users
     WHERE google_id_hash = $1
     LIMIT 1`,
    [googleIdHash],
  );
  return result.rows[0] || null;
};

const createUser = async ({ name, email, username, passwordHash, googleIdHash, avatarUrl }) => {
  const result = await query(
    `INSERT INTO users (name, email, username, password, google_id_hash, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, username, google_id_hash, avatar_url`,
    [name, email, username, passwordHash, googleIdHash || null, avatarUrl || null],
  );
  return result.rows[0] || null;
};

const updateUserPassword = async (userId, passwordHash) => {
  await query('UPDATE users SET password = $1 WHERE id = $2', [passwordHash, userId]);
};

const updateGoogleIdentityFields = async ({ userId, googleIdHash, avatarUrl }) => {
  const updates = [];
  const values = [];

  if (googleIdHash) {
    updates.push(`google_id_hash = $${values.length + 1}`);
    values.push(googleIdHash);
  }

  if (avatarUrl) {
    updates.push(`avatar_url = $${values.length + 1}`);
    values.push(avatarUrl);
  }

  if (!updates.length) {
    return false;
  }

  values.push(userId);
  await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
  return true;
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
    `SELECT id, google_refresh_iv, google_refresh_ciphertext, google_refresh_tag
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
};

const persistGoogleTokensForUser = async ({ userId, refreshToken, accessTokenExpiry }) => {
  if (!userId) {
    return;
  }

  const encryptedRefreshToken = encryptGoogleRefreshToken(refreshToken);

  await query(
    `UPDATE users
     SET google_refresh_iv = COALESCE($1, google_refresh_iv),
         google_refresh_ciphertext = COALESCE($2, google_refresh_ciphertext),
         google_refresh_tag = COALESCE($3, google_refresh_tag),
         google_token_expiry = COALESCE($4, google_token_expiry)
     WHERE id = $5`,
    [
      encryptedRefreshToken?.iv || null,
      encryptedRefreshToken?.ciphertext || null,
      encryptedRefreshToken?.tag || null,
      accessTokenExpiry || null,
      userId,
    ],
  );
};

const clearGoogleTokensForUser = async (userId) => {
  await query(
    `UPDATE users
     SET google_refresh_iv = NULL,
         google_refresh_ciphertext = NULL,
         google_refresh_tag = NULL,
         google_token_expiry = NULL
     WHERE id = $1`,
    [userId],
  );
};

module.exports = {
  getUserByUsername,
  getUserByEmail,
  getUserByGoogleIdHash,
  createUser,
  updateUserPassword,
  updateGoogleIdentityFields,
  updateUserProfile,
  getGoogleCalendarTokensByUserId,
  persistGoogleTokensForUser,
  clearGoogleTokensForUser,
};
