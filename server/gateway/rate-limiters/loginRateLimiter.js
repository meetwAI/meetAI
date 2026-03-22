const { createClient } = require('redis');
const { requireEnv } = require('../../config/env');

const REDIS_URL = requireEnv('REDIS_URL');
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (error) => {
  console.error('[gateway] redis error', error);
});

redisClient.connect().catch((error) => {
  console.error('[gateway] redis connection error', error);
});

const loginRateLimiter = async (req, res, next) => {
  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const normalizedUsername = String(username).trim().toLowerCase();
  const rateLimitKey = `auth:login:${normalizedUsername}`;

  try {
    if (redisClient && !redisClient.isOpen) {
      await redisClient.connect();
    }

    const redisReady = Boolean(redisClient?.isReady || redisClient?.isOpen);
    if (!redisReady) {
      console.warn('[gateway] redis not ready; skipping login rate limit');
      return next();
    }

    const attempts = await redisClient.incr(rateLimitKey);
    if (attempts === 1) {
      await redisClient.expire(rateLimitKey, 60);
    }
    if (attempts > 5) {
      return res.status(429).json({ message: 'Too many login attempts. Try again in a minute.' });
    }
  } catch (error) {
    console.warn('[gateway] login rate limit check failed', error);
  }

  return next();
};

module.exports = {
  loginRateLimiter,
};
