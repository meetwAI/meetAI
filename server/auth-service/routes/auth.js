const express = require('express');
const crypto = require('crypto');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { query } = require('../../db/client');
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
const GOOGLE_CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

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

const getUserByUsername = async (username) => {
  const result = await query(
    `SELECT id, name, username, password, email, google_id, avatar_url
     FROM users
     WHERE username = $1
     LIMIT 1`,
    [username],
  );
  return result.rows[0] || null;
};

const getUserByEmail = async (email) => {
  const result = await query(
    `SELECT id, name, username, password, email, google_id, avatar_url
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email],
  );
  return result.rows[0] || null;
};

const getUserByGoogleId = async (googleId) => {
  const result = await query(
    `SELECT id, name, username, password, email, google_id, avatar_url
     FROM users
     WHERE google_id = $1
     LIMIT 1`,
    [googleId],
  );
  return result.rows[0] || null;
};

const getGoogleCalendarTokensByUserId = async (userId) => {
  const result = await query(
    `SELECT id, google_refresh_token
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
};

const estimateGoogleAccessTokenExpiry = () => new Date(Date.now() + 55 * 60 * 1000);

const persistGoogleTokensForUser = async ({ userId, accessToken, refreshToken, accessTokenExpiry }) => {
  if (!userId) {
    return;
  }

  const normalizedAccessToken = normalizeText(accessToken) || null;
  const normalizedRefreshToken = normalizeText(refreshToken) || null;

  await query(
    `UPDATE users
     SET google_access_token = COALESCE($1, google_access_token),
         google_refresh_token = COALESCE($2, google_refresh_token),
         google_token_expiry = COALESCE($3, google_token_expiry)
     WHERE id = $4`,
    [normalizedAccessToken, normalizedRefreshToken, accessTokenExpiry || null, userId],
  );
};

const sanitizeUsernameBase = (value) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '');

const generateUniqueUsername = async (email) => {
  const localPart = String(email || '').split('@')[0] || 'user';
  const baseCandidate = sanitizeUsernameBase(localPart);
  const fallback = `user${crypto.randomBytes(3).toString('hex')}`;
  const base = (baseCandidate && baseCandidate.length >= 3 ? baseCandidate : fallback).slice(0, 24);

  if (!(await getUserByUsername(base))) {
    return base;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = crypto.randomBytes(2).toString('hex');
    const candidate = `${base}-${suffix}`;
    if (!(await getUserByUsername(candidate))) {
      return candidate;
    }
  }

  throw new Error('unable-to-generate-unique-username');
};

const resolveGoogleProfileEmail = (profile) => {
  const emails = Array.isArray(profile?.emails) ? profile.emails : [];
  const verified = emails.find((entry) => entry?.verified);
  return normalizeText(verified?.value || emails[0]?.value).toLowerCase();
};

const resolveGoogleProfileName = (profile) => {
  const displayName = normalizeText(profile?.displayName);
  if (displayName) return displayName;
  const givenName = normalizeText(profile?.name?.givenName);
  const familyName = normalizeText(profile?.name?.familyName);
  return normalizeText([givenName, familyName].filter(Boolean).join(' '));
};

const resolveGoogleProfileAvatar = (profile) => {
  const photos = Array.isArray(profile?.photos) ? profile.photos : [];
  return normalizeText(photos[0]?.value);
};

const isAllowedGoogleDomain = (email, profile) => {
  const allowedDomain = normalizeText(process.env.GOOGLE_ALLOWED_DOMAIN).toLowerCase();
  if (!allowedDomain) return true;
  const emailDomain = String(email || '').split('@')[1]?.toLowerCase() || '';
  const hostedDomain = normalizeText(profile?._json?.hd).toLowerCase();
  return emailDomain === allowedDomain || hostedDomain === allowedDomain;
};

const findOrCreateGoogleUser = async (profile) => {
  const googleId = normalizeText(profile?.id);
  if (googleId) {
    const existingByGoogle = await getUserByGoogleId(googleId);
    if (existingByGoogle) {
      return existingByGoogle;
    }
  }

  const email = resolveGoogleProfileEmail(profile);
  if (!email) {
    throw new Error('google-email-missing');
  }
  if (!isAllowedGoogleDomain(email, profile)) {
    const error = new Error('google-domain-not-allowed');
    error.code = 'google-domain-not-allowed';
    throw error;
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    const name = resolveGoogleProfileName(profile);
    const avatarUrl = resolveGoogleProfileAvatar(profile);
    const updates = [];
    const values = [];
    if (googleId && !existing.google_id) {
      updates.push(`google_id = $${values.length + 1}`);
      values.push(googleId);
    }
    if (avatarUrl && existing.avatar_url !== avatarUrl) {
      updates.push(`avatar_url = $${values.length + 1}`);
      values.push(avatarUrl);
    }
    if (updates.length) {
      values.push(existing.id);
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
      return {
        ...existing,
        name: existing.name,
        google_id: googleId || existing.google_id,
        avatar_url: avatarUrl || existing.avatar_url,
      };
    }
    return existing;
  }

  const name = resolveGoogleProfileName(profile);
  const username = await generateUniqueUsername(email);
  const avatarUrl = resolveGoogleProfileAvatar(profile);
  const user = await createUser({ name, email, username, passwordHash: null, googleId, avatarUrl });
  if (!user) {
    throw new Error('google-user-create-failed');
  }
  return user;
};

const getGoogleConfig = () => {
  const clientID = normalizeText(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = normalizeText(process.env.GOOGLE_CLIENT_SECRET);
  const callbackURL = normalizeText(process.env.GOOGLE_CALLBACK_URL);
  if (!clientID || !clientSecret || !callbackURL) {
    return null;
  }
  return { clientID, clientSecret, callbackURL };
};

let googleStrategyReady = false;

const ensureGoogleStrategy = () => {
  if (googleStrategyReady) return true;
  const config = getGoogleConfig();
  if (!config) return false;

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.clientID,
        clientSecret: config.clientSecret,
        callbackURL: config.callbackURL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const user = await findOrCreateGoogleUser(profile);
          await persistGoogleTokensForUser({
            userId: user.id,
            accessToken,
            refreshToken,
            accessTokenExpiry: normalizeText(accessToken) ? estimateGoogleAccessTokenExpiry() : null,
          });
          return done(null, user);
        } catch (error) {
          return done(error);
        }
      },
    ),
  );

  googleStrategyReady = true;
  return true;
};

const ensureGoogleConfigured = (res) => {
  if (ensureGoogleStrategy()) return true;
  res.status(503).json({ message: 'Google auth is not configured.' });
  return false;
};

const createUser = async ({ name, email, username, passwordHash, googleId, avatarUrl }) => {
  const result = await query(
    `INSERT INTO users (name, email, username, password, google_id, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, username, google_id, avatar_url`,
    [name, email, username, passwordHash, googleId || null, avatarUrl || null],
  );
  return result.rows[0] || null;
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
      await query('UPDATE users SET password = $1 WHERE id = $2', [upgradedPasswordHash, user.id]);
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
    const result = await query(
      `UPDATE users
       SET name     = COALESCE(NULLIF($1, ''), name),
           age      = COALESCE($2,            age),
           phone    = COALESCE($3,            phone),
           location = COALESCE($4,            location)
       WHERE id = $5
       RETURNING id, name, username, age, phone, location`,
      [name || null, age, phone, location, userId],
    );
    const row = result.rows[0];
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

    if (!normalizeText(user.google_refresh_token)) {
      return res.status(401).json({ message: 'Google Calendar is not connected.' });
    }

    const calendarResult = await fetchCalendarEvents({
      refreshToken: user.google_refresh_token,
      timeMin,
      timeMax,
      maxResults,
    });

    await query(
      `UPDATE users
       SET google_access_token = $1,
           google_token_expiry = $2
       WHERE id = $3`,
      [calendarResult.accessToken, calendarResult.accessTokenExpiry, userId],
    );

    return res.json({
      events: calendarResult.events,
      nextPageToken: calendarResult.nextPageToken || null,
    });
  } catch (error) {
    if (error?.code === 'google-refresh-invalid' || error?.code === 'google-not-connected') {
      try {
        await query(
          `UPDATE users
           SET google_refresh_token = NULL,
               google_access_token = NULL,
               google_token_expiry = NULL
           WHERE id = $1`,
          [userId],
        );
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
  if (!ensureGoogleConfigured(res)) return undefined;
  return passport.authenticate('google', {
    scope: ['profile', 'email', GOOGLE_CALENDAR_READ_SCOPE],
    accessType: 'offline',
    prompt: 'consent',
    session: false,
    state: true,
  })(req, res, next);
});

router.get('/auth/google/callback', (req, res, next) => {
  if (!ensureGoogleConfigured(res)) return undefined;

  return passport.authenticate('google', { session: false }, async (error, user) => {
    if (error || !user) {
      const reason = normalizeText(error?.code || error?.message) || 'oauth_failed';
      const target = `${FRONTEND_ORIGIN}/?oauth=error&reason=${encodeURIComponent(reason)}`;
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
