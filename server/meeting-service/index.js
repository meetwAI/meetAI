const http = require('http');
const express = require('express');
const cors = require('cors');
const { requireNumberEnv } = require('../config/env');
const { setupSocket } = require('./socket');
const { query } = require('../db/client');

const PORT = requireNumberEnv('PORT');

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

  const transcript = {
    title,
    durationMinutes: 0,
    participants,
    actionItems: [],
    messages: [],
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

  return query(
    `SELECT
      id,
      COALESCE(full_transcript->>'title', CONCAT('Meeting ', id::text)) AS title,
      TO_CHAR(date, 'Mon DD, YYYY') AS date,
      COALESCE(summarisation, '') AS summary,
      COALESCE(full_transcript->'participants', '[]'::jsonb) AS participants,
      COALESCE(full_transcript->'messages', '[]'::jsonb) AS messages
    FROM meetings
    WHERE user_id = $1
    ORDER BY date DESC
    LIMIT 25`,
    [userId],
  )
    .then((result) => {
      const meetings = result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        date: row.date,
        summary: row.summary,
        participants: Array.isArray(row.participants) ? row.participants : [],
        messages: Array.isArray(row.messages) ? row.messages : [],
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
      COALESCE(full_transcript->'messages', '[]'::jsonb) AS messages,
      COALESCE(full_transcript->'actionItems', '[]'::jsonb) AS action_items,
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
        messages: Array.isArray(row.messages) ? row.messages : [],
        actionItems: Array.isArray(row.action_items) ? row.action_items : [],
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
setupSocket(server);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Meeting service listening on ${PORT}`);
});
