# Login, Google Login, and Calendar Access Flow

This document explains how authentication currently works in meetAI, including:

- Username/password login
- Google login
- Google Calendar access requested later (not at login)

It is implementation-accurate to the current code in `server/auth-service/routes/auth.js`, `server/gateway/app.js`, and the frontend profile and login components.

## 1. Architecture at a Glance

Authentication is split across:

- Gateway (`server/gateway`): request proxy, auth verification, refresh fallback, route protection
- Auth service (`server/auth-service`): login/signup/oauth endpoints, token issuance, Google token persistence
- Frontend (`client/meetai-web`): login UI, profile UI, auth-aware fetch logic

Cookie-based auth is used end to end.

## 2. Cookies and Tokens

After successful login (password or Google), auth-service sets:

- `meetai_access`: short-lived access JWT (HttpOnly)
- `meetai_refresh`: longer-lived refresh JWT (HttpOnly)

The frontend stores only user profile data (`meetai_user`) in localStorage.

## 3. Username/Password Login (Complete Flow)

### Step-by-step

1. Frontend sends `POST /login` (to gateway).
2. Gateway applies login rate limit and proxies to auth-service.
3. Auth-service verifies credentials from `users` table.
4. Auth-service issues access + refresh tokens.
5. Auth-service sets `meetai_access` and `meetai_refresh` cookies.
6. Frontend stores returned user payload in `localStorage`.
7. Protected API calls run through `fetchWithAuth`.

### Protected request behavior

For protected routes, gateway `verifyAccess` does:

1. Call auth-service `POST /verify` using current cookie/bearer token.
2. If verify fails, call auth-service `POST /refresh`.
3. If refresh succeeds, continue original request with refreshed auth context.
4. If refresh fails, return `401 Unauthorized`.

## 4. Google Login (No Calendar Consent at Login)

Google login now requests only basic identity scopes:

- `profile`
- `email`

Security notes:

- OAuth Authorization Code flow uses PKCE (`S256`) at the strategy level.
- State validation is enabled and required for PKCE verification.

### Flow

1. Frontend starts OAuth via `GET /auth/google`.
2. Auth-service stores OAuth mode as `login` in session.
3. User signs in at Google and returns to `GET /auth/google/callback`.
4. Auth-service finds or creates a local user record.
5. Auth-service issues app access + refresh cookies.
6. Auth-service redirects to `FRONTEND_ORIGIN/`.

Important: calendar scope is not requested in this flow.

## 5. Calendar Access Requested Later (Deferred Consent)

Calendar access is connected from Profile when needed.

### Frontend trigger

In Profile, user clicks "Connect Google Calendar", which opens:

- `GET /auth/google/calendar`

### Backend flow

1. Gateway verifies user is logged in before allowing this route.
2. Gateway proxies request to auth-service and forwards `x-user-id`.
3. Auth-service stores OAuth mode as `calendar-connect` plus the initiating user id in session.
4. Auth-service starts Google OAuth with scopes:
   - `profile`
   - `email`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - PKCE challenge (`S256`) and state are applied automatically by the strategy
5. On callback, auth-service detects `calendar-connect` mode.
6. Auth-service persists Google tokens to that logged-in user row:
   - `google_refresh_token`
   - `google_access_token`
   - `google_token_expiry`
7. Auth-service redirects to:
   - success: `/profile?calendar=connected`
   - failure: `/profile?calendar=error&reason=...`

## 6. Calendar Status and Events APIs

### Calendar connection status

- Endpoint: `GET /calendar/status`
- Protected by gateway auth
- Returns:

```json
{
  "connected": true
}
```

The value is derived from whether `users.google_refresh_token` is present.

### Calendar events

- Endpoint: `GET /calendar/events`
- Optional query params:
  - `timeMin` (ISO string)
  - `timeMax` (ISO string)
  - `maxResults` (1..250)

Behavior:

1. Auth-service reads user's `google_refresh_token`.
2. Uses refresh token to get a fresh Google access token.
3. Calls Google Calendar API.
4. Updates `google_access_token` and `google_token_expiry` in DB.
5. Returns normalized event list.

If Google refresh token is invalid/expired, auth-service clears stored Google tokens and returns not-connected response.

## 7. Required Environment Variables

For Google flows:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`
- `FRONTEND_ORIGIN`
- `SESSION_SECRET`

General auth:

- `JWT_ACTIVE_SECRET` (or legacy fallback)
- `JWT_TTL_SECONDS`
- `REFRESH_TTL_SECONDS`
- `REDIS_URL`

## 8. Frontend UX Summary

- Login page supports password login and Google login.
- Google login signs the user in without calendar consent.
- Profile page shows calendar connection state from `GET /calendar/status`.
- Profile page is where user grants calendar access later.
- Profile reads callback query params (`calendar=connected` or `calendar=error`) and displays status.

## 9. Why This Design

Benefits of deferred calendar consent:

- Lower friction at initial login
- Better user trust and clearer permission intent
- Calendar access only requested when user chooses calendar features

This keeps authentication simple while still supporting calendar features when needed.
