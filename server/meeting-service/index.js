const http = require('http');
const express = require('express');
const cors = require('cors');
const { setupSocket } = require('./socket');
const { query } = require('../db/client');

const PORT = process.env.PORT || 4001;

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/meetings/dummy', (_req, res) => {
  return query(
    `SELECT
      id,
      COALESCE(full_transcript->>'title', CONCAT('Meeting ', id::text)) AS title,
      TO_CHAR(date, 'Mon DD, YYYY') AS date,
      COALESCE(summarisation, '') AS summary,
      COALESCE(full_transcript->'participants', '[]'::jsonb) AS participants,
      COALESCE(full_transcript->'messages', '[]'::jsonb) AS messages
    FROM meetings
    ORDER BY date DESC
    LIMIT 25`,
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
    ORDER BY COALESCE(end_time, date) DESC
    LIMIT $1`,
    [limit],
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
    WHERE id = $1
    LIMIT 1`,
    [meetingId],
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
     WHERE id = $2
     RETURNING id`,
    [JSON.stringify([message]), meetingId],
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

const server = http.createServer(app);
setupSocket(server);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Meeting service listening on ${PORT}`);
});
