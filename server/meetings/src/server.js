const http = require('http');
const express = require('express');
const cors = require('cors');
const os = require('os');
const { requireNumberEnv } = require('@meetai/shared/env');
const { query, pool } = require('@meetai/shared/db');
const { installShutdown } = require('@meetai/shared/shutdown');
const { MEETING_QA_MAX_SPEAKERS } = require('@meetai/shared/constants');

const PORT = requireNumberEnv('PORT');
// QA service URL — host machine in dev (CHECKPOINT1 runs natively on macOS),
// container DNS later when this is moved into compose. Defaults to the
// Docker-for-Mac host bridge so containerised meeting-service can reach the
// CHECKPOINT1 process the user runs in a host shell.
const QA_SERVICE_URL = (process.env.QA_SERVICE_URL || 'http://ai-gateway:8000').replace(/\/+$/, '');
const MAX_SPEAKER_COUNT = MEETING_QA_MAX_SPEAKERS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Transcript cleaning helpers — ported from PreviousMeetings.jsx so that what
// gets stored in the DB matches exactly what the frontend renders.
// ---------------------------------------------------------------------------

const normalizeTranscriptText = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const mergeTranscriptText = (baseText, nextText) => {
  const base = normalizeTranscriptText(baseText);
  const next = normalizeTranscriptText(nextText);

  if (!base) return next;
  if (!next) return base;
  if (base === next) return base;
  if (next.startsWith(base)) return next;
  if (base.startsWith(next)) return base;

  const baseWords = base.split(' ');
  const nextWords = next.split(' ');
  const maxOverlap = Math.min(baseWords.length, nextWords.length);
  let overlap = 0;

  for (let i = 1; i <= maxOverlap; i += 1) {
    const baseSlice = baseWords.slice(baseWords.length - i).join(' ');
    const nextSlice = nextWords.slice(0, i).join(' ');
    if (baseSlice === nextSlice) {
      overlap = i;
    }
  }

  if (overlap) {
    return baseWords.concat(nextWords.slice(overlap)).join(' ');
  }

  return `${base} ${next}`.trim();
};

const trimTranscriptContinuation = (previousText, nextText) => {
  const base = normalizeTranscriptText(previousText);
  const next = normalizeTranscriptText(nextText);

  if (!next) return '';
  if (!base) return next;
  if (next === base) return '';
  if (base.startsWith(next)) return '';
  if (next.startsWith(base)) {
    return next.slice(base.length).trimStart();
  }

  const baseWords = base.split(' ');
  const nextWords = next.split(' ');
  const maxOverlap = Math.min(baseWords.length, nextWords.length);
  let overlap = 0;

  for (let i = 1; i <= maxOverlap; i += 1) {
    const baseSlice = baseWords.slice(baseWords.length - i).join(' ');
    const nextSlice = nextWords.slice(0, i).join(' ');
    if (baseSlice === nextSlice) {
      overlap = i;
    }
  }

  if (overlap) {
    return nextWords.slice(overlap).join(' ').trim();
  }

  return next;
};

const normalizeSpeakerMap = (value = {}) => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const map = {};
  for (let i = 1; i <= MAX_SPEAKER_COUNT; i += 1) {
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
  const limit = Math.min(list.length, MAX_SPEAKER_COUNT);
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

const fillSpeakerMap = (speakerMap = {}, count = 0) => {
  const normalized = normalizeSpeakerMap(speakerMap);
  const limit = Math.min(Math.max(0, count), MAX_SPEAKER_COUNT);
  const filled = {};
  for (let i = 1; i <= limit; i += 1) {
    const key = `speaker_${i}`;
    filled[key] = normalized[key] || `Speaker ${i}`;
  }
  return filled;
};

const buildSpeakerMap = (participants = [], lines = []) =>
  buildSpeakerMapFromList(normalizeSpeakers(participants, lines));

const computeDurationSeconds = ({ startTime, endTime }) => {
  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) {
    return 0;
  }

  const endMs = Date.parse(endTime);
  const effectiveEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  return Math.max(0, (effectiveEndMs - startMs) / 1000);
};

const fetchMeetingQaContext = async ({ meetingId, userId }) => {
  const result = await query(
    `SELECT
      COALESCE(full_transcript->'speakerMap', '{}'::jsonb) AS speaker_map,
      COALESCE(full_transcript->'participants', '[]'::jsonb) AS participants,
      COALESCE(full_transcript->'lines', '[]'::jsonb) AS lines,
      start_time,
      end_time
    FROM meetings
    WHERE id = $1 AND user_id = $2
    LIMIT 1`,
    [meetingId, userId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    speakerMap: row.speaker_map,
    participants: row.participants,
    lines: row.lines,
    startTime: row.start_time,
    endTime: row.end_time,
  };
};

/**
 * Deduplicate and merge raw transcript lines exactly as the frontend does.
 *
 * Input:  raw `lines` array from the AI worker (may have overlapping text,
 *         duplicate chunks, or multiple entries for the same utterance).
 * Output: a clean array of `{ speaker, text, start, end }` objects — one
 *         object per speaker-turn, with all duplicate text removed.
 *
 * The algorithm mirrors `transcriptState` in PreviousMeetings.jsx:
 *   1. Sort by `end` time (realtime order used during active recording).
 *   2. For each line, trim the portion already seen for that speaker.
 *   3. Merge lines that share the same speaker+start key into one group.
 *   4. Extend the previous group if the same speaker continues.
 */
const cleanTranscriptLines = (rawLines, { isRealtime = false } = {}) => {
  if (!Array.isArray(rawLines) || !rawLines.length) return [];

  const lines = rawLines.slice().sort((a, b) => {
    const aVal = isRealtime ? (a?.end ?? a?.start) : (a?.start ?? a?.end);
    const bVal = isRealtime ? (b?.end ?? b?.start) : (b?.start ?? b?.end);
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    return Number(aVal) - Number(bVal);
  });

  const groups = [];
  const lastTextBySpeaker = new Map();
  const groupKeyMap = new Map();

  lines.forEach((line) => {
    const speakerValue = Number.isFinite(Number(line?.speaker))
      ? Number(line.speaker)
      : line?.speaker ?? null;
    const text = normalizeTranscriptText(line?.text);
    const lineStart = line?.start ?? null;
    const lineEnd = line?.end ?? null;
    const previousText = lastTextBySpeaker.get(speakerValue) || '';
    const trimmedText = trimTranscriptContinuation(previousText, text);

    if (!trimmedText) {
      if (text) {
        lastTextBySpeaker.set(speakerValue, mergeTranscriptText(previousText, text));
      }
      return;
    }

    const segmentKey = lineStart != null ? `${speakerValue}:${lineStart}` : null;
    const existingIdx = segmentKey != null ? groupKeyMap.get(segmentKey) : undefined;

    if (existingIdx !== undefined) {
      const existing = groups[existingIdx];
      existing.text = mergeTranscriptText(existing.text, trimmedText);
      if (lineEnd != null) existing.end = lineEnd;
    } else {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.speaker === speakerValue) {
        lastGroup.text = mergeTranscriptText(lastGroup.text, trimmedText);
        if (lastGroup.start == null && lineStart != null) lastGroup.start = lineStart;
        if (lineEnd != null) lastGroup.end = lineEnd;
        if (segmentKey != null) groupKeyMap.set(segmentKey, groups.length - 1);
      } else {
        const newIdx = groups.length;
        groups.push({ speaker: speakerValue, text: trimmedText, start: lineStart, end: lineEnd });
        if (segmentKey != null) groupKeyMap.set(segmentKey, newIdx);
      }
    }

    if (text) {
      lastTextBySpeaker.set(speakerValue, mergeTranscriptText(previousText, text));
    }
  });

  return groups;
};

// ---------------------------------------------------------------------------

const fetchWithRetry = async (url, options, { attempts = 3, baseDelayMs = 250 } = {}) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error('Aborted');
    }
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      const remaining = attempts - attempt - 1;
      if (remaining <= 0) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[meeting-service] qa: upstream fetch failed, retrying in ${delay}ms (${remaining} left)`,
        error,
      );
      await sleep(delay);
    }
  }
  throw lastError || new Error('fetch failed');
};

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const requireUserId = (req, res) => {
  const userId = Number(req.headers['x-user-id']);
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }
  return userId;
};

app.post('/meetings', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const startedAt = new Date();
  const title = String(req.body?.title || '').trim() || `Meeting ${startedAt.toLocaleString()}`;
  const participants = Array.isArray(req.body?.participants) ? req.body.participants : [];
  const speakerMap = normalizeSpeakerMap(req.body?.speakerMap);

  const transcript = {
    title,
    durationMinutes: 0,
    participants,
    speakerMap,
    actionItems: [],
    messages: [],
    asrStatus: 'idle',
    lines: [],
    bufferTranscription: '',
    bufferDiarization: '',
    updatedAt: startedAt.toISOString(),
  };

  return query(
    `INSERT INTO meetings (user_id, summarisation, full_transcript, date, start_time, duration_minutes)
     VALUES ($1, $2, $3::jsonb, $4, $5, 0)
     RETURNING id, start_time`,
    [userId, '', JSON.stringify(transcript), startedAt, startedAt],
  )
    .then((result) => {
      const row = result.rows[0];
      return res.status(201).json({
        id: row.id,
        startTime: row.start_time,
      });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to create meeting', error);
      return res.status(500).json({ message: 'Failed to create meeting.' });
    });
});

app.get('/meetings/dummy', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const rawFilter = String(req.query.filter || 'previous').trim().toLowerCase();
  const filter = ['upcoming', 'previous', 'all'].includes(rawFilter) ? rawFilter : null;
  if (!filter) {
    return res.status(400).json({ message: "filter must be one of: 'upcoming', 'previous', 'all'." });
  }

  const parseDateInput = (value, label) => {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return null;
    }

    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
      const error = new Error(`Invalid ${label}. Use an ISO-8601 date or timestamp.`);
      error.statusCode = 400;
      throw error;
    }

    return parsed;
  };

  let fromDate;
  let toDate;
  try {
    fromDate = parseDateInput(req.query.from, 'from');
    toDate = parseDateInput(req.query.to, 'to');
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Invalid date range.' });
  }

  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    return res.status(400).json({ message: 'from must be less than or equal to to.' });
  }

  const rawLimit = Number(req.query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 25;

  const whereClauses = ['user_id = $1'];
  const values = [userId];
  let nextParamIndex = 2;

  if (filter === 'upcoming') {
    whereClauses.push('COALESCE(start_time, date) >= NOW()');
  }

  if (filter === 'previous') {
    whereClauses.push('COALESCE(end_time, start_time, date) < NOW()');
  }

  if (fromDate) {
    whereClauses.push(`COALESCE(start_time, date) >= $${nextParamIndex}`);
    values.push(fromDate.toISOString());
    nextParamIndex += 1;
  }

  if (toDate) {
    whereClauses.push(`COALESCE(start_time, date) <= $${nextParamIndex}`);
    values.push(toDate.toISOString());
    nextParamIndex += 1;
  }

  const orderDirection = filter === 'upcoming' ? 'ASC' : 'DESC';
  values.push(limit);

  return query(
    `SELECT
      id,
      COALESCE(full_transcript->>'title', CONCAT('Meeting ', id::text)) AS title,
      TO_CHAR(COALESCE(start_time, date), 'Mon DD, YYYY') AS date,
      COALESCE(summarisation, '') AS summary,
      COALESCE(full_transcript->'participants', '[]'::jsonb) AS participants,
      COALESCE(full_transcript->'speakerMap', '{}'::jsonb) AS speaker_map,
      COALESCE(full_transcript->'messages', '[]'::jsonb) AS messages,
      COALESCE(full_transcript->'lines', '[]'::jsonb) AS lines,
      COALESCE(full_transcript->>'bufferTranscription', '') AS buffer_transcription,
      COALESCE(full_transcript->>'bufferDiarization', '') AS buffer_diarization,
      COALESCE(full_transcript->>'asrStatus', 'idle') AS asr_status,
      COALESCE(full_transcript->>'updatedAt', '') AS updated_at,
      start_time,
      end_time
    FROM meetings
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY COALESCE(start_time, date) ${orderDirection}
    LIMIT $${nextParamIndex}`,
    values,
  )
    .then((result) => {
      const meetings = result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        date: row.date,
        summary: row.summary,
        participants: Array.isArray(row.participants) ? row.participants : [],
        speakerMap: row.speaker_map && typeof row.speaker_map === 'object' ? row.speaker_map : {},
        messages: Array.isArray(row.messages) ? row.messages : [],
        lines: Array.isArray(row.lines) ? row.lines : [],
        bufferTranscription: String(row.buffer_transcription || ''),
        bufferDiarization: String(row.buffer_diarization || ''),
        asrStatus: String(row.asr_status || 'idle'),
        updatedAt: String(row.updated_at || ''),
        startTime: row.start_time,
        endTime: row.end_time,
      }));
      return res.json(meetings);
    })
    .catch((error) => {
      console.error('[meeting-service] failed to load meetings', error);
      return res.status(500).json({ message: 'Failed to load meetings.' });
    });
});

app.get('/meetings/recent', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 25) : 3;

  return query(
    `SELECT
      id,
      COALESCE(full_transcript->>'title', CONCAT('Meeting ', id::text)) AS title,
      TO_CHAR(COALESCE(end_time, date), 'Mon DD, YYYY') AS date,
      COALESCE(summarisation, '') AS summary,
      COALESCE(full_transcript->'participants', '[]'::jsonb) AS participants,
      COALESCE(full_transcript->'speakerMap', '{}'::jsonb) AS speaker_map,
      COALESCE(duration_minutes, 0) AS duration_minutes,
      start_time,
      end_time
    FROM meetings
    WHERE user_id = $1
    ORDER BY COALESCE(end_time, date) DESC
    LIMIT $2`,
    [userId, limit],
  )
    .then((result) => {
      const meetings = result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        date: row.date,
        summary: row.summary,
        participants: Array.isArray(row.participants) ? row.participants : [],
        speakerMap: row.speaker_map && typeof row.speaker_map === 'object' ? row.speaker_map : {},
        durationMinutes: Number(row.duration_minutes) || 0,
        startTime: row.start_time,
        endTime: row.end_time,
      }));

      return res.json(meetings);
    })
    .catch((error) => {
      console.error('[meeting-service] failed to load recent meetings', error);
      return res.status(500).json({ message: 'Failed to load recent meetings.' });
    });
});

app.get('/meetings/:meetingId', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const meetingId = Number(req.params.meetingId);
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  return query(
    `SELECT
      id,
      COALESCE(full_transcript->>'title', CONCAT('Meeting ', id::text)) AS title,
      TO_CHAR(COALESCE(end_time, date), 'Mon DD, YYYY') AS date,
      COALESCE(summarisation, '') AS summary,
      COALESCE(full_transcript->'participants', '[]'::jsonb) AS participants,
      COALESCE(full_transcript->'speakerMap', '{}'::jsonb) AS speaker_map,
      COALESCE(full_transcript->'messages', '[]'::jsonb) AS messages,
      COALESCE(full_transcript->'actionItems', '[]'::jsonb) AS action_items,
      COALESCE(full_transcript->'lines', '[]'::jsonb) AS lines,
      COALESCE(full_transcript->>'bufferTranscription', '') AS buffer_transcription,
      COALESCE(full_transcript->>'bufferDiarization', '') AS buffer_diarization,
      COALESCE(full_transcript->>'asrStatus', 'idle') AS asr_status,
      COALESCE(full_transcript->>'updatedAt', '') AS updated_at,
      COALESCE(duration_minutes, 0) AS duration_minutes,
      start_time,
      end_time
    FROM meetings
    WHERE id = $1 AND user_id = $2
    LIMIT 1`,
    [meetingId, userId],
  )
    .then((result) => {
      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }

      return res.json({
        id: row.id,
        title: row.title,
        date: row.date,
        summary: row.summary,
        participants: Array.isArray(row.participants) ? row.participants : [],
        speakerMap: row.speaker_map && typeof row.speaker_map === 'object' ? row.speaker_map : {},
        messages: Array.isArray(row.messages) ? row.messages : [],
        actionItems: Array.isArray(row.action_items) ? row.action_items : [],
        lines: Array.isArray(row.lines) ? row.lines : [],
        bufferTranscription: String(row.buffer_transcription || ''),
        bufferDiarization: String(row.buffer_diarization || ''),
        asrStatus: String(row.asr_status || 'idle'),
        updatedAt: String(row.updated_at || ''),
        durationMinutes: Number(row.duration_minutes) || 0,
        startTime: row.start_time,
        endTime: row.end_time,
      });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to load meeting by id', error);
      return res.status(500).json({ message: 'Failed to load meeting.' });
    });
});
// Append one message to a meeting's transcript.
//
// Two modes share this endpoint:
//   - default (mode !== 'qa'): just persist the message and return JSON. This
//     is the chat-bubble flow that already existed.
//   - mode === 'qa': persist the user's question, then proxy an SSE stream
//     from the QA service back to the browser, writing the assistant's
//     answer to the DB once the stream's done event arrives. The browser
//     gets a text/event-stream response so it can render tokens as they
//     arrive instead of waiting for the full answer.
app.post('/meetings/:meetingId/messages', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const meetingId = Number(req.params.meetingId);
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  const text = String(req.body?.content || '').trim();
  if (!text) {
    return res.status(400).json({ message: 'Message content is required.' });
  }
  if (req.body?.mode === 'qa') {
    return handleQaMessage({ req, res, meetingId, userId, question: text });
  }
  const role = req.body?.role === 'assistant' ? 'assistant' : 'user';
  const message = {
    id: `msg-${Date.now()}`,
    role,
    text,
    time: new Date().toISOString(),
  };

  return query(
    `UPDATE meetings
     SET full_transcript = jsonb_set(
       COALESCE(full_transcript, '{}'::jsonb),
       '{messages}',
       COALESCE(full_transcript->'messages', '[]'::jsonb) || $1::jsonb,
       true
     )
     WHERE id = $2 AND user_id = $3
     RETURNING id`,
    [JSON.stringify([message]), meetingId, userId],
  )
    .then((result) => {
      if (!result.rowCount) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }
      return res.status(201).json({ message });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to append meeting message', error);
      return res.status(500).json({ message: 'Failed to save message.' });
    });
});
// Append one message to a meeting's transcript — single helper used by both
// the user-question path and the assistant-answer path of the QA flow.
const appendMeetingMessage = async ({ meetingId, userId, role, text }) => {
  const message = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    time: new Date().toISOString(),
  };
  const result = await query(
    `UPDATE meetings
     SET full_transcript = jsonb_set(
       COALESCE(full_transcript, '{}'::jsonb),
       '{messages}',
       COALESCE(full_transcript->'messages', '[]'::jsonb) || $1::jsonb,
       true
     )
     WHERE id = $2 AND user_id = $3
     RETURNING id`,
    [JSON.stringify([message]), meetingId, userId],
  );
  if (!result.rowCount) {
    const error = new Error('Meeting not found.');
    error.statusCode = 404;
    throw error;
  }
  return message;
};

// Render a single SSE event into the wire format. We re-emit ``meta``,
// ``delta``, ``done`` and ``error`` events from the QA service into the
// outgoing stream, plus one extra ``saved`` event after we've persisted the
// assistant message so the browser can swap its in-memory bubble for the
// canonical DB row.
const writeSseEvent = (res, name, payload) => {
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

// Handle the QA path of POST /meetings/:meetingId/messages.
//
// 1) Persist the user's question into ``full_transcript.messages``.
// 2) Open POST QA_SERVICE_URL/qa and pipe its SSE response through to the
//    browser, parsing each event so we can intercept ``done`` and persist
//    the final assistant answer into the same JSONB array.
// 3) Always emit a final ``saved`` SSE event with the assistant message id
//    (or an ``error`` event on any failure) so the browser knows when the
//    DB-side state is consistent and can stop showing the typing indicator.
const handleQaMessage = async ({ req, res, meetingId, userId, question }) => {
  // 1) Persist the user message before opening the upstream stream. If the
  //    DB write fails we don't want to start spending Gemini tokens.
  let userMessage;
  try {
    userMessage = await appendMeetingMessage({
      meetingId,
      userId,
      role: 'user',
      text: question,
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({ message: 'Meeting not found.' });
    }
    console.error('[meeting-service] qa: failed to persist user question', error);
    return res.status(500).json({ message: 'Failed to save question.' });
  }

  // 2) Set SSE headers and flush them immediately so the client opens its
  //    EventSource / ReadableStream parser without waiting for the first
  //    event. ``X-Accel-Buffering: no`` disables nginx-style buffering;
  //    ``Cache-Control: no-cache, no-transform`` keeps proxies from
  //    rewriting our event boundaries.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Tell the browser which message id its just-sent question got — useful so
  // the optimistic bubble it already drew can be reconciled with the row in
  // the DB without a second GET.
  writeSseEvent(res, 'user-saved', { message: userMessage });

  // Track whether the client gave up; if it did, we abort the upstream call
  // so we don't keep paying Gemini for output nobody is reading.
  const abortController = new AbortController();
  let clientGone = false;
  req.on('close', () => {
    if (!clientGone) {
      clientGone = true;
      abortController.abort();
    }
  });

  const incomingSpeakerMap = normalizeSpeakerMap(
    req.body?.speaker_map || req.body?.speakerMap,
  );
  let speakerMap = incomingSpeakerMap;
  let currentDuration = Number(req.body?.current_duration ?? req.body?.currentDuration);
  if (!Number.isFinite(currentDuration)) {
    currentDuration = null;
  }

  if (!Object.keys(speakerMap).length || currentDuration == null) {
    try {
      const context = await fetchMeetingQaContext({ meetingId, userId });
      if (context) {
        const meetingSpeakerMap = normalizeSpeakerMap(context.speakerMap);
        const derivedSpeakerMap = Object.keys(meetingSpeakerMap).length
          ? meetingSpeakerMap
          : buildSpeakerMap(context.participants, context.lines);
        const transcriptCount = getTranscriptSpeakerCount(context.lines);
        const speakerCount = Math.min(
          MAX_SPEAKER_COUNT,
          Math.max(transcriptCount, Object.keys(derivedSpeakerMap).length),
        );
        const filledSpeakerMap = fillSpeakerMap(derivedSpeakerMap, speakerCount);

        if (!Object.keys(speakerMap).length) {
          speakerMap = filledSpeakerMap;
        } else if (transcriptCount) {
          speakerMap = fillSpeakerMap(speakerMap, speakerCount);
        }

        if (currentDuration == null) {
          currentDuration = computeDurationSeconds({
            startTime: context.startTime,
            endTime: context.endTime,
          });
        }
      }
    } catch (error) {
      console.warn('[meeting-service] qa: failed to hydrate speaker map/duration', error);
    }
  }

  if (!Number.isFinite(currentDuration)) {
    currentDuration = 0;
  }

  // 3) Open the upstream SSE call.
  let upstream;
  try {
    upstream = await fetchWithRetry(`${QA_SERVICE_URL}/qa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        meeting_id: meetingId,
        user_id: userId,
        question,
        speaker_map: speakerMap,
        current_duration: currentDuration,
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    console.error('[meeting-service] qa: upstream fetch failed', error);
    if (!clientGone) {
      writeSseEvent(res, 'error', { message: 'QA service unreachable.' });
      res.end();
    }
    return;
  }

  if (!upstream.ok || !upstream.body) {
    console.error('[meeting-service] qa: upstream returned non-OK', upstream.status);
    if (!clientGone) {
      writeSseEvent(res, 'error', {
        message: `QA service returned status ${upstream.status}.`,
      });
      res.end();
    }
    return;
  }

  // Stream the upstream body through to the client AND parse it line-by-line
  // so we can intercept the ``done`` event and persist the final answer.
  // SSE frames are separated by a blank line; events within a frame are made
  // up of ``event: <name>`` and ``data: <json>`` lines.
  let buffer = '';
  let currentEvent = 'message';
  let currentData = '';
  let finalAnswer = null;
  let upstreamError = null;

  const handleFrame = () => {
    if (!currentData && currentEvent === 'message') {
      // Empty keepalive — nothing to do.
      currentEvent = 'message';
      currentData = '';
      return;
    }
    if (currentEvent === 'done') {
      try {
        const parsed = JSON.parse(currentData || '{}');
        finalAnswer = String(parsed.answer || '');
      } catch (err) {
        console.error('[meeting-service] qa: failed to parse done payload', err);
      }
    } else if (currentEvent === 'error') {
      try {
        const parsed = JSON.parse(currentData || '{}');
        upstreamError = String(parsed.message || 'Unknown QA error.');
      } catch (err) {
        upstreamError = currentData || 'Unknown QA error.';
      }
    }
    currentEvent = 'message';
    currentData = '';
  };

  try {
    for await (const chunk of upstream.body) {
      // ``upstream.body`` yields Uint8Array (Node fetch). Forward the bytes
      // verbatim to the client so deltas are flushed without extra latency.
      if (!clientGone) {
        res.write(chunk);
      }

      buffer += Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : Buffer.from(chunk).toString('utf8');

      // Walk completed lines out of the buffer.
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        // SSE uses LF line endings but tolerates CRLF — strip a trailing CR.
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line === '') {
          // End of a frame — interpret what we accumulated.
          handleFrame();
          continue;
        }
        if (line.startsWith(':')) {
          // SSE comment / keepalive — ignore.
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim() || 'message';
          continue;
        }
        if (line.startsWith('data:')) {
          // Multi-line ``data:`` continuations are joined with newlines per
          // the SSE spec. We almost always emit single-line JSON, but be
          // defensive.
          const piece = line.slice(5).replace(/^ /, '');
          currentData = currentData ? `${currentData}\n${piece}` : piece;
          continue;
        }
        // Other field names (``id:``, ``retry:``) are ignored — we don't use them.
      }
    }
  } catch (error) {
    if (!clientGone) {
      console.error('[meeting-service] qa: stream interrupted', error);
      writeSseEvent(res, 'error', { message: 'QA stream interrupted.' });
    }
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  // Drain any final frame the upstream closed without a trailing blank line.
  if (currentData || currentEvent !== 'message') {
    handleFrame();
  }

  // 4) If we got an error event, we already forwarded it; just close.
  if (upstreamError) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  // 5) Persist the assistant answer (if any) and emit a ``saved`` event so
  //    the browser can swap its streamed bubble for the canonical DB row.
  if (finalAnswer && finalAnswer.trim()) {
    try {
      const assistantMessage = await appendMeetingMessage({
        meetingId,
        userId,
        role: 'assistant',
        text: finalAnswer,
      });
      if (!clientGone) {
        writeSseEvent(res, 'saved', { message: assistantMessage });
      }
    } catch (error) {
      console.error('[meeting-service] qa: failed to persist answer', error);
      if (!clientGone) {
        writeSseEvent(res, 'error', { message: 'Failed to save answer.' });
      }
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
};
app.patch('/meetings/:meetingId/transcript', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const meetingId = Number(req.params.meetingId);
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  const aiSessionId = String(req.body?.aiSessionId || '').trim() || null;
  const asrStatus = String(req.body?.asrStatus || '').trim() || 'active_transcription';
  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const bufferTranscription = String(req.body?.bufferTranscription || '');
  const bufferDiarization = String(req.body?.bufferDiarization || '');
  const updatedAt = String(req.body?.updatedAt || '').trim() || new Date().toISOString();

  // Apply the same deduplication + merging that the frontend uses when
  // rendering the transcript, so the database stores clean lines.
  const isRealtime = asrStatus !== 'idle' && asrStatus !== 'done';
  const lines = cleanTranscriptLines(rawLines, { isRealtime });

  return query(
    `UPDATE meetings
     SET full_transcript = COALESCE(full_transcript, '{}'::jsonb) || jsonb_build_object(
       'aiSessionId', to_jsonb(COALESCE(NULLIF($1::text, ''), full_transcript->>'aiSessionId')),
       'asrStatus', to_jsonb($2::text),
       'lines', $3::jsonb,
       'bufferTranscription', to_jsonb($4::text),
       'bufferDiarization', to_jsonb($5::text),
       'updatedAt', to_jsonb($6::text)
     )
     WHERE id = $7 AND user_id = $8
     RETURNING id`,
    [
      aiSessionId,
      asrStatus,
      JSON.stringify(lines),
      bufferTranscription,
      bufferDiarization,
      updatedAt,
      meetingId,
      userId,
    ],
  )
    .then((result) => {
      if (!result.rowCount) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }
      return res.json({ ok: true, id: Number(result.rows[0].id) });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to persist transcript state', error);
      return res.status(500).json({ message: 'Failed to save transcript.' });
    });
});

app.patch('/meetings/:meetingId/speakers', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const meetingId = Number(req.params.meetingId);
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  const speakerMap = normalizeSpeakerMap(req.body?.speakers);

  return query(
    `UPDATE meetings
     SET full_transcript = jsonb_set(
       COALESCE(full_transcript, '{}'::jsonb),
       '{speakerMap}',
       $1::jsonb,
       true
     )
     WHERE id = $2 AND user_id = $3
     RETURNING full_transcript->'speakerMap' AS speaker_map`,
    [JSON.stringify(speakerMap), meetingId, userId],
  )
    .then((result) => {
      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }
      return res.json({ ok: true, speakerMap: row.speaker_map || {} });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to save speaker map', error);
      return res.status(500).json({ message: 'Failed to save speakers.' });
    });
});

app.patch('/meetings/:meetingId/title', (req, res) => {
  const meetingId = Number(req.params.meetingId);
  const userId = requireUserId(req, res);
  const title = String(req.body?.title || '').trim();

  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  if (!userId) {
    return;
  }

  if (!title) {
    return res.status(400).json({ message: 'Title is required.' });
  }

  return query(
    `UPDATE meetings
     SET full_transcript = jsonb_set(
       COALESCE(full_transcript, '{}'::jsonb),
       '{title}',
       to_jsonb($1::text),
       true
     )
     WHERE id = $2 AND user_id = $3
     RETURNING id, COALESCE(full_transcript->>'title', CONCAT('Meeting ', id::text)) AS title`,
    [title, meetingId, userId],
  )
    .then((result) => {
      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }
      return res.json({ id: row.id, title: row.title });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to rename meeting', error);
      return res.status(500).json({ message: 'Failed to rename meeting.' });
    });
});

app.delete('/meetings/:meetingId', (req, res) => {
  const meetingId = Number(req.params.meetingId);
  const userId = requireUserId(req, res);

  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }
  if (!userId) {
    return;
  }

  return query(
    `DELETE FROM meetings
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [meetingId, userId],
  )
    .then((result) => {
      if (!result.rowCount) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }
      return res.json({ deleted: true, id: Number(result.rows[0].id) });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to delete meeting', error);
      return res.status(500).json({ message: 'Failed to delete meeting.' });
    });
});

app.patch('/meetings/:meetingId/summary', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const meetingId = Number(req.params.meetingId);
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  const { summary } = req.body;
  if (typeof summary !== 'string') {
    return res.status(400).json({ message: 'Summary must be a string.' });
  }

  return query(
    `UPDATE meetings
     SET summarisation = $1
     WHERE id = $2 AND user_id = $3
     RETURNING id, summarisation`,
    [summary, meetingId, userId],
  )
    .then((result) => {
      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }
      return res.json({
        id: row.id,
        summary: row.summarisation || '',
      });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to update meeting summary', error);
      return res.status(500).json({ message: 'Failed to update meeting summary.' });
    });
});

app.post('/meetings/:meetingId/complete', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) {
    return;
  }

  const meetingId = Number(req.params.meetingId);
  if (!Number.isFinite(meetingId) || meetingId <= 0) {
    return res.status(400).json({ message: 'Invalid meeting id.' });
  }

  return query(
    `UPDATE meetings
     SET end_time = NOW(),
         duration_minutes = GREATEST(
           0,
           CEIL(EXTRACT(EPOCH FROM (NOW() - COALESCE(start_time, date))) / 60.0)::INT
         ),
         full_transcript = jsonb_set(
           COALESCE(full_transcript, '{}'::jsonb),
           '{durationMinutes}',
           to_jsonb(
             GREATEST(
               0,
               CEIL(EXTRACT(EPOCH FROM (NOW() - COALESCE(start_time, date))) / 60.0)::INT
             )
           ),
           true
         )
     WHERE id = $1 AND user_id = $2
     RETURNING id, start_time, end_time, duration_minutes`,
    [meetingId, userId],
  )
    .then((result) => {
      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ message: 'Meeting not found.' });
      }
      return res.json({
        id: row.id,
        startTime: row.start_time,
        endTime: row.end_time,
        durationMinutes: Number(row.duration_minutes) || 0,
      });
    })
    .catch((error) => {
      console.error('[meeting-service] failed to complete meeting', error);
      return res.status(500).json({ message: 'Failed to complete meeting.' });
    });
});

const server = http.createServer(app);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Meeting service listening on ${PORT} (hosted on ${os.hostname()})`);
});


installShutdown(server, { pool });
