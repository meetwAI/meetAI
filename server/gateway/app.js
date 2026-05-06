const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { requireEnv, requireNumberEnv } = require('../config/env');
const { loginRateLimiter } = require('./rate-limiters/loginRateLimiter');

const PORT = requireNumberEnv('GATEWAY_PORT');
const MEETING_SERVICE_URL = requireEnv('MEETING_SERVICE_URL');
const AUTH_SERVICE_URL = requireEnv('AUTH_SERVICE_URL');
const FRONTEND_ORIGIN = requireEnv('FRONTEND_ORIGIN');
const AI_SERVICE_WS_URL = process.env.AI_SERVICE_WS_URL || 'ws://localhost:8000/asr';

const app = express();
app.use(
  cors({
    origin: [FRONTEND_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }),
);
app.use(express.json());

const parseCookieHeader = (cookieHeader = '') => {
  const parts = String(cookieHeader || '').split(';');
  const cookies = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
};

const getCookieValue = (cookieHeader, name) => parseCookieHeader(cookieHeader)[name] || '';

const getCookieFromSetCookie = (setCookieHeader, name) => {
  const entries = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];

  for (const entry of entries) {
    const pair = String(entry || '').split(';')[0];
    if (!pair) continue;
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key !== name) continue;
    return decodeURIComponent(pair.slice(separator + 1));
  }

  return '';
};

const toBinaryBuffer = (payload) => {
  if (!payload) return null;
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (payload && typeof payload === 'object' && payload.type === 'Buffer' && Array.isArray(payload.data)) {
    return Buffer.from(payload.data);
  }
  return null;
};

const verifySocketUser = ({ bearerToken, cookieHeader }) =>
  new Promise((resolve, reject) => {
    const targetUrl = new URL('/verify', AUTH_SERVICE_URL);
    const client = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = client.request(
      targetUrl,
      {
        method: 'POST',
        headers: {
          Authorization: bearerToken ? `Bearer ${bearerToken}` : '',
          Cookie: cookieHeader,
        },
      },
      (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => {
          data += chunk;
        });
        proxyRes.on('end', () => {
          if (proxyRes.statusCode !== 200) {
            reject(new Error('Unauthorized'));
            return;
          }

          try {
            const parsed = JSON.parse(data || '{}');
            const user = parsed?.user || null;
            if (!user?.id) {
              reject(new Error('Unauthorized'));
              return;
            }
            resolve(user);
          } catch (_error) {
            reject(new Error('Unauthorized'));
          }
        });
      },
    );

    proxyReq.on('error', () => reject(new Error('Unauthorized')));
    proxyReq.end();
  });

const ensureMeetingOwnership = ({ meetingId, userId, authToken }) =>
  new Promise((resolve) => {
    const targetUrl = new URL(`/meetings/${encodeURIComponent(meetingId)}`, MEETING_SERVICE_URL);
    const client = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = client.request(
      targetUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: authToken ? `Bearer ${authToken}` : '',
          'x-user-id': String(userId),
        },
      },
      (proxyRes) => {
        proxyRes.resume();
        resolve(proxyRes.statusCode === 200);
      },
    );

    proxyReq.on('error', () => resolve(false));
    proxyReq.end();
  });

const buildAiWsUrl = ({ userId, meetingId }) => {
  const target = new URL(AI_SERVICE_WS_URL);
  target.searchParams.set('user_id', String(userId));
  target.searchParams.set('meeting_id', String(meetingId));
  return target.toString();
};

const extractTranscriptText = (payload = {}) => {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const committedText = lines
    .map((line) => String(line?.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  const bufferText = String(payload.buffer_transcription || '').trim();

  if (committedText && bufferText) {
    return `${committedText} ${bufferText}`.trim();
  }
  return committedText || bufferText;
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Auth proxy
// ---------------------------------------------------------------------------

const proxyAuth = (path, req, res, extraHeaders = {}) => {
  const targetUrl = new URL(path, AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const hasBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
  const body = hasBody ? JSON.stringify(req.body || {}) : null;

  const headers = {
    Cookie: req.headers.cookie || '',
    ...extraHeaders,
  };

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers,
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
        if (proxyRes.headers.location) {
          res.set('location', proxyRes.headers.location);
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

  if (hasBody) {
    proxyReq.write(body);
  }
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
  const cookieHeader = req.headers.cookie || '';
  const accessCookieToken = getCookieValue(cookieHeader, 'meetai_access');

  const applyVerifiedSession = ({ user, accessToken, setCookieHeader }) => {
    if (setCookieHeader) {
      res.set('set-cookie', setCookieHeader);
    }

    if (accessToken) {
      req.authToken = accessToken;
    } else {
      req.authToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : accessCookieToken;
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
            const newAccessToken =
              getCookieFromSetCookie(refreshRes.headers['set-cookie'], 'meetai_access') || '';
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

        if (!verifiedUser) {
          return refreshSession();
        }

        return applyVerifiedSession({
          user: verifiedUser,
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

// Forward a request to the meeting service. Two response modes:
//   - JSON / regular: buffer the body and forward at the end (default).
//   - text/event-stream: pipe the upstream response through to the client
//     unbuffered so SSE deltas arrive in real time. The QA path of
//     POST /meetings/:id/messages relies on this — without the streaming
//     branch, every token would queue up here until the upstream stream
//     closed, which is exactly the "answer in one bulk" failure mode the
//     SSE design is meant to avoid.
const proxyMeetingService = (method, path, req, res) => {
  const targetUrl = new URL(path, MEETING_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;
  const hasBody = method === 'POST' || method === 'PATCH';
  const body = hasBody ? JSON.stringify(req.body || {}) : null;

  // Forward the client's Accept header so the meeting service knows when
  // the browser wants SSE; default to application/json for the existing
  // routes that have always returned JSON.
  const clientAccept = String(req.headers['accept'] || '').toLowerCase();
  const wantsSse =
    clientAccept.includes('text/event-stream') ||
    (req.body && req.body.mode === 'qa');

  const headers = {
    Accept: wantsSse ? 'text/event-stream' : 'application/json',
    Authorization: req.authToken ? `Bearer ${req.authToken}` : '',
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
      const upstreamType = String(
        proxyRes.headers['content-type'] || 'application/json',
      );
      const isStream = upstreamType.toLowerCase().includes('text/event-stream');

      if (isStream) {
        // Pipe-through path: forward headers verbatim, including the
        // anti-buffering hints, and stream the body bytes as they arrive.
        res.status(proxyRes.statusCode || 200);
        res.setHeader('Content-Type', upstreamType);
        res.setHeader(
          'Cache-Control',
          proxyRes.headers['cache-control'] || 'no-cache, no-transform',
        );
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }

        proxyRes.on('data', (chunk) => {
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          if (!res.writableEnded) {
            res.end();
          }
        });
        proxyRes.on('error', (error) => {
          console.error('[gateway] upstream stream error', error);
          if (!res.writableEnded) {
            res.end();
          }
        });
        // If the browser disconnects, abort the upstream so we don't keep
        // pulling tokens nobody is reading.
        req.on('close', () => {
          if (!res.writableEnded) {
            proxyReq.destroy();
          }
        });
        return;
      }

      // Buffered JSON path — preserves the historical behaviour.
      let data = '';
      proxyRes.on('data', (chunk) => {
        data += chunk;
      });
      proxyRes.on('end', () => {
        res
          .status(proxyRes.statusCode || 200)
          .set('content-type', upstreamType)
          .send(data);
      });
    },
  );

  proxyReq.on('error', (error) => {
    console.error('[gateway] meeting service proxy error', error);
    if (!res.headersSent) {
      res.status(502).json({ message: 'Meeting service unavailable.' });
    } else if (!res.writableEnded) {
      res.end();
    }
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
app.post('/verify', (req, res) => proxyAuth('/verify', req, res));
app.get('/auth/google', (req, res) => proxyAuth(req.originalUrl, req, res));
app.get('/auth/google/calendar', verifyAccess, (req, res) =>
  proxyAuth('/auth/google/calendar', req, res, {
    'x-user-id': req.authUser?.id ? String(req.authUser.id) : '',
  }),
);
app.get('/auth/google/callback', (req, res) => proxyAuth(req.originalUrl, req, res));

app.use(verifyAccess); // verification required for all routes below

app.get('/calendar/status', (req, res) => {
  const targetUrl = new URL('/calendar/status', AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = client.request(
    targetUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
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
    console.error('[gateway] auth service calendar status proxy error', error);
    res.status(502).json({ message: 'Auth service unavailable.' });
  });

  proxyReq.end();
});

app.get('/calendar/events', (req, res) => {
  const params = new URLSearchParams(req.query || {});
  const queryString = params.toString();
  const targetPath = queryString ? `/calendar/events?${queryString}` : '/calendar/events';
  const targetUrl = new URL(targetPath, AUTH_SERVICE_URL);
  const client = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = client.request(
    targetUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
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
    console.error('[gateway] auth service calendar proxy error', error);
    res.status(502).json({ message: 'Auth service unavailable.' });
  });

  proxyReq.end();
});

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
    console.error('[gateway] auth service profile proxy error', error);
    res.status(502).json({ message: 'Auth service unavailable.' });
  });

  proxyReq.write(body);
  proxyReq.end();
});

app.get('/meetings/dummy', (req, res) => {
  const params = new URLSearchParams(req.query || {});
  const qs = params.toString();
  proxyMeetingService('GET', qs ? `/meetings/dummy?${qs}` : '/meetings/dummy', req, res);
});
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

app.patch('/meetings/:meetingId/transcript', (req, res) =>
  proxyMeetingService('PATCH', `/meetings/${encodeURIComponent(req.params.meetingId)}/transcript`, req, res),
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
// Socket.io — bridge browser PCM stream to AI websocket service
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [FRONTEND_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || '';
  const cookieHeader = socket.handshake.headers?.cookie || '';
  const accessCookieToken = getCookieValue(cookieHeader, 'meetai_access');
  const bearerToken = token || accessCookieToken;

  if (!bearerToken) {
    return next(new Error('Unauthorized'));
  }

  return verifySocketUser({ bearerToken, cookieHeader })
    .then((user) => {
      socket.data.authUser = user;
      socket.data.authToken = bearerToken;
      return next();
    })
    .catch(() => next(new Error('Unauthorized')));
});

io.on('connection', (socket) => {
  console.log('[gateway] client connected', socket.id);

  let aiSocket = null;
  let activeMeetingId = null;
  let didEmitEnded = false;
  let lastLoggedTranscript = '';

  const emitSessionEnded = (payload = {}) => {
    if (!activeMeetingId || didEmitEnded) {
      return;
    }
    didEmitEnded = true;
    socket.emit('meeting-session-ended', {
      meetingId: Number(activeMeetingId),
      ...payload,
    });
  };

  const cleanupAiSocket = () => {
    if (!aiSocket) {
      return;
    }

    try {
      aiSocket.removeAllListeners();
    } catch {
      // ignore
    }

    try {
      aiSocket.close();
    } catch {
      // ignore
    }

    aiSocket = null;
  };

  const ensureAiSession = async (meetingId) => {
    if (aiSocket && aiSocket.readyState !== WebSocket.CLOSED && Number(activeMeetingId) === Number(meetingId)) {
      return true;
    }

    if (aiSocket && aiSocket.readyState !== WebSocket.CLOSED) {
      try {
        cleanupAiSocket();
      } catch {
        // ignore
      }
    }

    const userId = Number(socket.data.authUser?.id);
    const authToken = String(socket.data.authToken || '');
    console.log('[gateway] meeting-session-start requested', { socketId: socket.id, meetingId, userId });

    if (!Number.isFinite(meetingId) || meetingId <= 0) {
      socket.emit('meeting-session-error', { message: 'Invalid meeting id.' });
      return false;
    }

    if (!Number.isFinite(userId) || userId <= 0) {
      socket.emit('meeting-session-error', { message: 'Unauthorized user context.' });
      return false;
    }

    const ownsMeeting = await ensureMeetingOwnership({ meetingId, userId, authToken });
    if (!ownsMeeting) {
      socket.emit('meeting-session-error', { message: 'Meeting not found or not owned by user.' });
      return false;
    }

    const wsUrl = buildAiWsUrl({ userId, meetingId });
    const ws = new WebSocket(wsUrl);

    aiSocket = ws;
    activeMeetingId = meetingId;
    didEmitEnded = false;
    lastLoggedTranscript = '';

    ws.on('open', () => {
      console.log('[gateway] connected to ai service', { socketId: socket.id, meetingId, wsUrl });
    });

    ws.on('message', (raw) => {
      const textPayload = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw || '');

      let parsed;
      try {
        parsed = JSON.parse(textPayload || '{}');
      } catch (_error) {
        socket.emit('meeting-session-error', { message: 'Received malformed AI payload.' });
        return;
      }

      console.log('[gateway] ai payload received', {
        meetingId,
        type: parsed?.type || 'transcript',
        status: parsed?.status || '',
        lines: Array.isArray(parsed?.lines) ? parsed.lines.length : 0,
        bufferChars: String(parsed?.buffer_transcription || '').length,
      });

      if (parsed?.type === 'config') {
        console.log('[gateway] ai session configured', {
          meetingId,
          aiSessionId: parsed.session_id || '',
          sampleRate: Number(parsed.sample_rate) || 16000,
        });
        socket.emit('meeting-session-ready', {
          meetingId,
          aiSessionId: parsed.session_id || '',
          sampleRate: Number(parsed.sample_rate) || 16000,
          encoding: parsed.encoding || 's16le',
          channels: Number(parsed.channels) || 1,
        });
        return;
      }

      if (parsed?.type === 'ready_to_stop') {
        console.log('[gateway] ai session ready_to_stop', { meetingId });
        emitSessionEnded();
        cleanupAiSocket();
        aiSocket = null;
        activeMeetingId = null;
        lastLoggedTranscript = '';
        return;
      }

      const transcriptText = extractTranscriptText(parsed);
      if (transcriptText && transcriptText !== lastLoggedTranscript) {
        console.log(`[gateway][meeting:${meetingId}] transcript: ${transcriptText}`);
        lastLoggedTranscript = transcriptText;
      }

      socket.emit('meeting-transcript-update', {
        meetingId,
        aiSessionId: parsed?.session_id || '',
        ...parsed,
      });
    });

    ws.on('error', (error) => {
      console.error('[gateway] ai socket error', {
        meetingId,
        wsUrl,
        message: error?.message || 'unknown error',
      });
      socket.emit('meeting-session-error', {
        message: 'AI service connection failed.',
        detail: error?.message || '',
      });
    });

    ws.on('unexpected-response', (_request, response) => {
      console.error('[gateway] ai socket unexpected response', {
        meetingId,
        wsUrl,
        statusCode: response?.statusCode || null,
        statusMessage: response?.statusMessage || '',
      });
    });

    ws.on('close', (code, reasonBuffer) => {
      const reason = Buffer.isBuffer(reasonBuffer)
        ? reasonBuffer.toString('utf-8')
        : String(reasonBuffer || '');
      console.log('[gateway] ai socket closed', { meetingId, wsUrl, code, reason });
      emitSessionEnded({ code, reason });
      cleanupAiSocket();
      aiSocket = null;
      activeMeetingId = null;
      lastLoggedTranscript = '';
    });

    return true;
  };

  socket.on('meeting-session-start', async (payload) => {
    const meetingId = Number(payload?.meetingId);
    await ensureAiSession(meetingId);
  });

  socket.on('meeting-audio-pcm', (payload) => {
    if (!aiSocket || aiSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const binaryPayload = toBinaryBuffer(payload);
    if (!binaryPayload || binaryPayload.length === 0) {
      return;
    }

    aiSocket.send(binaryPayload, { binary: true }, (error) => {
      if (!error) {
        return;
      }
      socket.emit('meeting-session-error', {
        message: 'Failed to send audio chunk to AI service.',
        detail: error.message,
      });
    });
  });

  socket.on('meeting-session-stop', () => {
    if (!aiSocket) {
      emitSessionEnded();
      return;
    }

    if (aiSocket.readyState !== WebSocket.OPEN) {
      cleanupAiSocket();
      emitSessionEnded();
      aiSocket = null;
      activeMeetingId = null;
      return;
    }

    aiSocket.send(Buffer.alloc(0), { binary: true }, (error) => {
      if (!error) {
        return;
      }
      socket.emit('meeting-session-error', {
        message: 'Failed to stop AI session cleanly.',
        detail: error.message,
      });
    });
  });

  socket.on('disconnect', () => {
    console.log('[gateway] client disconnected', socket.id);
    cleanupAiSocket();
    aiSocket = null;
    activeMeetingId = null;
    lastLoggedTranscript = '';
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Gateway listening on ${PORT}`);
});
