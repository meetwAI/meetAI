const crypto = require('crypto');
const { requireEnv } = require('@meetai/shared/env');

const normalizeText = (value) => String(value || '').trim();

let cachedGoogleIdHmacSecret = null;
let cachedGoogleTokenEncryptionKey = null;

const getGoogleIdHmacSecret = () => {
  if (cachedGoogleIdHmacSecret) {
    return cachedGoogleIdHmacSecret;
  }

  const secret = normalizeText(requireEnv('GOOGLE_ID_HMAC_SECRET'));
  if (!secret) {
    throw new Error('[auth-service] GOOGLE_ID_HMAC_SECRET must not be empty.');
  }

  cachedGoogleIdHmacSecret = secret;
  return cachedGoogleIdHmacSecret;
};

const getGoogleTokenEncryptionKey = () => {
  if (cachedGoogleTokenEncryptionKey) {
    return cachedGoogleTokenEncryptionKey;
  }

  const rawKey = normalizeText(requireEnv('GOOGLE_TOKEN_ENCRYPTION_KEY'));
  if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new Error('[auth-service] GOOGLE_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes in hex (64 hex chars).');
  }

  const key = Buffer.from(rawKey, 'hex');
  if (key.length !== 32) {
    throw new Error('[auth-service] GOOGLE_TOKEN_ENCRYPTION_KEY decoded length must be 32 bytes.');
  }

  cachedGoogleTokenEncryptionKey = key;
  return cachedGoogleTokenEncryptionKey;
};

const hashGoogleId = (googleId) => {
  const normalizedGoogleId = normalizeText(googleId);
  if (!normalizedGoogleId) {
    return '';
  }

  return crypto
    .createHmac('sha256', getGoogleIdHmacSecret())
    .update(normalizedGoogleId)
    .digest('hex');
};

const encryptGoogleRefreshToken = (refreshToken) => {
  const normalizedRefreshToken = normalizeText(refreshToken);
  if (!normalizedRefreshToken) {
    return null;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getGoogleTokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(normalizedRefreshToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
};

const decryptGoogleRefreshToken = ({ iv, ciphertext, tag }) => {
  const normalizedIv = normalizeText(iv);
  const normalizedCiphertext = normalizeText(ciphertext);
  const normalizedTag = normalizeText(tag);

  if (!normalizedIv || !normalizedCiphertext || !normalizedTag) {
    return '';
  }

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getGoogleTokenEncryptionKey(),
      Buffer.from(normalizedIv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(normalizedTag, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(normalizedCiphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return normalizeText(plaintext);
  } catch (_error) {
    const decryptError = new Error('google-refresh-token-decrypt-failed');
    decryptError.code = 'google-refresh-token-decrypt-failed';
    throw decryptError;
  }
};

module.exports = {
  hashGoogleId,
  encryptGoogleRefreshToken,
  decryptGoogleRefreshToken,
};
