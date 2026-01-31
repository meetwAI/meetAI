const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { createClient } = require('redis');

const PORT = process.env.GATEWAY_PORT || 4010;
const MEETING_SERVICE_URL = process.env.MEETING_SERVICE_URL || 'http://localhost:4001';
const JWT_SECRET = process.env.JWT_SECRET || 'meetai_dev_secret';
const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 20);
const JWT_TTL = `${JWT_TTL_SECONDS}s`;
const USERS_PATH = path.join(__dirname, '..', 'users.json');

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.on('error', (error) => {
  console.error('[gateway] redis error', error);
});

redisClient.connect().catch((error) => {
  console.error('[gateway] redis connection error', error);
});

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const proxyMeetingServiceGet = (path, req, res) => {
  const targetUrl = new URL(path, MEETING_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = client.request(
    targetUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: req.headers.authorization || '',
      },
    },
    (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => {
        data += chunk;
      });
      proxyRes.on('end', () => {
        res
          .status(proxyRes.statusCode || 200)
          .set('content-type', proxyRes.headers['content-type'] || 'application/json')
          .send(data);
      });
    },
  );

  proxyReq.on('error', (error) => {
    console.error('[gateway] meeting service proxy error', error);
    res.status(502).json({ message: 'Meeting service unavailable.' });
  });

  proxyReq.end();
};

app.post('/login', express.json(), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const raw = fs.readFileSync(USERS_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const user = data.users.find(
    (item) => item.username === username && item.password === password,
  );

  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  const token = jwt.sign(
    { sub: user.id, username: user.username, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_TTL },
  );

  redisClient.set(`auth:token:${token}`, user.id, { EX: JWT_TTL_SECONDS }).catch((error) => {
    console.error('[gateway] redis set token error', error);
  });

  return res.json({
    token,
    user: { id: user.id, username: user.username, name: user.name },
  });
});

app.use((req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    redisClient
      .get(`auth:token:${token}`)
      .then((cached) => {
        if (!cached) {
          return res.status(401).json({ message: 'Unauthorized' });
        }
        req.user = payload;
        return next();
      })
      .catch(() => res.status(401).json({ message: 'Unauthorized' }));
  } catch (error) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
});

app.get('/meetings/dummy', (req, res) => {
  proxyMeetingServiceGet('/meetings/dummy', req, res);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const normalizeMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return null;
  const chunkIndex = Number(meta.chunkIndex);
  const durationMs = Number(meta.durationMs);
  const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : '';
  if (!Number.isFinite(chunkIndex) || !Number.isFinite(durationMs)) return null;
  if (!mimeType) return null;
  return { chunkIndex, durationMs, mimeType };
};

const isBinaryPayload = (payload) =>
  payload instanceof ArrayBuffer ||
  ArrayBuffer.isView(payload) ||
  (payload && typeof payload === 'object' && payload.type === 'Buffer');

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Unauthorized'));
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    redisClient
      .get(`auth:token:${token}`)
      .then((cached) => {
        if (!cached) {
          return next(new Error('Unauthorized'));
        }
        socket.user = payload;
        return next();
      })
      .catch(() => next(new Error('Unauthorized')));
  } catch (error) {
    return next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  console.log('[gateway] client connected', socket.id, socket.user?.username);

  const meetingSocket = ioClient(MEETING_SERVICE_URL, {
    transports: ['websocket'],
  });

  let lastChunkAt = 0;

  meetingSocket.on('connect', () => {
    console.log('[gateway] connected to meeting service');
  });

  meetingSocket.on('connect_error', (error) => {
    console.error('[gateway] meeting service connection error', error);
  });

  meetingSocket.on('meeting-audio-processed', (payload) => {
    console.log('[gateway] relaying response', payload);
    socket.emit('meeting-audio-processed', payload);
  });

  socket.on('meeting-audio-chunk', (meta, payload) => {
    const now = Date.now();
    if (now - lastChunkAt < 8_000) {
      console.warn('[gateway] rate limit exceeded');
      socket.emit('meeting-audio-processed', 'rate limit exceeded');
      return;
    }

    const normalizedMeta = normalizeMeta(meta);
    
    if (!normalizedMeta || !isBinaryPayload(payload)) {
      const payloadType = payload?.constructor?.name || typeof payload;
      console.warn('[gateway] invalid payload shape', { meta, payloadType });
      socket.emit('meeting-audio-processed', 'invalid payload');
      return;
    }

    lastChunkAt = now;
    console.log('[gateway] forwarding chunk', normalizedMeta.chunkIndex, normalizedMeta.durationMs);
    meetingSocket.emit('meeting-audio-chunk', normalizedMeta, payload);
  });

  socket.on('disconnect', () => {
    console.log('[gateway] client disconnected', socket.id);
    meetingSocket.disconnect();
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Gateway listening on ${PORT}`);
});
