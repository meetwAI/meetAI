# Auth Logic

This document explains authentication in meetAI across gateway, auth-service, and frontend token handling.

## Components

- Auth service: `server/auth-service`
- Token service: `server/auth-service/services/tokenService.js`
- Password service: `server/auth-service/services/passwordService.js`
- Auth routes: `server/auth-service/routes/auth.js`
- Gateway auth proxy + verification: `server/gateway/app.js`
- Login rate limiter: `server/gateway/rate-limiters/loginRateLimiter.js`
- Frontend auth-aware fetch helper: `client/meetai-web/src/api/fetchWithAuth.js`

## Auth Flow Overview

1. Frontend posts credentials to the API base URL `POST /login` (typically the gateway; may be auth-service directly if `VITE_AUTH_URL` is set).
2. Gateway applies login rate limit and proxies to auth-service `POST /login`.
3. Auth-service validates username/password from `users` table.
4. Auth-service issues:
   - short-lived access token (JWT)
   - longer refresh token (JWT)
5. Access token is set in `HttpOnly` cookie `meetai_access`.
6. Refresh token is set in `HttpOnly` cookie `meetai_refresh`.
7. Frontend stores only non-sensitive user profile data (`meetai_user`) in `localStorage`.
8. Protected gateway routes are enforced by `verifyAccess` middleware in gateway.
9. Gateway `verifyAccess` first calls auth-service `POST /verify` using the current access token.
10. If `/verify` fails (expired/invalid access token), gateway calls auth-service `POST /refresh` using the `meetai_refresh` cookie.
11. If refresh succeeds, auth-service sets a new `meetai_access` cookie and gateway continues the original protected request.

## Tokens and TTL

Defined in `server/auth-service/services/tokenService.js`:

- JWT signing key envs:
  - `JWT_ACTIVE_SECRET` (required; current signing key)
  - `JWT_PREVIOUS_SECRETS` (optional; comma-separated older keys accepted for verify during rotation)
  - `JWT_SECRET` (legacy fallback if `JWT_ACTIVE_SECRET` is not set)
- Access token TTL: `JWT_TTL_SECONDS` (required; set in `docker-compose.yml` to `900` seconds = 15 minutes)
- Refresh token TTL: `REFRESH_TTL_SECONDS` (required; set in `docker-compose.yml` to `864000` seconds = 10 days)
- Token hashes and refresh index are stored in Redis:
  - `auth:access:<sha256(token)>`
  - `auth:refresh:<sha256(token)>`
  - `auth:user_refresh:<userId>` (points to active refresh token hash)

Refresh-token policy:

- Only one active refresh token is allowed per user.
- When new tokens are issued (login/signup/refresh), any previous refresh token for that user is deleted from Redis before storing the new one.
- Refresh verification checks both token presence and active-refresh index match.

JWT key rotation policy:

- New tokens are signed with `JWT_ACTIVE_SECRET`.
- Verification accepts `JWT_ACTIVE_SECRET` and any keys in `JWT_PREVIOUS_SECRETS`.
- Legacy `JWT_SECRET` is accepted only when `JWT_ACTIVE_SECRET` is not provided.

Token payload includes:

- `sub` (user id)
- `username`
- `name`
- `tokenType` (`access` or `refresh`)

## Auth Endpoints

Auth-service routes (proxied by gateway):

- `POST /signup`
  - Request body: `{ name, username, email, password }`
  - Returns: `{ user }`
  - Stores password as a one-way `scrypt` hash
  - Sets access cookie `meetai_access`
  - Sets refresh cookie `meetai_refresh`

- `POST /login`
  - Request body: `{ username, password }`
  - Returns: `{ user }`
  - Sets access cookie `meetai_access`
  - Sets refresh cookie `meetai_refresh`
  - Validates password against stored `scrypt` hash
  - If a legacy plain-text password is found and matches, it is upgraded to a hash on successful login

- `POST /refresh`
  - Uses `meetai_refresh` cookie
  - Returns: `{ user }`
  - Revokes the used refresh token in Redis
  - Invalidates any previously active refresh token for that user
  - Rotates both access and refresh cookies

- `POST /logout`
  - Uses `Authorization: Bearer <accessToken>` (optional), `meetai_access` cookie, and `meetai_refresh` cookie
  - Revokes access token in Redis
  - Revokes the provided refresh token in Redis
  - Clears user-level active refresh-token index in Redis (if available)
  - Clears the `meetai_access` cookie
  - Clears the `meetai_refresh` cookie
  - Returns: `{ success: true }`

- `POST /verify`
  - Uses `Authorization: Bearer <accessToken>` or `meetai_access` cookie
  - Returns: `{ user }` on valid access token
  - Returns `401` for missing/expired/invalid access token
  - Does not perform refresh itself

## Gateway Enforcement

In `server/gateway/app.js`:

- `POST /login` and `POST /signup` are rate-limited, then proxied.
- `POST /refresh` and `POST /logout` are proxied directly.
- `app.use(verifyAccess)` protects all downstream meeting routes.
- `verifyAccess` behavior for protected routes:
  - Calls auth-service `POST /verify` with current bearer token and cookies
  - If verify fails, attempts auth-service `POST /refresh` using refresh cookie
  - If refresh succeeds, continues request with refreshed auth context
  - If refresh fails, responds `401 Unauthorized`
- On successful authorization:
  - `req.authUser` is set
  - `req.authToken` is set (from bearer token or access cookie; refreshed when needed)
  - on refresh, new cookies are forwarded to client
- Gateway forwards `x-user-id` to meeting-service from `req.authUser.id`.
- All meeting-service proxying goes through a single `proxyMeetingService(method, path, req, res)` helper.
- Socket.io connections are also verified against `POST /verify` before the handshake completes.

## Login Rate Limiting

In `server/gateway/rate-limiters/loginRateLimiter.js`:

- Applied to `POST /login` and `POST /signup`
- Keyed by normalized username in Redis: `auth:login:<username>`
- Window: 60 seconds
- Limit: 5 attempts per minute
- Returns `429` when exceeded
- If Redis is unavailable, limiter fails open and request continues

## Frontend Token Behavior

Frontend files:

- Login page: `client/meetai-web/src/components/Login.jsx`
- Fetch helper: `client/meetai-web/src/api/fetchWithAuth.js`
- Query global error handling: `client/meetai-web/src/main.jsx`

Behavior:

- On login success:
  - stores `meetai_user` in `localStorage`
  - relies on cookie-based refresh token via `credentials: 'include'`
- All authenticated requests use `fetchWithAuth`:
  - relies on `meetai_access` and `meetai_refresh` cookies
  - on `401`, attempts one refresh call then retries original request once
- QueryClient global `401` handler clears local auth and redirects to `/`.

## Notes and Caveats

- Passwords are hashed using `scrypt` before storage; auth-service never stores new plain-text passwords.
- `buildUser` maps `id` from `user.id ?? user.sub` to support DB users and token payload users.
- The DB `users` table uses `username` as the canonical login column.
- Auth-service CORS methods currently include `GET` and `POST` only, which is sufficient for existing auth endpoints.
- In non-production environments, auth-service `500` responses include an `error` object (name/message/code/detail/stack) to help debugging from the browser network panel.

## Quick Test Commands

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo"}' \
  -c cookies.txt \
  http://localhost:4010/login
```

```bash
curl -X POST -b cookies.txt http://localhost:4010/refresh
```

```bash
curl -X POST -H "Authorization: Bearer <ACCESS_TOKEN>" -b cookies.txt \
  http://localhost:4010/logout
```

```bash
curl -X POST -H "Authorization: Bearer <ACCESS_TOKEN>" -b cookies.txt \
  http://localhost:4010/verify
```
