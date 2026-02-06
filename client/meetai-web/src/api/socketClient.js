import { io } from 'socket.io-client';

let socket = null;

export function getSocket() {
  return socket;
}

export function connectSocket(token, url = 'http://localhost:4010') {
  if (socket) {
    try {
      if (token && (!socket.auth || socket.auth.token !== token)) {
        socket.auth = { token };
      }
      if (!socket.connected) socket.connect();
    } catch (e) {
      // fall through to recreate socket
      try {
        socket.disconnect?.();
      } catch (_) {}
      socket = null;
    }
  }

  if (!socket) {
    socket = io(url, {
      transports: ['websocket'],
      auth: { token },
    });
  }

  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  try {
    socket.disconnect();
  } catch (e) {
    // ignore
  }
  socket = null;
}
