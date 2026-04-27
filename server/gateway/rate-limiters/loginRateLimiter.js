const { getRedisClient, ensureRedisReady } = require('../../config/redis');

const redisClient = getRedisClient({
  cacheKey: 'gateway',
  serviceName: 'gateway',
});

const loginRateLimiter = async (req, res, next) => {
  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const normalizedUsername = String(username).trim().toLowerCase();
  const rateLimitKey = `auth:login:${normalizedUsername}`;

  try {
    const redisReady = await ensureRedisReady(redisClient, 'gateway');
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
