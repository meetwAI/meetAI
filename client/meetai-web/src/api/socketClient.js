import { io } from 'socket.io-client';

let socket = null;

export function getSocket() {
  return socket;
}

export function connectSocket(url = import.meta.env.VITE_AUTH_URL || 'https://localhost:4010') {
  if (socket) {
    try {
      if (!socket.connected) socket.connect();
    } catch {
      // fall through to recreate socket
      try {
        socket.disconnect?.();
      } catch {
        // ignore cleanup errors
      }
      socket = null;
    }
  }

  if (!socket) {
    socket = io(url, {
      transports: ['websocket'],
      withCredentials: true,
    });
  }

  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  try {
    socket.disconnect();
  } catch {
    // ignore
  }
  socket = null;
}
