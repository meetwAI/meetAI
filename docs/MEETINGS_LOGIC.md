# Meetings Logic

This document describes meeting lifecycle, API behavior, ownership checks, and transcript updates.

## Components

- Meeting service API: `server/meeting-service/index.js`
- Gateway meeting proxies: `server/gateway/app.js`
- Frontend meeting pages/actions:
  - `client/meetai-web/src/components/MainLayout.jsx`
  - `client/meetai-web/src/components/PreviousMeetings.jsx`
  - `client/meetai-web/src/components/Dashboard.jsx`

## Lifecycle (Current Implementation)

1. User clicks `Meet With AI` in `MainLayout`.
2. Frontend calls `POST /meetings` through gateway.
3. Meeting-service creates a row with:
   - `start_time`
   - `duration_minutes = 0`
   - initial `full_transcript` JSON
4. Frontend navigates to `/meetings/:meetingId` immediately.
5. During capture/streaming, frontend appends assistant/user messages via `POST /meetings/:meetingId/messages`.
6. On stop, frontend calls `POST /meetings/:meetingId/complete`.
7. Meeting-service sets `end_time` and recalculates `duration_minutes` from DB timestamps.

## Meeting Transcript Shape

Meeting creation stores this base JSON in `full_transcript`:

```json
{
  "title": "Meeting ...",
  "durationMinutes": 0,
  "participants": [],
  "actionItems": [],
  "messages": []
}
```

Message append writes to `full_transcript.messages` as objects:

```json
{
  "id": "msg-...",
  "role": "assistant",
  "text": "...",
  "time": "ISO-8601"
}
```

## Meeting Endpoints

All are exposed on gateway (`http://localhost:4010`) and proxied to meeting-service.

- `GET /meetings/dummy`
  - Returns list view data (title/date/summary/participants/messages)

- `GET /meetings/recent?limit=3`
  - Returns recent meetings sorted by `COALESCE(end_time, date)` descending
  - Includes `durationMinutes`, `startTime`, `endTime`

- `GET /meetings/:meetingId`
  - Returns full meeting detail including `messages` and `actionItems`

- `POST /meetings`
  - Requires authenticated user (`x-user-id` propagated by gateway)
  - Creates new meeting
  - Returns `{ id, startTime }`

- `POST /meetings/:meetingId/messages`
  - Appends one message to JSONB array
  - Request body expects `content` and optional `role`
  - Role normalized to `assistant` or `user`

- `POST /meetings/:meetingId/complete`
  - Sets `end_time = NOW()`
  - Sets `duration_minutes` from elapsed time since `start_time`
  - Syncs `full_transcript.durationMinutes`

- `PATCH /meetings/:meetingId/title`
  - Owner-only (`WHERE id = $2 AND user_id = $3`)
  - Updates JSONB `full_transcript.title`

- `DELETE /meetings/:meetingId`
  - Owner-only (`WHERE id = $1 AND user_id = $2`)

## Authorization and Ownership

- Gateway verifies access token for meeting routes and injects `x-user-id`.
- Meeting creation requires valid `x-user-id`.
- Read endpoints (`/meetings/dummy`, `/meetings/recent`, `/meetings/:id`) are owner-scoped by `user_id`.
- Message append and completion (`/meetings/:id/messages`, `/meetings/:id/complete`) are owner-scoped by `user_id`.
- Rename and delete are strict owner-only operations.

## Frontend Cache Behavior

React Query keys used:

- `['meetings', 'dummy']`: meetings list
- `['meetings', 'recent', 3]`: dashboard recap
- `['meeting', meetingId]`: selected meeting detail

Update strategy:

- Message append updates cached list/detail meeting in-place.
- Delete removes deleted meeting from cache and invalidates recent meetings.
- Rename updates local cache title then invalidates recent meetings.
- Route changes invalidate only affected meeting key when possible.

## Time and Date Details

- Dashboard uses `meeting.date` display from API.
- Meeting list formats dates with `moment(...).format('DD-MMM-YYYY')`.
- `duration_minutes` is persisted numerically in table and reflected into transcript JSON.

## Common Operations

Create meeting:

```bash
curl -X POST -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:4010/meetings
```

Append message:

```bash
curl -X POST -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{"content":"Hello","role":"user"}' \
  http://localhost:4010/meetings/2/messages
```

Complete meeting:

```bash
curl -X POST -H "Authorization: Bearer <ACCESS_TOKEN>" \
  http://localhost:4010/meetings/2/complete
```

Rename meeting:

```bash
curl -X PATCH -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{"title":"Weekly Sync"}' \
  http://localhost:4010/meetings/2/title
```

Delete meeting:

```bash
curl -X DELETE -H "Authorization: Bearer <ACCESS_TOKEN>" \
  http://localhost:4010/meetings/2
```
