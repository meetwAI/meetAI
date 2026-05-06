const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { requireNumberEnv } = require('../../config/env');
const { getRedisClient, ensureRedisReady } = require('../../config/redis');

const readSecrets = () => {
  const activeSecret = process.env.JWT_ACTIVE_SECRET || process.env.JWT_SECRET || '';
  if (!activeSecret.trim()) {
    throw new Error('[env] Missing required environment variable: JWT_ACTIVE_SECRET or JWT_SECRET');
  }
  const previousSecrets = String(process.env.JWT_PREVIOUS_SECRETS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return { activeSecret, previousSecrets };
};

const { activeSecret: JWT_ACTIVE_SECRET, previousSecrets: JWT_PREVIOUS_SECRETS } = readSecrets();
const JWT_TTL_SECONDS = requireNumberEnv('JWT_TTL_SECONDS');
const JWT_TTL = `${JWT_TTL_SECONDS}s`;
const REFRESH_TTL_SECONDS = requireNumberEnv('REFRESH_TTL_SECONDS');
const REFRESH_TTL = `${REFRESH_TTL_SECONDS}s`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const userRefreshIndexKey = (userId) => `auth:user_refresh:${userId}`;
const userAccessIndexKey = (userId) => `auth:user_access:${userId}`;
const accessTokenCacheKey = (token) => `auth:access:${hashToken(token)}`;
const accessTokenCacheKeyByHash = (tokenHash) => `auth:access:${tokenHash}`;
const refreshTokenCacheKeyByHash = (tokenHash) => `auth:refresh:${tokenHash}`;

const redisClient = getRedisClient({
  cacheKey: 'auth-service',
  serviceName: 'auth-service',
});

const ensureAuthRedisReady = async () => {
  const redisReady = await ensureRedisReady(redisClient, 'auth-service');
  if (!redisReady) {
    throw new Error('redis-unavailable');
  }
};

const logRedisSnapshot = async (reason) => {
  try {
    await ensureAuthRedisReady();

    const entries = [];
    for await (const scanned of redisClient.scanIterator({ MATCH: '*', COUNT: 100 })) {
      const keys = Array.isArray(scanned) ? scanned : [scanned];
      for (const key of keys) {
        if (typeof key !== 'string') {
          continue;
        }
        const type = await redisClient.type(key);
        if (type === 'string') {
          const value = await redisClient.get(key);
          entries.push({ key, type, value });
          continue;
        }
        entries.push({ key, type, value: `<${type}>` });
      }
    }

    entries.sort((a, b) => a.key.localeCompare(b.key));
    console.log(`[auth-service] redis snapshot (${reason})`, entries);
  } catch (error) {
    console.warn('[auth-service] failed to log redis snapshot', error);
  }
};

const revokeUserRefreshToken = async (userId) => {
  if (!userId) {
    return;
  }

  await ensureAuthRedisReady();

  const indexKey = userRefreshIndexKey(userId);
  const previousRefreshHash = await redisClient.get(indexKey);
  if (!previousRefreshHash) {
    return;
  }

  await redisClient.del(refreshTokenCacheKeyByHash(previousRefreshHash));
  await redisClient.del(indexKey);
};

const revokeUserAccessToken = async (userId) => {
  if (!userId) {
    return;
  }

  await ensureAuthRedisReady();

  const indexKey = userAccessIndexKey(userId);
  const previousAccessHash = await redisClient.get(indexKey);
  if (!previousAccessHash) {
    return;
  }

  await redisClient.del(accessTokenCacheKeyByHash(previousAccessHash));
  await redisClient.del(indexKey);
};

const issueTokens = async (user) => {
  await ensureAuthRedisReady();

  const userId = String(user.id);
  await revokeUserRefreshToken(userId);
  await revokeUserAccessToken(userId);

  const authProvider = user?.authProvider ? String(user.authProvider) : '';
  const accessPayload = {
    sub: user.id,
    username: user.username,
    name: user.name,
    tokenType: 'access',
  };
  if (authProvider) {
    accessPayload.authProvider = authProvider;
  }

  const refreshPayload = {
    sub: user.id,
    username: user.username,
    name: user.name,
    tokenType: 'refresh',
  };
  if (authProvider) {
    refreshPayload.authProvider = authProvider;
  }

  const accessToken = jwt.sign(accessPayload, JWT_ACTIVE_SECRET, { expiresIn: JWT_TTL });
  const refreshToken = jwt.sign(refreshPayload, JWT_ACTIVE_SECRET, { expiresIn: REFRESH_TTL });

  const refreshHash = hashToken(refreshToken);
  const accessHash = hashToken(accessToken);
  await redisClient.set(accessTokenCacheKey(accessToken), userId, { EX: JWT_TTL_SECONDS });
  await redisClient.set(userAccessIndexKey(userId), accessHash, { EX: JWT_TTL_SECONDS });
  await redisClient.set(refreshTokenCacheKeyByHash(refreshHash), userId, { EX: REFRESH_TTL_SECONDS });
  await redisClient.set(userRefreshIndexKey(userId), refreshHash, { EX: REFRESH_TTL_SECONDS });
  await logRedisSnapshot('issueTokens');

  return { accessToken, refreshToken };
};

const verifyWithRotation = (token) => {
  const secrets = [JWT_ACTIVE_SECRET, ...JWT_PREVIOUS_SECRETS];
  let lastError = null;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('jwt-verify-failed');
};

const verifyAccessToken = async (token) => {
  await ensureAuthRedisReady();

  const payload = verifyWithRotation(token);
  if (payload?.tokenType !== 'access') {
    throw new Error('invalid-token-type');
  }
  const cached = await redisClient.get(accessTokenCacheKey(token));
  if (!cached) {
    throw new Error('token-not-cached');
  }
  return payload;
};

const verifyRefreshToken = async (token) => {
  await ensureAuthRedisReady();

  const payload = verifyWithRotation(token);
  if (payload?.tokenType !== 'refresh') {
    throw new Error('invalid-token-type');
  }
  const refreshHash = hashToken(token);
  const cachedUserId = await redisClient.get(refreshTokenCacheKeyByHash(refreshHash));
  if (!cachedUserId) {
    throw new Error('token-not-cached');
  }
  const activeRefreshHash = await redisClient.get(userRefreshIndexKey(String(payload.sub)));
  if (!activeRefreshHash || activeRefreshHash !== refreshHash) {
    throw new Error('refresh-rotation-mismatch');
  }
  return payload;
};

const revokeToken = async (token, tokenType) => {
  if (!token || !tokenType) {
    return;
  }

  await ensureAuthRedisReady();

  if (tokenType === 'access') {
    const tokenHash = hashToken(token);
    const accessKey = accessTokenCacheKeyByHash(tokenHash);
    const userId = await redisClient.get(accessKey);
    await redisClient.del(accessKey);
    if (userId) {
      const indexKey = userAccessIndexKey(userId);
      const activeAccessHash = await redisClient.get(indexKey);
      if (activeAccessHash === tokenHash) {
        await redisClient.del(indexKey);
      }
    }
    await logRedisSnapshot(`revokeToken:${tokenType}`);
    return;
  }

  const refreshHash = hashToken(token);
  const refreshKey = refreshTokenCacheKeyByHash(refreshHash);
  const userId = await redisClient.get(refreshKey);
  await redisClient.del(refreshKey);
  if (userId) {
    const indexKey = userRefreshIndexKey(userId);
    const activeRefreshHash = await redisClient.get(indexKey);
    if (activeRefreshHash === refreshHash) {
      await redisClient.del(indexKey);
    }
  }
  await logRedisSnapshot(`revokeToken:${tokenType}`);
};

module.exports = {
  issueTokens,
  verifyAccessToken,
  verifyRefreshToken,
  revokeToken,
  revokeUserRefreshToken,
  revokeUserAccessToken,
  redisClient,
  JWT_ACTIVE_SECRET,
  JWT_PREVIOUS_SECRETS,
  JWT_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
};
