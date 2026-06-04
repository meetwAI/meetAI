// Single source of truth for service base URLs.
// Override via Vite env vars (VITE_AUTH_URL etc.) at build time.
//
// Default is HTTPS — the auth/gateway services run TLS by default
// (see AUTH_USE_HTTPS in docker-compose.yml). The earlier split where
// http.js defaulted to http:// while socket.js defaulted to https://
// caused mixed-content failures in dev; both now share this constant.

export const AUTH_BASE = (
  import.meta.env.VITE_AUTH_URL || 'https://localhost:4010'
).replace(/\/$/, '');
