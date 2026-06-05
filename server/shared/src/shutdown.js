// Graceful shutdown helper shared by every Node service entrypoint.
//
// Compose sends SIGTERM on `docker compose stop`; without a handler Node exits
// 137 (SIGKILL after the grace period) and in-flight requests are dropped. We
// stop accepting connections, drain the pg pool and redis client, then exit 0.
// A 15s hard timeout guards against a connection that never closes.

const installShutdown = (server, { pool, redis } = {}) => {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${signal}] shutting down`);

    server.close(async () => {
      await Promise.allSettled([pool?.end?.(), redis?.quit?.()]);
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 15_000).unref();
  };

  ['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.on(signal, () => shutdown(signal));
  });
};

module.exports = { installShutdown };
