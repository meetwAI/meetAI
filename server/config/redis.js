const { createClient } = require('redis');
const { requireEnv } = require('./env');

const clientRegistry = new Map();
const connectPromises = new WeakMap();

const ensureRedisReady = async (client, serviceName = 'service') => {
  if (!client) {
    return false;
  }

  if (client.isReady || client.isOpen) {
    return true;
  }

  if (!connectPromises.has(client)) {
    const connectPromise = client
      .connect()
      .catch((error) => {
        console.error(`[${serviceName}] redis connection error`, error);
      })
      .finally(() => {
        connectPromises.delete(client);
      });

    connectPromises.set(client, connectPromise);
  }

  await connectPromises.get(client);
  return Boolean(client.isReady || client.isOpen);
};

const getRedisClient = ({
  cacheKey = 'default',
  serviceName = 'service',
  envName = 'REDIS_URL',
} = {}) => {
  if (clientRegistry.has(cacheKey)) {
    return clientRegistry.get(cacheKey);
  }

  const redisUrl = requireEnv(envName);
  const client = createClient({ url: redisUrl });

  client.on('error', (error) => {
    console.error(`[${serviceName}] redis error`, error);
  });

  clientRegistry.set(cacheKey, client);
  void ensureRedisReady(client, serviceName);
  return client;
};

module.exports = {
  getRedisClient,
  ensureRedisReady,
};
