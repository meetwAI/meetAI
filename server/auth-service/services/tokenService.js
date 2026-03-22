const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('redis');
const { requireEnv, requireNumberEnv } = require('../../config/env');

const JWT_SECRET = requireEnv('JWT_SECRET');
const JWT_TTL_SECONDS = requireNumberEnv('JWT_TTL_SECONDS');
const JWT_TTL = `${JWT_TTL_SECONDS}s`;
const REFRESH_TTL_SECONDS = requireNumberEnv('REFRESH_TTL_SECONDS');
const REFRESH_TTL = `${REFRESH_TTL_SECONDS}s`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const redisClient = createClient({
  url: requireEnv('REDIS_URL'),
});

redisClient.on('error', (error) => {
  console.error('[auth-service] redis error', error);
});

redisClient.connect().catch((error) => {
  console.error('[auth-service] redis connection error', error);
});

const issueTokens = async (user) => {
  const accessToken = jwt.sign(
    { sub: user.id, username: user.username, name: user.name, tokenType: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_TTL },
  );

  const refreshToken = jwt.sign(
    { sub: user.id, username: user.username, name: user.name, tokenType: 'refresh' },
    JWT_SECRET,
    { expiresIn: REFRESH_TTL },
  );

  await redisClient.set(`auth:access:${hashToken(accessToken)}`, user.id, { EX: JWT_TTL_SECONDS });
  await redisClient.set(`auth:refresh:${hashToken(refreshToken)}`, user.id, { EX: REFRESH_TTL_SECONDS });

  return { accessToken, refreshToken };
};

const verifyAccessToken = async (token) => {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload?.tokenType !== 'access') {
    throw new Error('invalid-token-type');
  }
  const cached = await redisClient.get(`auth:access:${hashToken(token)}`);
  if (!cached) {
    throw new Error('token-not-cached');
  }
  return payload;
};

const verifyRefreshToken = async (token) => {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload?.tokenType !== 'refresh') {
    throw new Error('invalid-token-type');
  }
  const cached = await redisClient.get(`auth:refresh:${hashToken(token)}`);
  if (!cached) {
    throw new Error('token-not-cached');
  }
  return payload;
};

const revokeToken = async (token, tokenType) => {
  if (!token || !tokenType) {
    return;
  }

  const prefix = tokenType === 'access' ? 'auth:access:' : 'auth:refresh:';
  await redisClient.del(`${prefix}${hashToken(token)}`);
};

module.exports = {
  issueTokens,
  verifyAccessToken,
  verifyRefreshToken,
  revokeToken,
  redisClient,
  JWT_SECRET,
  JWT_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
};
