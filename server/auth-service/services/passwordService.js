const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const KEYLEN = 64;
const SALT_BYTES = 16;
const HASH_PREFIX = 'scrypt';

const toBase64Url = (buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const fromBase64Url = (value) => {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
};

const isPasswordHash = (value) => typeof value === 'string' && value.startsWith(`${HASH_PREFIX}$`);

const hashPassword = async (password) => {
  const normalizedPassword = String(password || '');
  const salt = crypto.randomBytes(SALT_BYTES);
  const params = { N: 16384, r: 8, p: 1 };
  const derived = await scryptAsync(normalizedPassword, salt, KEYLEN, params);
  return [
    HASH_PREFIX,
    params.N,
    params.r,
    params.p,
    toBase64Url(salt),
    toBase64Url(derived),
  ].join('$');
};

const verifyPassword = async (password, encodedHash) => {
  const normalizedPassword = String(password || '');
  if (!isPasswordHash(encodedHash)) {
    return false;
  }

  const [prefix, nRaw, rRaw, pRaw, saltRaw, digestRaw] = encodedHash.split('$');
  if (prefix !== HASH_PREFIX || !nRaw || !rRaw || !pRaw || !saltRaw || !digestRaw) {
    return false;
  }

  const params = {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
  };
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
    return false;
  }

  const salt = fromBase64Url(saltRaw);
  const expected = fromBase64Url(digestRaw);
  const derived = await scryptAsync(normalizedPassword, salt, expected.length, params);
  if (derived.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
};

module.exports = {
  hashPassword,
  verifyPassword,
  isPasswordHash,
};
