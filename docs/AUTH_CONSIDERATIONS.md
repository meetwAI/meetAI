# Auth Considerations

This document tracks production hardening items for meetAI auth. Items marked **Handled** are already addressed in code. All others are recommended next steps.

## Handled

1. Access tokens in localStorage -> XSS exposure
   - Status: **Handled**
   - Fix: Access tokens are now stored in HttpOnly cookies (`meetai_access`). Frontend stores only `meetai_user`.

2. Refresh tokens not revoked on refresh
   - Status: **Handled**
   - Fix: Refresh rotation is enforced. Old refresh tokens are revoked and a single active refresh token is kept per user.

3. Weak JWT secret and no key rotation
   - Status: **Handled**
   - Fix: Rotation supported with `JWT_ACTIVE_SECRET` + `JWT_PREVIOUS_SECRETS`. Legacy `JWT_SECRET` is a fallback only.

4. CSRF exposure on refresh cookies
   - Status: **Handled (partial)**
   - Fix: Cookies are `SameSite=Strict`. Consider full CSRF tokens for defense-in-depth.

## Recommended Improvements

1. Rate limiting fails open if Redis is down
   - Risk: Brute-force login attempts become easier.
   - Recommendation:
     - Add an in-memory fallback limiter when Redis is unavailable.
     - Rate limit by both IP and username.

2. Add explicit CSRF tokens for refresh
   - Risk: Cookie-based refresh endpoints can still be abused in some edge cases.
   - Recommendation:
     - Use a double-submit CSRF token on `/refresh`.

3. Add refresh token reuse detection
   - Risk: If a stolen refresh token is replayed, the system should respond aggressively.
   - Recommendation:
     - Detect reuse and revoke all active sessions for that user.
     - Emit an audit log entry or alert.

4. Add session/device tracking
   - Risk: Single-session systems make it hard to support multiple devices safely.
   - Recommendation:
     - Store session metadata (device, IP, last_seen) and allow per-device revoke.

5. Improve audit logging
   - Risk: No visibility into auth events or anomalous behavior.
   - Recommendation:
     - Log login success/failure, refresh, verify failures, and logout.

6. Harden rate limits with lockout/backoff
   - Risk: Credential stuffing can still be effective with simple rate limits.
   - Recommendation:
     - Exponential backoff and temporary lockout after repeated failures.

7. Remove or guard Redis snapshots in logs
   - Risk: `logRedisSnapshot` can leak auth metadata in logs.
   - Recommendation:
     - Disable in production or gate behind a debug flag.

## Summary

The system is functional and more robust than the initial version. The remaining items are mostly operational hardening, anomaly detection, and defense-in-depth work before production scale.
