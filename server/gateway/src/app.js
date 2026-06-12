const http = require('http');
const https = require('https');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const os = require('os');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { requireEnv, requireNumberEnv } = require('@meetai/shared/env');
const { getRedisClient, ensureRedisReady } = require('@meetai/shared/redis');
const { query: dbQuery } = require('@meetai/shared/db');
const { installShutdown } = require('@meetai/shared/shutdown');
const {
  MEETING_QA_CACHE_TTL_SECONDS,
  MEETING_QA_CACHE_PREFIX,
  MEETING_QA_MAX_SPEAKERS,
} = require('@meetai/shared/constants');
const { loginRateLimiter } = require('./lib/rateLimit');

const PORT = requireNumberEnv('GATEWAY_PORT');
const MEETING_SERVICE_URL = requireEnv('MEETING_SERVICE_URL');
const AUTH_SERVICE_URL = requireEnv('AUTH_SERVICE_URL');
const FRONTEND_ORIGIN = requireEnv('FRONTEND_ORIGIN');
const AI_SERVICE_WS_URL = process.env.AI_SERVICE_WS_URL || 'ws://0.0.0.0:8000/asr';
const useHttps = false && process.env.AUTH_USE_HTTPS === 'true';
const QA_SERVICE_URL = (process.env.QA_SERVICE_URL || ' http://qa-service:8100').trim().replace(/\/+$/, '');
// Only skip upstream TLS verification when explicitly opted in (dev with
// self-signed certs). In prod this stays false so upstream certs are verified.
const ALLOW_SELF_SIGNED = process.env.GATEWAY_ALLOW_SELF_SIGNED === 'true';

const meetingCacheClient = getRedisClient({
  cacheKey: 'gateway',
  serviceName: 'gateway',
});

const flushIntervals = new Map();

const startFlushInterval = (meetingId, userId, authToken) => {
  if (flushIntervals.has(meetingId)) {
    return;
  }

  const interval60 = setInterval(() => {
    void flushTranscriptBuffer(meetingId).catch((error) => {
      console.error('[gateway] transcript buffer flush failed', {
        meetingId,
        message: error?.message || 'unknown error',
      });
    });
  }, 60_000);

  const interval30 = setInterval(() => {
    void flushFullTranscriptBuffer({ meetingId, userId, authToken }).catch((error) => {
      console.error('[gateway] full transcript buffer flush failed', {
        meetingId,
        message: error?.message || 'unknown error',
      });
    });
  }, 30_000);

  flushIntervals.set(meetingId, { interval60, interval30 });
};

const flushTranscriptBuffer = async (meetingId) => {
  const redisReady = await ensureRedisReady(meetingCacheClient, 'gateway');
  if (!redisReady) {
    return;
  }

  const buffer = await meetingCacheClient.getDel(`meeting:${meetingId}:transcript_buffer`);
  await meetingCacheClient.del(`meeting:${meetingId}:buffer_ts`);

  const confirmedText = String(buffer || '').trim();
  if (!confirmedText) {
    return;
  }

  await dbQuery(
    `UPDATE meetings
     SET full_transcript = jsonb_set(
       jsonb_set(
         COALESCE(full_transcript, '{}'::jsonb),
         '{text}',
         to_jsonb(
           COALESCE(full_transcript->>'text', '')
           || CASE
             WHEN COALESCE(full_transcript->>'text', '') = '' THEN ''
             ELSE ' '
           END
           || $1::text
         ),
         true
       ),
       '{lastUpdated}',
       to_jsonb($2::text),
       true
     )
     WHERE id = $3`,
    [confirmedText, new Date().toISOString(), meetingId],
  );
};

const flushFullTranscriptBuffer = async ({ meetingId, userId, authToken, isFinal = false }) => {
  const redisReady = await ensureRedisReady(meetingCacheClient, 'gateway');
  if (!redisReady) {
    return;
  }

  const key = `meeting:${meetingId}:full_transcript_buffer`;
  const raw = await meetingCacheClient.get(key);
  if (!raw) {
    return;
  }

  let transcriptState;
  try {
    transcriptState = JSON.parse(raw);
  } catch (error) {
    console.error('[gateway] failed to parse full transcript buffer', { meetingId, error: error.message });
    return;
  }

  if (!transcriptState) {
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      const targetUrl = new URL(`/meetings/${encodeURIComponent(meetingId)}/transcript`, MEETING_SERVICE_URL);
      const client = targetUrl.protocol === 'https:' ? https : http;

      const body = JSON.stringify(transcriptState);
      const proxyReq = client.request(
        targetUrl,
        {
          method: 'POST',
          rejectUnauthorized: !ALLOW_SELF_SIGNED,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: authToken ? `Bearer ${authToken}` : '',
            'x-user-id': String(userId),
          },
        },
        (proxyRes) => {
          proxyRes.resume();
          if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Upstream returned ${proxyRes.statusCode}`));
          }
        },
      );

      proxyReq.on('error', reject);
      proxyReq.write(body);
      proxyReq.end();
    });
  } catch (error) {
    console.error('[gateway] failed to flush full transcript to meeting service', {
      meetingId,
      message: error.message,
    });
  }

  if (isFinal) {
    await meetingCacheClient.del(key);
  }
};

const endMeetingTranscript = async (meetingId, userId, authToken) => {
  const intervals = flushIntervals.get(meetingId);
  if (intervals) {
    if (intervals.interval60) clearInterval(intervals.interval60);
    if (intervals.interval30) clearInterval(intervals.interval30);
    flushIntervals.delete(meetingId);
  }

  await Promise.all([
    flushTranscriptBuffer(meetingId),
    flushFullTranscriptBuffer({ meetingId, userId, authToken, isFinal: true }),
  ]);
};


const app = express();

// 1. Consolidated CORS + Logging Middleware (Must be FIRST)
app.use((req, res, next) => {
  const start = Date.now();
  const { method, path, headers } = req;
  const origin = headers.origin;

  // Set standard CORS headers for ALL responses
  res.setHeader('Access-Control-Allow-Origin', origin || FRONTEND_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Requested-With, Accept, Origin, X-User-Id');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  res.setHeader('Vary', 'Origin');

  // Handle Preflight
  if (method === 'OPTIONS') {
    console.log(`[gateway] OPTIONS ${path} -> 204 (Origin: ${origin})`);
    return res.status(204).end();
  }

  // Intercept response to log completion
  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - start;
    const corsOrigin = res.getHeader('access-control-allow-origin');
    console.log(`[gateway] ${method} ${path} -> ${res.statusCode} (${duration}ms) - Origin: ${origin} - CORS-Set: ${corsOrigin}`);
    return originalSend.apply(res, arguments);
  };

  next();
});

app.use(express.json());

// 2. Global Error Handler (Add at the end, but I'll prepare it here)
const globalErrorHandler = (err, req, res, next) => {
  console.error(`[gateway] Error for ${req.method} ${req.path}:`, err);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ 
      message: err.message || 'Internal Server Error',
      error: process.env.NODE_ENV === 'development' ? err : {}
    });
  }
};


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
        rejectUnauthorized: !ALLOW_SELF_SIGNED,
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
        rejectUnauthorized: !ALLOW_SELF_SIGNED,
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

const normalizeLine = (line, aiSessionId = '') => ({
  speaker: Number.isFinite(Number(line?.speaker)) ? Number(line.speaker) : -1,
  text: String(line?.text || '').trim(),
  start: line?.start ?? null,
  end: line?.end ?? null,
  detected_language: line?.detected_language ?? null,
  aiSessionId: line?.aiSessionId || aiSessionId,
});



const appendUniqueLines = (baseLines, incomingLines) => {
  if (!Array.isArray(incomingLines) || incomingLines.length === 0) {
    return Array.isArray(baseLines) ? baseLines : [];
  }

  const next = Array.isArray(baseLines) ? [...baseLines] : [];
  const baseLineMap = new Map();
  next.forEach((line, index) => {
    if (line.start !== null) {
      const key = `${line.aiSessionId || ''}:${line.start}`;
      baseLineMap.set(key, index);
    }
  });

  incomingLines.forEach((line) => {
    if (line.start !== null) {
      const key = `${line.aiSessionId || ''}:${line.start}`;
      if (baseLineMap.has(key)) {
        next[baseLineMap.get(key)] = line;
      } else {
        next.push(line);
        baseLineMap.set(key, next.length - 1);
      }
    } else {
      next.push(line);
    }
  });

  return next;
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

const areArraysEqual = (left = [], right = []) => {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
};

const normalizeSpeakers = (participants = [], lines = []) => {
  const normalizedParticipants = Array.isArray(participants)
    ? participants.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (normalizedParticipants.length) {
    return normalizedParticipants;
  }

  const seen = new Set();
  const derived = [];
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const raw = line?.speaker;
      if (raw == null) {
        continue;
      }
      const speaker = String(raw).trim();
      if (!speaker || seen.has(speaker)) {
        continue;
      }
      seen.add(speaker);
      derived.push(speaker);
    }
  }

  return derived;
};

const buildSpeakerMapFromList = (speakers = []) => {
  const list = Array.isArray(speakers) ? speakers : [];
  const map = {};
  const limit = Math.min(list.length, MEETING_QA_MAX_SPEAKERS);
  for (let i = 0; i < limit; i += 1) {
    const value = String(list[i] || '').trim();
    if (value) {
      map[`speaker_${i + 1}`] = value;
    }
  }
  return map;
};

const getTranscriptSpeakerCount = (lines = []) => {
  if (!Array.isArray(lines)) {
    return 0;
  }
  const seen = new Set();
  for (const line of lines) {
    const raw = line?.speaker;
    if (raw == null) {
      continue;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric < 0) {
      continue;
    }
    const key = String(raw).trim();
    if (!key) {
      continue;
    }
    seen.add(key);
  }
  return seen.size;
};

const normalizeSpeakerMap = (value = {}) => {
  if (Array.isArray(value)) {
    return buildSpeakerMapFromList(value);
  }
  if (!value || typeof value !== 'object') {
    return {};
  }
  const map = {};
  for (let i = 1; i <= MEETING_QA_MAX_SPEAKERS; i += 1) {
    const key = `speaker_${i}`;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const trimmed = String(value[key] || '').trim();
    if (trimmed) {
      map[key] = trimmed;
    }
  }
  return map;
};

const areSpeakerMapsEqual = (left = {}, right = {}) => {
  const normalizedLeft = normalizeSpeakerMap(left);
  const normalizedRight = normalizeSpeakerMap(right);
  const leftKeys = Object.keys(normalizedLeft);
  const rightKeys = Object.keys(normalizedRight);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (normalizedLeft[key] !== normalizedRight[key]) {
      return false;
    }
  }
  return true;
};

const fillSpeakerMap = (speakerMap = {}, count = 0) => {
  const normalized = normalizeSpeakerMap(speakerMap);
  const limit = Math.min(Math.max(0, count), MEETING_QA_MAX_SPEAKERS);
  const filled = {};
  for (let i = 1; i <= limit; i += 1) {
    const key = `speaker_${i}`;
    filled[key] = normalized[key] || `Speaker ${i}`;
  }
  return filled;
};

const buildSpeakerMap = (participants = [], lines = []) =>
  buildSpeakerMapFromList(normalizeSpeakers(participants, lines));

const computeDurationMs = ({ startTime, endTime }) => {
  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) {
    return 0;
  }

  const endMs = Date.parse(endTime);
  const effectiveEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  return Math.max(0, effectiveEndMs - startMs);
};

const fetchMeetingMetadata = ({ meetingId, userId, authToken }) =>
  new Promise((resolve) => {
    const targetUrl = new URL(`/meetings/${encodeURIComponent(meetingId)}`, MEETING_SERVICE_URL);
    const client = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = client.request(
      targetUrl,
      {
        method: 'GET',
        rejectUnauthorized: !ALLOW_SELF_SIGNED,
        headers: {
          Accept: 'application/json',
          Authorization: authToken ? `Bearer ${authToken}` : '',
          'x-user-id': String(userId),
        },
      },
      (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => {
          data += chunk;
        });
        proxyRes.on('end', () => {
          if (proxyRes.statusCode !== 200) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(data || '{}'));
          } catch (_error) {
            resolve(null);
          }
        });
      },
    );

    proxyReq.on('error', (error) => {
      console.warn('[gateway] meeting metadata fetch failed', error);
      resolve(null);
    });
    proxyReq.end();
  });

const persistMeetingSpeakers = ({ meetingId, userId, authToken, speakers }) =>
  new Promise((resolve) => {
    const targetUrl = new URL(`/meetings/${encodeURIComponent(meetingId)}/speakers`, MEETING_SERVICE_URL);
    const client = targetUrl.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ speakers });

    const proxyReq = client.request(
      targetUrl,
      {
        method: 'PATCH',
        rejectUnauthorized: !ALLOW_SELF_SIGNED,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: authToken ? `Bearer ${authToken}` : '',
          'x-user-id': String(userId),
        },
      },
      (proxyRes) => {
        proxyRes.resume();
        resolve(proxyRes.statusCode === 200);
      },
    );

    proxyReq.on('error', (error) => {
      console.warn('[gateway] failed to persist speakers in meeting-service', error);
      resolve(false);
    });

    proxyReq.write(body);
    proxyReq.end();
  });

const updateMeetingQaCache = async ({
  meetingId,
  userId,
  authToken,
  speakersOverride,
  hasSpeakersOverride = false,
}) => {
  try {
    const redisReady = await ensureRedisReady(meetingCacheClient, 'gateway');
    if (!redisReady) {
      console.warn('[gateway] redis not ready; skipping QA meeting cache');
    }

    const cacheKey = `${MEETING_QA_CACHE_PREFIX}${meetingId}`;
    let existingParsed = null;
    if (redisReady) {
      try {
        const existing = await meetingCacheClient.get(cacheKey);
        if (existing) {
          existingParsed = JSON.parse(existing);
        }
      } catch (error) {
        console.warn('[gateway] failed reading QA cache', error);
      }
    }

    const meeting = await fetchMeetingMetadata({ meetingId, userId, authToken });
    if (!meeting) {
      return null;
    }

    const cachedSpeakers = redisReady ? normalizeSpeakerMap(existingParsed?.speakers) : {};
    const meetingSpeakers = normalizeSpeakerMap(meeting?.speakerMap);
    const speakerMap = hasSpeakersOverride
      ? normalizeSpeakerMap(speakersOverride)
      : Object.keys(cachedSpeakers).length
        ? cachedSpeakers
        : Object.keys(meetingSpeakers).length
          ? meetingSpeakers
          : buildSpeakerMap(meeting.participants, meeting.lines);
    const transcriptCount = getTranscriptSpeakerCount(meeting.lines);
    const speakerCount = Math.min(
      MEETING_QA_MAX_SPEAKERS,
      Math.max(transcriptCount, Object.keys(speakerMap).length),
    );
    const cacheSpeakerMap = fillSpeakerMap(speakerMap, speakerCount);

    const payload = {
      speakers: cacheSpeakerMap,
      duration: computeDurationMs({
        startTime: meeting.startTime,
        endTime: meeting.endTime,
      }),
      updatedAt: Date.now(),
    };

    if (redisReady) {
      let shouldWrite = true;

      try {
        if (existingParsed) {
          if (
            typeof existingParsed?.duration === 'number' &&
            areSpeakerMapsEqual(existingParsed?.speakers, payload.speakers) &&
            existingParsed.duration === payload.duration
          ) {
            shouldWrite = false;
          }
        }
      } catch (error) {
        console.warn('[gateway] failed comparing QA cache', error);
      }

      if (shouldWrite) {
        await meetingCacheClient.set(cacheKey, JSON.stringify(payload), {
          EX: MEETING_QA_CACHE_TTL_SECONDS,
        });
        console.log('[gateway] QA meeting cache set', {
          key: cacheKey,
          ttlSeconds: MEETING_QA_CACHE_TTL_SECONDS,
          payload,
        });
      } else {
        await meetingCacheClient.expire(cacheKey, MEETING_QA_CACHE_TTL_SECONDS);
        console.log('[gateway] QA meeting cache refresh', {
          key: cacheKey,
          ttlSeconds: MEETING_QA_CACHE_TTL_SECONDS,
        });
      }

      try {
        const keys = await meetingCacheClient.keys(`${MEETING_QA_CACHE_PREFIX}*`);
        const allEntries = {};
        for (const k of keys || []) {
          try {
            const raw = await meetingCacheClient.get(k);
            try {
              allEntries[k] = raw ? JSON.parse(raw) : null;
            } catch (_p) {
              allEntries[k] = raw;
            }
          } catch (e) {
            allEntries[k] = null;
          }
        }
        console.log('[gateway] QA meeting cache all entries', allEntries);
      } catch (err) {
        console.warn('[gateway] failed to enumerate QA cache entries', err);
      }
    }
    return payload;
  } catch (error) {
    console.warn('[gateway] failed updating QA meeting cache', error);
  }
  return null;
};

const generateAndPersistMOM = async ({ meetingId, userId, authToken, socket }) => {
  try {
    if (!Number.isInteger(meetingId) || meetingId <= 0) {
      throw new Error(`Invalid meetingId for MOM generation: ${meetingId}`);
    }
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error(`Invalid userId for MOM generation: ${userId}`);
    }
    if (socket) {
      socket.emit('meeting-summary-loading', { meetingId });
    }

    let speakerMap = null;
    const redisReady = await ensureRedisReady(meetingCacheClient, 'gateway');
    if (redisReady) {
      const cacheKey = `${MEETING_QA_CACHE_PREFIX}${meetingId}`;
      const existing = await meetingCacheClient.get(cacheKey);
      if (existing) {
        const existingParsed = JSON.parse(existing);
        speakerMap = normalizeSpeakerMap(existingParsed?.speakers);
      }
    }

    if (!Object.keys(speakerMap || {}).length) {
      const payload = await updateMeetingQaCache({
        meetingId,
        userId,
        authToken,
      });
      speakerMap = normalizeSpeakerMap(payload?.speakers);
    }

    const payload = {
      meeting_id: meetingId,
      user_id: userId,
      speaker_map: speakerMap,
    };

    console.log('[gateway] generating MOM with payload', payload);

    const aiRes = await fetch(`${QA_SERVICE_URL}/mom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!aiRes.ok) {
      const responseText = await aiRes.text().catch(() => '');
      throw new Error(`QA service returned ${aiRes.status}: ${responseText || 'empty response'}`);
    }

    const { answer } = await aiRes.json();
    if (!answer) {
      if (socket) {
        socket.emit('meeting-summary-ready', { meetingId, summary: null });
      }
      return;
    }

    const msRes = await fetch(`${MEETING_SERVICE_URL}/meetings/${meetingId}/summary`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authToken ? `Bearer ${authToken}` : '',
        'x-user-id': String(userId),
      },
      body: JSON.stringify({ summary: answer }),
    });

    if (!msRes.ok) {
      throw new Error(`Meeting service returned ${msRes.status}`);
    }

    console.log(`[gateway] MOM generated and saved for meeting ${meetingId}`);
    if (socket) {
      socket.emit('meeting-summary-ready', { meetingId, summary: answer });
    }
  } catch (error) {
    console.error(`[gateway] Failed to generate/persist MOM for meeting ${meetingId}:`, error);
    if (socket) {
      socket.emit('meeting-summary-error', {
        meetingId,
        message: error?.message || 'Failed to generate summary.',
      });
    }
  }
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

  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  Object.assign(headers, extraHeaders);
  // Ensure Cookie is forwarded if not already in req.headers
  if (req.headers.cookie) headers.Cookie = req.headers.cookie;

  if (hasBody) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      rejectUnauthorized: !ALLOW_SELF_SIGNED,
      headers,
    },
    (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        if (proxyRes.headers['set-cookie']) {
          res.set('set-cookie', proxyRes.headers['set-cookie']);
        }
        if (proxyRes.headers.location) {
          res.set('location', proxyRes.headers.location);
        }
        res
          .status(proxyRes.statusCode || 200)
          .set('content-type', proxyRes.headers['content-type'] || 'application/json')
          .send(responseBody);
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

  const unauthorized = (reason = 'Unauthorized') => {
    console.warn(`[gateway] access denied: ${reason} for ${req.method} ${req.path}`);
    res.status(401).json({ message: 'Unauthorized' });
  };

  const refreshSession = () => {
    console.log(`[gateway] attempting session refresh for ${req.method} ${req.path}`);
    const refreshClient = refreshUrl.protocol === 'https:' ? https : http;
    const refreshReq = refreshClient.request(
      refreshUrl,
      {
        method: 'POST',
        rejectUnauthorized: !ALLOW_SELF_SIGNED,
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
            console.warn(`[gateway] session refresh failed with status ${refreshRes.statusCode}`);
            return unauthorized();
          }

          try {
            const parsed = JSON.parse(refreshData || '{}');
            const newAccessToken =
              getCookieFromSetCookie(refreshRes.headers['set-cookie'], 'meetai_access') || '';
            const user = parsed?.user || null;
            if (!newAccessToken || !user) {
              console.warn('[gateway] session refresh missing token or user');
              return unauthorized();
            }
            console.log(`[gateway] session refreshed for user ${user.id}`);
            return applyVerifiedSession({
              user,
              accessToken: newAccessToken,
              setCookieHeader: refreshRes.headers['set-cookie'],
            });
          } catch (error) {
            console.error('[gateway] session refresh parse error', error);
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
      rejectUnauthorized: !ALLOW_SELF_SIGNED,
      headers: (() => {
        const h = { ...req.headers };
        delete h.host;
        h.Authorization = authHeader;
        h.Cookie = req.headers.cookie || '';
        h['Content-Length'] = '0';
        return h;
      })(),
    },
    (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        if (proxyRes.statusCode !== 200) {
          console.log(`[gateway] verify failed with status ${proxyRes.statusCode}; refreshing...`);
          return refreshSession();
        }

        const data = Buffer.concat(chunks).toString();
        let verifiedUser = null;
        try {
          const parsed = JSON.parse(data || '{}');
          verifiedUser = parsed?.user || null;
        } catch (_error) {
          verifiedUser = null;
        }

        if (!verifiedUser) {
          console.warn('[gateway] verify returned OK but no user found');
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

  const clientAccept = String(req.headers['accept'] || '').toLowerCase();
  const wantsSse =
    clientAccept.includes('text/event-stream') ||
    (req.body && req.body.mode === 'qa');

  const headers = { ...req.headers };
  delete headers.host;
  delete headers['origin'];
  delete headers['referer'];
  
  headers.Accept = wantsSse ? 'text/event-stream' : 'application/json';
  headers.Authorization = req.authToken ? `Bearer ${req.authToken}` : (req.headers.authorization || '');
  headers['x-user-id'] = req.authUser?.id ? String(req.authUser.id) : '';

  // Prepare the payload if express.json() already parsed it
  let bodyData = null;
  if ((method === 'POST' || method === 'PATCH') && req.body && Object.keys(req.body).length > 0) {
    bodyData = JSON.stringify(req.body);
    headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    headers['Content-Length'] = Buffer.byteLength(bodyData);
  } else if (method === 'PATCH' || method === 'POST') {
    // Force 0 length if no body is present to prevent cloud proxy hangups
    headers['Content-Length'] = '0';
  }

  const proxyReq = client.request(
    targetUrl,
    { method, headers, rejectUnauthorized: !ALLOW_SELF_SIGNED },
    (proxyRes) => {
      const upstreamType = String(proxyRes.headers['content-type'] || 'application/json');
      const isStream = upstreamType.toLowerCase().includes('text/event-stream');

      if (isStream) {
        res.status(proxyRes.statusCode || 200);
        res.setHeader('Content-Type', upstreamType);
        res.setHeader('Cache-Control', proxyRes.headers['cache-control'] || 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }

        proxyRes.on('data', (chunk) => {
          res.write(chunk);
        });
        
        proxyRes.on('end', () => {
          if (!res.writableEnded) res.end();
        });

        return;
      }

      // Buffered JSON path
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        res
          .status(proxyRes.statusCode || 200)
          .set('content-type', upstreamType)
          .send(responseBody);
      });
    },
  );

  proxyReq.on('error', (error) => {
    console.error('[gateway] meeting service proxy error', error);
    if (!res.headersSent) {
      res.status(502).json({ message: 'Meeting service unavailable.', error: error.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  // If a parsed body payload exists, write it out completely
  if (bodyData) {
    proxyReq.write(bodyData);
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
    'x-auth-provider': req.authUser?.authProvider ? String(req.authUser.authProvider) : '',
  }),
);
app.get('/auth/google/callback', (req, res) => proxyAuth(req.originalUrl, req, res));

app.use(verifyAccess); // verification required for all routes below

app.get('/calendar/status', (req, res) => {
  console.log('[gateway] /calendar/status req.query:', JSON.stringify(req.query));
  const params = new URLSearchParams(req.query || {});
  const queryString = params.toString();
  console.log('[gateway] /calendar/status queryString:', queryString);
  const targetPath = queryString ? `/calendar/status?${queryString}` : '/calendar/status';
  const targetUrl = new URL(targetPath, AUTH_SERVICE_URL);
  console.log('[gateway] /calendar/status targetUrl:', targetUrl.toString());
  const client = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = client.request(
    targetUrl,
    {
      method: 'GET',
      rejectUnauthorized: !ALLOW_SELF_SIGNED,
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
      rejectUnauthorized: !ALLOW_SELF_SIGNED,
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
      rejectUnauthorized: !ALLOW_SELF_SIGNED,
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

app.post('/meetings/:meetingId/messages', async (req, res) => {
  if (req.body?.mode === 'qa') {
    const meetingId = Number(req.params.meetingId);
    const userId = Number(req.authUser?.id);
    if (Number.isFinite(meetingId) && meetingId > 0 && Number.isFinite(userId) && userId > 0) {
      const payload = await updateMeetingQaCache({
        meetingId,
        userId,
        authToken: req.authToken,
      });
      const speakerMap = payload?.speakers ?? normalizeSpeakerMap(req.body?.speaker_map);
      req.body.speaker_map = speakerMap;

      const durationSeconds =
        typeof payload?.duration === 'number'
          ? payload.duration / 1000
          : Number(req.body?.current_duration);
      if (Number.isFinite(durationSeconds)) {
        req.body.current_duration = durationSeconds;
      }
    }
  }

  return proxyMeetingService(
    'POST',
    `/meetings/${encodeURIComponent(req.params.meetingId)}/messages`,
    req,
    res,
  );
});

app.post('/meetings/:meetingId/qa-cache', async (req, res) => {
  const meetingId = Number(req.params.meetingId);
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  const userId = Number(req.authUser?.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }

  const speakers = normalizeSpeakerMap(req.body?.speakers);
  await persistMeetingSpeakers({
    meetingId,
    userId,
    authToken: req.authToken,
    speakers,
  });

  const payload = await updateMeetingQaCache({
    meetingId,
    userId,
    authToken: req.authToken,
    speakersOverride: speakers,
    hasSpeakersOverride: true,
  });

  if (!payload) {
    return res.status(404).json({ message: 'Meeting not found.' });
  }

  return res.json({ ok: true, payload });
});

app.post('/meetings/:meetingId/transcript', (req, res) => {
  return proxyMeetingService(
    'POST',
    `/meetings/${encodeURIComponent(req.params.meetingId)}/transcript`,
    req,
    res
  );
});
app.patch('/meetings/:meetingId/summary', (req, res) =>
  proxyMeetingService('PATCH', `/meetings/${encodeURIComponent(req.params.meetingId)}/summary`, req, res),
);

app.post('/meetings/:meetingId/complete', (req, res) =>
  proxyMeetingService('POST', `/meetings/${encodeURIComponent(req.params.meetingId)}/complete`, req, res),
);

app.post('/meetings/:meetingId/title', (req, res) =>
  proxyMeetingService('POST', `/meetings/${encodeURIComponent(req.params.meetingId)}/title`, req, res),
);

app.delete('/meetings/:meetingId', (req, res) =>
  proxyMeetingService('DELETE', `/meetings/${encodeURIComponent(req.params.meetingId)}`, req, res),
);

// ---------------------------------------------------------------------------
// Socket.io — bridge browser PCM stream to AI websocket service
// ---------------------------------------------------------------------------

let server;
if (useHttps) {
  server = https.createServer(
    {
      key: fs.readFileSync('0.0.0.0-key.pem'),
      cert: fs.readFileSync('0.0.0.0.pem'),
    },
    app
  );
} else {
  server = http.createServer(app);
}

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

  // State for structured transcript accumulation (session-scoped)
  let cumulativeLines = [];
  let segmentLines = [];

  const userId = Number(socket.data.authUser?.id);
  const authToken = String(socket.data.authToken || '');

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
    cumulativeLines = [];
    segmentLines = [];

    startFlushInterval(meetingId, userId, authToken);

    ws.on('open', () => {
      console.log('[gateway] connected to ai service', { socketId: socket.id, meetingId, wsUrl });
    });

    ws.on('message', async (raw) => {
      const textPayload = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw || '');

      let parsed;
      try {
        parsed = JSON.parse(textPayload || '{}');
      } catch (_error) {
        socket.emit('meeting-session-error', { message: 'Received malformed AI payload.' });
        return;
      }

      try {
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
          
          if (Array.isArray(parsed?.lines) && parsed.lines.length > 0) {
            const incomingLines = parsed.lines
              .map((line) => normalizeLine(line, parsed?.session_id || ''))
              .filter((line) => line.text);
            cumulativeLines = appendUniqueLines(cumulativeLines, incomingLines);
            segmentLines = incomingLines;
            const transcriptState = {
              aiSessionId: String(parsed?.session_id || ''),
              asrStatus: String(parsed?.status || 'stopped'),
              lines: cumulativeLines,
              bufferTranscription: String(parsed?.buffer_transcription || ''),
              bufferDiarization: String(parsed?.buffer_diarization || ''),
              updatedAt: new Date().toISOString(),
            };
            const redisReady = await ensureRedisReady(meetingCacheClient, 'gateway');
            if (redisReady) {
              await meetingCacheClient.set(
                `meeting:${meetingId}:full_transcript_buffer`,
                JSON.stringify(transcriptState),
                'EX',
                7200,
              );
            }
          }
          
          emitSessionEnded();
          try {
            await endMeetingTranscript(meetingId, userId, authToken);
          } catch (error) {
            console.error('[gateway] transcript buffer final flush failed', {
              meetingId,
              message: error?.message || 'unknown error',
            });
          }
          cleanupAiSocket();
          aiSocket = null;
          activeMeetingId = null;
          lastLoggedTranscript = '';

          generateAndPersistMOM({ meetingId, userId, authToken, socket })
            .catch((err) => console.error('[gateway] MOM generation failed', err));
          return;
        }

        const incomingLines = (Array.isArray(parsed?.lines) ? parsed.lines : [])
          .map((line) => normalizeLine(line, parsed?.session_id || ''))
          .filter((line) => line.text);

        const mergedLines = appendUniqueLines(cumulativeLines, incomingLines);
        cumulativeLines = mergedLines;
        segmentLines = incomingLines;

        const transcriptState = {
          aiSessionId: String(parsed?.session_id || ''),
          asrStatus: String(parsed?.status || 'active_transcription'),
          lines: mergedLines,
          bufferTranscription: String(parsed?.buffer_transcription || ''),
          bufferDiarization: String(parsed?.buffer_diarization || ''),
          updatedAt: new Date().toISOString(),
        };

        const redisReady = await ensureRedisReady(meetingCacheClient, 'gateway');
        if (redisReady) {
          await meetingCacheClient.set(
            `meeting:${meetingId}:full_transcript_buffer`,
            JSON.stringify(transcriptState),
            'EX',
            7200,
          );
        }

        // Only append lines that are "new" (i.e. start after the end of the previous segmentLines array)
        // Or simply slice based on length difference if they are append-only.
        // Actually, since TokenAlignment updates existing segments, we should be careful.
        // The safest way is to use segmentLines length as a heuristic for what was already processed.
        const linesToAppend = incomingLines.slice(segmentLines.length);
        segmentLines = incomingLines;
        const confirmedText = linesToAppend.map((line) => line.text).join(' ');

        if (confirmedText && redisReady) {
          await meetingCacheClient.append(`meeting:${meetingId}:transcript_buffer`, ` ${confirmedText}`);
          await meetingCacheClient.setNX(`meeting:${meetingId}:buffer_ts`, String(Date.now()));
          await meetingCacheClient.expire(`meeting:${meetingId}:transcript_buffer`, 7200);
          await meetingCacheClient.expire(`meeting:${meetingId}:buffer_ts`, 7200);
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
      } catch (error) {
        console.error('[gateway] failed to handle ai payload', {
          meetingId,
          message: error?.message || 'unknown error',
        });
      }
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
      void endMeetingTranscript(meetingId, userId, authToken).catch((error) => {
        console.error('[gateway] transcript buffer final flush failed', {
          meetingId,
          message: error?.message || 'unknown error',
        });
      }).finally(() => {
        cleanupAiSocket();
        aiSocket = null;
        activeMeetingId = null;
        lastLoggedTranscript = '';
      });
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
      const meetingId = activeMeetingId;
      if (!meetingId) {
        cleanupAiSocket();
        emitSessionEnded();
        aiSocket = null;
        activeMeetingId = null;
        lastLoggedTranscript = '';
        return;
      }

      void endMeetingTranscript(meetingId, userId, authToken).catch((error) => {
        console.error('[gateway] transcript buffer final flush failed', {
          meetingId,
          message: error?.message || 'unknown error',
        });
      }).finally(() => {
        cleanupAiSocket();
        emitSessionEnded();
        aiSocket = null;
        activeMeetingId = null;
        lastLoggedTranscript = '';
      });
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
    const meetingId = activeMeetingId;
    if (!meetingId) {
      cleanupAiSocket();
      aiSocket = null;
      activeMeetingId = null;
      lastLoggedTranscript = '';
      return;
    }

    void endMeetingTranscript(meetingId, userId, authToken).catch((error) => {
      console.error('[gateway] transcript buffer final flush failed', {
        meetingId,
        message: error?.message || 'unknown error',
      });
    }).finally(() => {
      cleanupAiSocket();
      aiSocket = null;
      activeMeetingId = null;
      lastLoggedTranscript = '';
    });
  });
});

app.use(globalErrorHandler);

server.listen(PORT, () => {
  const protocol = useHttps ? 'HTTPS' : 'HTTP';
  // eslint-disable-next-line no-console
  console.log(`${protocol} Gateway listening on ${PORT} (hosted on ${os.hostname()})`);
});

installShutdown(server, { redis: meetingCacheClient });
