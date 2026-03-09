const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { loginRateLimiter } = require('./rate-limiters/loginRateLimiter');

const PORT = process.env.GATEWAY_PORT || 4010;
const MEETING_SERVICE_URL = process.env.MEETING_SERVICE_URL || 'http://localhost:4001';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4020';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(
  cors({
    origin: [FRONTEND_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    exposedHeaders: ['x-access-token'],
  }),
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Auth proxy
// ---------------------------------------------------------------------------

const proxyAuth = (path, req, res) => {
  const targetUrl = new URL(path, AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const body = JSON.stringify(req.body || {});

  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Cookie: req.headers.cookie || '',
      },
    },
    (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => {
        data += chunk;
      });
      proxyRes.on('end', () => {
        if (proxyRes.headers['set-cookie']) {
          res.set('set-cookie', proxyRes.headers['set-cookie']);
        }
        res
          .status(proxyRes.statusCode || 200)
          .set('content-type', proxyRes.headers['content-type'] || 'application/json')
          .send(data);
      });
    },
  );

  proxyReq.on('error', (error) => {
    console.error('[gateway] auth service proxy error', error);
    res.status(502).json({ message: 'Auth service unavailable.' });
  });

  proxyReq.write(body);
  proxyReq.end();
};

// ---------------------------------------------------------------------------
// Auth verification middleware
// ---------------------------------------------------------------------------

const verifyAccess = (req, res, next) => {
  const targetUrl = new URL('/verify', AUTH_SERVICE_URL);
  const refreshUrl = new URL('/refresh', AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const authHeader = req.headers.authorization || '';

  const applyVerifiedSession = ({ user, accessToken, setCookieHeader }) => {
    if (setCookieHeader) {
      res.set('set-cookie', setCookieHeader);
    }
    if (accessToken) {
      res.set('x-access-token', accessToken);
      req.authToken = accessToken;
    } else {
      req.authToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    }
    req.authUser = user;
    return next();
  };

  const unauthorized = () => res.status(401).json({ message: 'Unauthorized' });

  const refreshSession = () => {
    const refreshClient = refreshUrl.protocol === 'https:' ? https : http;
    const refreshReq = refreshClient.request(
      refreshUrl,
      {
        method: 'POST',
        headers: {
          Cookie: req.headers.cookie || '',
        },
      },
      (refreshRes) => {
        let refreshData = '';
        refreshRes.on('data', (chunk) => {
          refreshData += chunk;
        });
        refreshRes.on('end', () => {
          if (refreshRes.statusCode !== 200) {
            return unauthorized();
          }

          try {
            const parsed = JSON.parse(refreshData || '{}');
            const newAccessToken = parsed?.token || '';
            const user = parsed?.user || null;
            if (!newAccessToken || !user) {
              return unauthorized();
            }
            return applyVerifiedSession({
              user,
              accessToken: newAccessToken,
              setCookieHeader: refreshRes.headers['set-cookie'],
            });
          } catch (_error) {
            return unauthorized();
          }
        });
      },
    );

    refreshReq.on('error', (error) => {
      console.error('[gateway] auth service refresh proxy error', error);
      return res.status(502).json({ message: 'Auth service unavailable.' });
    });

    refreshReq.end();
  };

  const proxyReq = client.request(
    targetUrl,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        Cookie: req.headers.cookie || '',
      },
    },
    (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => {
        data += chunk;
      });
      proxyRes.on('end', () => {
        if (proxyRes.statusCode !== 200) {
          return refreshSession();
        }

        let verifiedUser = null;
        try {
          const parsed = JSON.parse(data || '{}');
          verifiedUser = parsed?.user || null;
        } catch (_error) {
          verifiedUser = null;
        }

        const nextAccessToken = proxyRes.headers['x-access-token'];
        return applyVerifiedSession({
          user: verifiedUser,
          accessToken: nextAccessToken,
          setCookieHeader: proxyRes.headers['set-cookie'],
        });
      });
    },
  );

  proxyReq.on('error', (error) => {
    console.error('[gateway] auth service proxy error', error);
    return res.status(502).json({ message: 'Auth service unavailable.' });
  });

  proxyReq.end();
};

// ---------------------------------------------------------------------------
// Meeting service proxy
// ---------------------------------------------------------------------------

const proxyMeetingService = (method, path, req, res) => {
  const targetUrl = new URL(path, MEETING_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const hasBody = method === 'POST' || method === 'PATCH';
  const body = hasBody ? JSON.stringify(req.body || {}) : null;

  const headers = {
    Accept: 'application/json',
    Authorization: req.authToken ? `Bearer ${req.authToken}` : req.headers.authorization || '',
    'x-user-id': req.authUser?.id ? String(req.authUser.id) : '',
  };

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  const proxyReq = client.request(
    targetUrl,
    { method, headers },
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

  if (hasBody) {
    proxyReq.write(body);
  }
  proxyReq.end();
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// public routes
app.post('/login', loginRateLimiter, (req, res) => proxyAuth('/login', req, res));
app.post('/signup', loginRateLimiter, (req, res) => proxyAuth('/signup', req, res));
app.post('/refresh', (req, res) => proxyAuth('/refresh', req, res));
app.post('/logout', (req, res) => proxyAuth('/logout', req, res));

app.use(verifyAccess); // verification required for all routes below

// Profile setup — auth-service handles persistence
app.post('/profile', (req, res) => {
  const targetUrl = new URL('/profile', AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const body = JSON.stringify(req.body || {});

  const proxyReq = client.request(
    targetUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-user-id': req.authUser?.id ? String(req.authUser.id) : '',
      },
    },
    (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => { data += chunk; });
      proxyRes.on('end', () => {
        res
          .status(proxyRes.statusCode || 200)
          .set('content-type', proxyRes.headers['content-type'] || 'application/json')
          .send(data);
      });
    },
  );

  proxyReq.on('error', (error) => {
    console.error('[gateway] auth service profile proxy error', error);
    res.status(502).json({ message: 'Auth service unavailable.' });
  });

  proxyReq.write(body);
  proxyReq.end();
});

app.get('/meetings/dummy', (req, res) => proxyMeetingService('GET', '/meetings/dummy', req, res));
app.post('/meetings', (req, res) => proxyMeetingService('POST', '/meetings', req, res));

app.get('/meetings/recent', (req, res) => {
  const params = new URLSearchParams(req.query || {});
  const qs = params.toString();
  proxyMeetingService('GET', qs ? `/meetings/recent?${qs}` : '/meetings/recent', req, res);
});

app.get('/meetings/:meetingId', (req, res) =>
  proxyMeetingService('GET', `/meetings/${encodeURIComponent(req.params.meetingId)}`, req, res),
);

app.post('/meetings/:meetingId/messages', (req, res) =>
  proxyMeetingService('POST', `/meetings/${encodeURIComponent(req.params.meetingId)}/messages`, req, res),
);

app.post('/meetings/:meetingId/complete', (req, res) =>
  proxyMeetingService('POST', `/meetings/${encodeURIComponent(req.params.meetingId)}/complete`, req, res),
);

app.patch('/meetings/:meetingId/title', (req, res) =>
  proxyMeetingService('PATCH', `/meetings/${encodeURIComponent(req.params.meetingId)}/title`, req, res),
);

app.delete('/meetings/:meetingId', (req, res) =>
  proxyMeetingService('DELETE', `/meetings/${encodeURIComponent(req.params.meetingId)}`, req, res),
);

// ---------------------------------------------------------------------------
// Socket.io — relay audio chunks to meeting service
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [FRONTEND_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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

  const targetUrl = new URL('/verify', AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = client.request(
    targetUrl,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    },
    (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        return next(new Error('Unauthorized'));
      }
      return next();
    },
  );

  proxyReq.on('error', () => next(new Error('Unauthorized')));
  proxyReq.end();
});

io.on('connection', (socket) => {
  console.log('[gateway] client connected', socket.id);

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
    if (now - lastChunkAt < 8000) {
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
