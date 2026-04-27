const { Server } = require('socket.io');

const setupSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    socket.on('disconnect', () => {
      // no-op for now
    });
  });

  return io;
};

module.exports = { setupSocket };
