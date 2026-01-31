const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('redis');

const JWT_SECRET = process.env.JWT_SECRET || 'meetai_dev_secret';
const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 20);
const JWT_TTL = `${JWT_TTL_SECONDS}s`;
const REFRESH_TTL_SECONDS = Number(process.env.REFRESH_TTL_SECONDS || 60 * 60 * 24 * 10);
const REFRESH_TTL = `${REFRESH_TTL_SECONDS}s`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
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

module.exports = {
  issueTokens,
  verifyAccessToken,
  verifyRefreshToken,
  JWT_SECRET,
  JWT_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
};
