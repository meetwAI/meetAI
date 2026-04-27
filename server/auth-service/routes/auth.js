const express = require('express');
const passport = require('passport');
const {
  issueTokens,
  verifyRefreshToken,
  verifyAccessToken,
  revokeToken,
  revokeUserRefreshToken,
  JWT_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
} = require('../services/tokenService');
const { hashPassword, verifyPassword, isPasswordHash } = require('../services/passwordService');
const { fetchCalendarEvents } = require('../services/googleCalendarService');
const {
  getUserByUsername,
  getGoogleCalendarTokensByUserId,
  createUser,
  updateUserPassword,
  updateUserProfile,
  persistGoogleTokensForUser,
  clearGoogleTokensForUser,
} = require('../services/userService');
const {
  GOOGLE_LOGIN_SCOPES,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_MODE_LOGIN,
  GOOGLE_OAUTH_MODE_CALENDAR,
  ensureGoogleConfigured,
  setGoogleOauthSessionMode,
  consumeGoogleOauthSessionMode,
  estimateGoogleAccessTokenExpiry,
} = require('../services/googleAuthService');
const { decryptGoogleRefreshToken } = require('../services/googleSecretsService');

const router = express.Router();

const setRefreshCookie = (res, refreshToken) => {
  res.cookie('meetai_refresh', refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
};

const setAccessCookie = (res, accessToken) => {
  res.cookie('meetai_access', accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: JWT_TTL_SECONDS * 1000,
  });
};

const clearRefreshCookie = (res) => {
  res.cookie('meetai_refresh', '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
};

const clearAccessCookie = (res) => {
  res.cookie('meetai_access', '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
};

const buildUser = (user) => ({
  id: user.id ?? user.sub,
  username: user.username,
  name: user.name,
  avatarUrl: user.avatar_url,
});

const normalizeText = (value) => String(value || '').trim();
const isDevelopment = process.env.NODE_ENV !== 'production';
const FRONTEND_ORIGIN = normalizeText(process.env.FRONTEND_ORIGIN) || '';

const devError = (error) => {
  if (!isDevelopment || !error) {
    return undefined;
  }
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    detail: error.detail,
    stack: error.stack,
  };
};

router.post('/signup', async (req, res) => {
  const name = normalizeText(req.body?.name); // optional — can be empty
  const username = normalizeText(req.body?.username).toLowerCase();
  const email = normalizeText(req.body?.email).toLowerCase();
  const password = String(req.body?.password || '');

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email, and password are required.' });
  }

  if (username.length < 3) {
    return res.status(400).json({ message: 'Username must be at least 3 characters.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await createUser({ name, email, username, passwordHash });
    if (!user) {
      throw new Error('user-create-returned-empty');
    }

    const { accessToken, refreshToken } = await issueTokens(user);
    setAccessCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);
    return res.status(201).json({ user: buildUser(user) });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'Username or email already exists.' });
    }
    console.error('[auth-service] signup failed', error);
    return res.status(500).json({
      message: 'Signup failed',
      error: devError(error),
    });
  }
});

router.post('/login', async (req, res) => {
  const username = normalizeText(req.body?.username).toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  try {
    const user = await getUserByUsername(username);

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const usingHash = isPasswordHash(user.password);
    const validPassword = usingHash ? await verifyPassword(password, user.password) : user.password === password;

    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    if (!usingHash) {
      const upgradedPasswordHash = await hashPassword(password);
      await updateUserPassword(user.id, upgradedPasswordHash);
    }

    const { accessToken, refreshToken } = await issueTokens(user);
    setAccessCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);
    return res.json({ user: buildUser(user) });
  } catch (error) {
    console.error('[auth-service] login failed', error);
    return res.status(500).json({
      message: 'Login failed',
      error: devError(error),
    });
  }
});

router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.meetai_refresh;
  const previousAccessToken = req.cookies?.meetai_access || '';
  if (!refreshToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const payload = await verifyRefreshToken(refreshToken);

    // Rotate refresh tokens: once used, the current refresh token becomes invalid.
    await revokeToken(refreshToken, 'refresh');
    if (previousAccessToken) {
      await revokeToken(previousAccessToken, 'access');
    }

    const { accessToken, refreshToken: newRefreshToken } = await issueTokens({
      id: payload.sub,
      username: payload.username,
      name: payload.name,
    });

    setAccessCookie(res, accessToken);
    setRefreshCookie(res, newRefreshToken);
    return res.json({
      user: buildUser({ id: payload.sub, username: payload.username, name: payload.name }),
    });
  } catch (_error) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
});

router.post('/verify', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const tokenFromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = tokenFromHeader || req.cookies?.meetai_access || '';
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return verifyAccessToken(token)
    .then((payload) => res.json({ user: buildUser(payload) }))
    .catch(() => res.status(401).json({ message: 'Unauthorized' }));
});

router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const accessToken =
    (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '') || req.cookies?.meetai_access || '';
  const refreshToken = req.cookies?.meetai_refresh;
  let accessPayload = null;

  if (accessToken) {
    try {
      accessPayload = await verifyAccessToken(accessToken);
    } catch (_error) {
      accessPayload = null;
    }
  }

  try {
    await Promise.all([
      revokeToken(accessToken, 'access'),
      revokeToken(refreshToken, 'refresh'),
      revokeUserRefreshToken(accessPayload?.sub),
    ]);
  } catch (_error) {
    // Do not leak revocation internals; always clear cookie and return success.
  }

  clearAccessCookie(res);
  clearRefreshCookie(res);
  return res.json({ success: true });
});

// Update profile fields (name, age, phone, location) for the authenticated user.
// The gateway forwards x-user-id from the verified token.
router.post('/profile', async (req, res) => {
  const userId = Number(req.headers['x-user-id']);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const name = normalizeText(req.body?.name);
  const age = req.body?.age != null ? Number(req.body.age) : null;
  const phone = normalizeText(req.body?.phone) || null;
  const location = normalizeText(req.body?.location) || null;

  if (age !== null && (!Number.isFinite(age) || age < 0 || age > 150)) {
    return res.status(400).json({ message: 'Invalid age.' });
  }

  try {
    const row = await updateUserProfile({
      userId,
      name,
      age,
      phone,
      location,
    });

    if (!row) {
      return res.status(404).json({ message: 'User not found.' });
    }
    return res.json({ user: { id: row.id, username: row.username, name: row.name, age: row.age, phone: row.phone, location: row.location } });
  } catch (error) {
    console.error('[auth-service] profile update failed', error);
    return res.status(500).json({
      message: 'Profile update failed.',
      error: devError(error),
    });
  }
});

router.get('/calendar/status', async (req, res) => {
  const userId = Number(req.headers['x-user-id']);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const user = await getGoogleCalendarTokensByUserId(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({
      connected: Boolean(
        normalizeText(user.google_refresh_iv) &&
          normalizeText(user.google_refresh_ciphertext) &&
          normalizeText(user.google_refresh_tag),
      ),
    });
  } catch (error) {
    console.error('[auth-service] calendar status failed', error);
    return res.status(500).json({
      message: 'Unable to read Google Calendar status.',
      error: devError(error),
    });
  }
});

router.get('/calendar/events', async (req, res) => {
  const userId = Number(req.headers['x-user-id']);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const timeMinRaw = normalizeText(req.query?.timeMin);
  const timeMaxRaw = normalizeText(req.query?.timeMax);
  const maxResultsRaw = normalizeText(req.query?.maxResults);

  const parseIsoDate = (value, label) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      const error = new Error(`Invalid ${label}. Use an ISO-8601 timestamp.`);
      error.statusCode = 400;
      throw error;
    }
    return parsed.toISOString();
  };

  let timeMin;
  let timeMax;

  try {
    timeMin = parseIsoDate(timeMinRaw, 'timeMin');
    timeMax = parseIsoDate(timeMaxRaw, 'timeMax');
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Invalid date range.' });
  }

  if (timeMin && timeMax && new Date(timeMin).getTime() > new Date(timeMax).getTime()) {
    return res.status(400).json({ message: 'timeMin must be less than or equal to timeMax.' });
  }

  let maxResults = 25;
  if (maxResultsRaw) {
    const parsed = Number(maxResultsRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 250) {
      return res.status(400).json({ message: 'maxResults must be an integer between 1 and 250.' });
    }
    maxResults = parsed;
  }

  try {
    const user = await getGoogleCalendarTokensByUserId(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (
      !normalizeText(user.google_refresh_iv) ||
      !normalizeText(user.google_refresh_ciphertext) ||
      !normalizeText(user.google_refresh_tag)
    ) {
      return res.status(401).json({ message: 'Google Calendar is not connected.' });
    }

    const decryptedRefreshToken = decryptGoogleRefreshToken({
      iv: user.google_refresh_iv,
      ciphertext: user.google_refresh_ciphertext,
      tag: user.google_refresh_tag,
    });

    if (!decryptedRefreshToken) {
      return res.status(401).json({ message: 'Google Calendar is not connected.' });
    }

    const calendarResult = await fetchCalendarEvents({
      refreshToken: decryptedRefreshToken,
      timeMin,
      timeMax,
      maxResults,
    });

    await persistGoogleTokensForUser({
      userId,
      refreshToken: null,
      accessTokenExpiry: calendarResult.accessTokenExpiry,
    });

    return res.json({
      events: calendarResult.events,
      nextPageToken: calendarResult.nextPageToken || null,
    });
  } catch (error) {
    if (
      error?.code === 'google-refresh-invalid' ||
      error?.code === 'google-not-connected' ||
      error?.code === 'google-refresh-token-decrypt-failed'
    ) {
      try {
        await clearGoogleTokensForUser(userId);
      } catch (_clearTokenError) {
        // Token cleanup failure should not mask the intended auth response.
      }
      return res.status(401).json({ message: 'Google Calendar is not connected.' });
    }

    if (error?.statusCode === 502) {
      return res.status(502).json({ message: 'Google Calendar provider unavailable.' });
    }

    if (error?.statusCode === 400) {
      return res.status(400).json({ message: error.message || 'Invalid calendar query.' });
    }

    console.error('[auth-service] calendar events fetch failed', {
      userId,
      code: error?.code,
      statusCode: error?.statusCode,
      message: error?.message,
    });
    return res.status(500).json({
      message: 'Unable to fetch Google Calendar events.',
      error: devError(error),
    });
  }
});

// Google OAuth
router.get('/auth/google', (req, res, next) => {
  if (!ensureGoogleConfigured({ passport, res })) return undefined;
  setGoogleOauthSessionMode(req, GOOGLE_OAUTH_MODE_LOGIN);

  return passport.authenticate('google', {
    scope: GOOGLE_LOGIN_SCOPES,
    session: false,
    state: true,
  })(req, res, next);
});

router.get('/auth/google/calendar', (req, res, next) => {
  if (!ensureGoogleConfigured({ passport, res })) return undefined;

  const userId = Number(req.headers['x-user-id']);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  setGoogleOauthSessionMode(req, GOOGLE_OAUTH_MODE_CALENDAR, userId);

  return passport.authenticate('google', {
    scope: GOOGLE_CALENDAR_SCOPES,
    accessType: 'offline',
    prompt: 'consent',
    includeGrantedScopes: true,
    session: false,
    state: true,
  })(req, res, next);
});

router.get('/auth/google/callback', (req, res, next) => {
  if (!ensureGoogleConfigured({ passport, res })) return undefined;

  return passport.authenticate('google', { session: false }, async (error, oauthPayload) => {
    const { mode, calendarUserId } = consumeGoogleOauthSessionMode(req);
    const oauthMode = normalizeText(oauthPayload?.oauthMode || mode).toLowerCase() || GOOGLE_OAUTH_MODE_LOGIN;

    if (error || !oauthPayload) {
      const reason = normalizeText(error?.code || error?.message) || 'oauth_failed';

      if (oauthMode === GOOGLE_OAUTH_MODE_CALENDAR) {
        const target = `${FRONTEND_ORIGIN}/profile?calendar=error&reason=${encodeURIComponent(reason)}`;
        return res.redirect(target);
      }

      const target = `${FRONTEND_ORIGIN}/?oauth=error&reason=${encodeURIComponent(reason)}`;
      return res.redirect(target);
    }

    if (oauthMode === GOOGLE_OAUTH_MODE_CALENDAR) {
      if (!calendarUserId) {
        const target = `${FRONTEND_ORIGIN}/profile?calendar=error&reason=missing_session_user`;
        return res.redirect(target);
      }

      try {
        await persistGoogleTokensForUser({
          userId: calendarUserId,
          refreshToken: oauthPayload.refreshToken,
          accessTokenExpiry: normalizeText(oauthPayload.accessToken)
            ? estimateGoogleAccessTokenExpiry()
            : null,
        });

        return res.redirect(`${FRONTEND_ORIGIN}/profile?calendar=connected`);
      } catch (_tokenError) {
        const target = `${FRONTEND_ORIGIN}/profile?calendar=error&reason=token_persist_failed`;
        return res.redirect(target);
      }
    }

    const user = oauthPayload.user || oauthPayload;
    if (!user?.id) {
      const target = `${FRONTEND_ORIGIN}/?oauth=error&reason=oauth_user_missing`;
      return res.redirect(target);
    }

    try {
      const { accessToken, refreshToken } = await issueTokens(user);
      setAccessCookie(res, accessToken);
      setRefreshCookie(res, refreshToken);
      const target = `${FRONTEND_ORIGIN}/`;
      return res.redirect(target);
    } catch (_tokenError) {
      const target = `${FRONTEND_ORIGIN}/?oauth=error&reason=token_failed`;
      return res.redirect(target);
    }
  })(req, res, next);
});

module.exports = router;
