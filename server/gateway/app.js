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

const verifyAccess = (req, res, next) => {
  const targetUrl = new URL('/verify', AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const authHeader = req.headers.authorization || '';

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
          return res.status(proxyRes.statusCode || 401).json({ message: 'Unauthorized' });
        }

        let verifiedUser = null;
        try {
          const parsed = JSON.parse(data || '{}');
          verifiedUser = parsed?.user || null;
        } catch (_error) {
          verifiedUser = null;
        }

        const nextAccessToken = proxyRes.headers['x-access-token'];
        if (nextAccessToken) {
          res.set('x-access-token', nextAccessToken);
          req.authToken = nextAccessToken;
        } else {
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
          req.authToken = token;
        }

        if (proxyRes.headers['set-cookie']) {
          res.set('set-cookie', proxyRes.headers['set-cookie']);
        }

        req.authUser = verifiedUser;
        return next();
      });
    },
  );

  proxyReq.on('error', (error) => {
    console.error('[gateway] auth service proxy error', error);
    return res.status(502).json({ message: 'Auth service unavailable.' });
  });

  proxyReq.end();
};

const proxyMeetingServiceGet = (path, req, res) => {
  const targetUrl = new URL(path, MEETING_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = client.request(
    targetUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: req.authToken ? `Bearer ${req.authToken}` : req.headers.authorization || '',
        'x-user-id': req.authUser?.id ? String(req.authUser.id) : '',
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

const proxyMeetingServicePost = (path, req, res) => {
  const targetUrl = new URL(path, MEETING_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const body = JSON.stringify(req.body || {});
  const proxyReq = client.request(
    targetUrl,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: req.authToken ? `Bearer ${req.authToken}` : req.headers.authorization || '',
        'x-user-id': req.authUser?.id ? String(req.authUser.id) : '',
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

  proxyReq.write(body);
  proxyReq.end();
};

const proxyMeetingServiceDelete = (path, req, res) => {
  const targetUrl = new URL(path, MEETING_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = client.request(
    targetUrl,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: req.authToken ? `Bearer ${req.authToken}` : req.headers.authorization || '',
        'x-user-id': req.authUser?.id ? String(req.authUser.id) : '',
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

const proxyMeetingServicePatch = (path, req, res) => {
  const targetUrl = new URL(path, MEETING_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const body = JSON.stringify(req.body || {});
  const proxyReq = client.request(
    targetUrl,
    {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: req.authToken ? `Bearer ${req.authToken}` : req.headers.authorization || '',
        'x-user-id': req.authUser?.id ? String(req.authUser.id) : '',
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

  proxyReq.write(body);
  proxyReq.end();
};

app.post('/login', loginRateLimiter, (req, res) => proxyAuth('/login', req, res));
app.post('/refresh', (req, res) => proxyAuth('/refresh', req, res));

app.use(verifyAccess);

app.get('/meetings/dummy', (req, res) => {
  proxyMeetingServiceGet('/meetings/dummy', req, res);
});

app.post('/meetings', (req, res) => {
  proxyMeetingServicePost('/meetings', req, res);
});

app.get('/meetings/recent', (req, res) => {
  const params = new URLSearchParams(req.query || {});
  const queryString = params.toString();
  const path = queryString ? `/meetings/recent?${queryString}` : '/meetings/recent';
  proxyMeetingServiceGet(path, req, res);
});

app.get('/meetings/:meetingId', (req, res) => {
  const path = `/meetings/${encodeURIComponent(req.params.meetingId)}`;
  proxyMeetingServiceGet(path, req, res);
});

app.post('/meetings/:meetingId/messages', (req, res) => {
  const path = `/meetings/${encodeURIComponent(req.params.meetingId)}/messages`;
  proxyMeetingServicePost(path, req, res);
});

app.post('/meetings/:meetingId/complete', (req, res) => {
  const path = `/meetings/${encodeURIComponent(req.params.meetingId)}/complete`;
  proxyMeetingServicePost(path, req, res);
});

app.patch('/meetings/:meetingId/title', (req, res) => {
  const path = `/meetings/${encodeURIComponent(req.params.meetingId)}/title`;
  proxyMeetingServicePatch(path, req, res);
});

app.delete('/meetings/:meetingId', (req, res) => {
  const path = `/meetings/${encodeURIComponent(req.params.meetingId)}`;
  proxyMeetingServiceDelete(path, req, res);
});

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
      headers: {
        Authorization: `Bearer ${token}`,
      },
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
