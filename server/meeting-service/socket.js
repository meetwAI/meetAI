const { Server } = require('socket.io');

const setupSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    socket.on('meeting-audio-chunk', (meta, payload) => {
      const chunkIndex = meta?.chunkIndex ?? null;
      console.log('[meeting-service] received chunk', chunkIndex, payload?.byteLength || 0);

      setTimeout(() => {
        const label = `chunk ${chunkIndex + 1} processed`;
        console.log('[meeting-service] responding:', label);
        socket.emit('meeting-audio-processed', label);
      }, 10_000);
    });

    socket.on('disconnect', () => {
      // no-op for now
    });
  });

  return io;
};

module.exports = { setupSocket };
