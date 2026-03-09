# Frontend Workflow

This document explains how the React app is structured, how auth/session is handled, and how meeting capture + pages work.

## Frontend Stack

- Vite + React
- React Router for routing
- React Query (`@tanstack/react-query`) for server state/cache
- Socket.io client for realtime audio chunk streaming
- `moment` for date formatting

Main frontend location: `client/meetai-web`

## Routing and Guards

Defined in `client/meetai-web/src/App.jsx`:

- `/login`: auth page (`Login.jsx`) behind `AuthRoute` (redirects to `/` if already signed in)
- `/`: protected area under `RequireAuth` and `MainLayout`
- Nested protected routes:
  - index: `Dashboard`
  - `/meetings`: `PreviousMeetings`
  - `/meetings/:meetingid`: `PreviousMeetings` detail mode
  - `/profile`: `Profile`

Guard behavior:

- `RequireAuth` checks `localStorage.meetai_token`
- If no token, it renders `LandingPage`

## Query Client and Global 401 Handling

Defined in `client/meetai-web/src/main.jsx`:

- Global query error handler watches for `error.status === 401`
- On 401:
  - removes `meetai_token`
  - removes `meetai_user`
  - redirects to `/`

## Auth-Aware Fetch Helper

Defined in `client/meetai-web/src/api/fetchWithAuth.js`:

- Base URL is gateway: `http://localhost:4010`
- Adds bearer token from `localStorage` if present
- Always sends cookies (`credentials: 'include'`) for refresh cookie flow
- If response includes `x-access-token`, updates local access token
- On first `401`, auto-calls `POST /refresh` and retries original request once

## Login Flow

Defined in `client/meetai-web/src/components/Login.jsx`:

1. User submits username/password.
2. Frontend calls `POST /login` with credentials included.
3. On success:
   - stores `meetai_token` and `meetai_user`
   - calls `connectSocket(token)`
   - navigates to `/`

## Main Layout and Capture Flow

Defined in `client/meetai-web/src/components/MainLayout.jsx`:

- Top navigation hosts the `Meet With AI` start button.
- Capture state machine uses values: `idle`, `requesting`, `capturing`.

Start flow (`startCapture`):

1. Validate token and browser capture support.
2. Create meeting (`POST /meetings`) before recording.
3. Prime React Query cache for `['meeting', meetingId]`.
4. Navigate to `/meetings/:meetingId`.
5. Start screen/tab capture via `getDisplayMedia`.
6. Extract audio track and initialize `MediaRecorder`.
7. Ensure socket connection to gateway.
8. Stream chunks every 10s via `meeting-audio-chunk` event.

Realtime callback:

- On `meeting-audio-processed` from socket:
  - surface message in UI
  - persist assistant output using `POST /meetings/:id/messages`
  - append message to React Query caches

Stop flow (`stopCapture`):

1. Stop recorder + streams.
2. Detach socket listeners.
3. Call `POST /meetings/:id/complete`.
4. Invalidate relevant meeting caches.
5. Return state to `idle`.

## Meetings Page Behavior

Defined in `client/meetai-web/src/components/PreviousMeetings.jsx`:

Data fetches:

- list query: `['meetings', 'dummy']` from `GET /meetings/dummy`
- detail query: `['meeting', meetingid]` from `GET /meetings/:meetingid`

Interactions:

- Select meeting card -> navigate `/meetings/:id`
- Send user message -> `POST /meetings/:id/messages`
- Rename meeting -> `PATCH /meetings/:id/title`
- Delete meeting -> `DELETE /meetings/:id`

Cache strategy:

- Local cache is patched optimistically for rename/message append.
- After delete, list cache removes item and detail query is removed.
- Recent meetings query is invalidated after delete/rename.

## Dashboard Behavior

Defined in `client/meetai-web/src/components/Dashboard.jsx`:

- Fetches `GET /meetings/recent?limit=3` with key `['meetings', 'recent', 3]`
- Displays latest meeting cards and basic computed analytics:
  - latest duration
  - total hours over latest 3
  - average participants

## Socket Client

Defined in `client/meetai-web/src/api/socketClient.js`:

- Maintains singleton socket instance
- `connectSocket(token)` sets socket auth and reconnects if needed
- Uses websocket transport to gateway URL (default `http://localhost:4010`)

## Date Formatting

- Meeting card/list dates: `moment(date).format('DD-MMM-YYYY')`
- Message timestamps can include time: `moment(message.time).format('DD-MMM-YYYY HH:mm')`

## Practical Notes

- Frontend token storage is in `localStorage`; refresh token is an HttpOnly cookie.
- If user starts capture without tab audio enabled, flow throws explicit error.
- Existing flow creates meeting first, so every session has an ID before streaming starts.
