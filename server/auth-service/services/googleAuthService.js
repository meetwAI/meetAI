const crypto = require('crypto');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const {
  getUserByUsername,
  getUserByEmail,
  getUserByGoogleIdHash,
  createUser,
  updateGoogleIdentityFields,
} = require('./userService');
const { hashGoogleId } = require('./googleSecretsService');

const normalizeText = (value) => String(value || '').trim();

const GOOGLE_CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_LOGIN_SCOPES = ['profile', 'email'];
const GOOGLE_CALENDAR_SCOPES = ['profile', 'email', GOOGLE_CALENDAR_READ_SCOPE];
const GOOGLE_OAUTH_MODE_LOGIN = 'login';
const GOOGLE_OAUTH_MODE_CALENDAR = 'calendar-connect';

// ---------------------------------------------------------------------------
// State parameter helpers (replaces session-based mode passing)
// The mode + calendarUserId are encoded into the OAuth `state` parameter so
// they survive the full browser round-trip through Google without requiring a
// session cookie that the gateway never forwards.
// ---------------------------------------------------------------------------

const buildGoogleOauthState = (mode, calendarUserId = null, redirectUrl = null, pkceVerifier = null) => {
  const payload = {
    mode,
    uid: calendarUserId ? String(calendarUserId) : null,
    redirect: redirectUrl || null,
    // NOTE: verifier is NOT embedded in the state string sent to Google.
    // It is stored server-side in activeOauthState keyed by the state string.
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
};

const parseGoogleOauthState = (stateStr) => {
  const raw = normalizeText(stateStr);
  if (!raw) return { mode: GOOGLE_OAUTH_MODE_LOGIN, calendarUserId: null, redirectUrl: null };

  try {
    // Try to decode as base64url first
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const mode = normalizeText(parsed?.mode).toLowerCase() || GOOGLE_OAUTH_MODE_LOGIN;
    const rawUid = parsed?.uid;
    const parsedUid = Number(rawUid);
    const calendarUserId = Number.isFinite(parsedUid) && parsedUid > 0 ? parsedUid : null;
    const redirectUrl = normalizeText(parsed?.redirect) || null;
    return { mode, calendarUserId, redirectUrl };
  } catch (_error) {
    // If base64url decoding fails, try parsing as JSON directly
    // This can happen when PKCE modifies the state format
    try {
      const parsed = JSON.parse(raw);
      const mode = normalizeText(parsed?.mode).toLowerCase() || GOOGLE_OAUTH_MODE_LOGIN;
      const rawUid = parsed?.uid;
      const parsedUid = Number(rawUid);
      const calendarUserId = Number.isFinite(parsedUid) && parsedUid > 0 ? parsedUid : null;
      const redirectUrl = normalizeText(parsed?.redirect) || null;
      return { mode, calendarUserId, redirectUrl };
    } catch (__error) {
      return { mode: GOOGLE_OAUTH_MODE_LOGIN, calendarUserId: null, redirectUrl: null };
    }
  }
};

const estimateGoogleAccessTokenExpiry = () => new Date(Date.now() + 55 * 60 * 1000);

// ---------------------------------------------------------------------------
// Session state helpers for OAuth flow
// These manage the OAuth state parameter through the Google redirect
// ---------------------------------------------------------------------------

let activeOauthState = new Map();

const generatePKCE = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const setGoogleOauthSessionMode = (req, mode, calendarUserId = null, redirectUrl = null) => {
  const state = buildGoogleOauthState(mode, calendarUserId, redirectUrl);
  const { verifier, challenge } = generatePKCE();
  activeOauthState.set(state, { mode, calendarUserId, redirectUrl, pkceVerifier: verifier, pkceChallenge: challenge, timestamp: Date.now() });

  // Clean up old states (older than 10 minutes)
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, value] of activeOauthState.entries()) {
    if (value.timestamp < cutoff) {
      activeOauthState.delete(key);
    }
  }

  return state;
};

const getPkceForState = (stateStr) => {
  const entry = activeOauthState.get(normalizeText(stateStr));
  return entry ? { verifier: entry.pkceVerifier, challenge: entry.pkceChallenge } : { verifier: null, challenge: null };
};

const consumeGoogleOauthSessionMode = (req) => {
  const stateStr = normalizeText(req.query?.state);
  if (!stateStr) {
    return { mode: GOOGLE_OAUTH_MODE_LOGIN, calendarUserId: null, redirectUrl: null };
  }

  const parsed = parseGoogleOauthState(stateStr);
  activeOauthState.delete(stateStr);
  return parsed;
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
  const googleIdHash = hashGoogleId(googleId);

  if (googleIdHash) {
    const existingByGoogle = await getUserByGoogleIdHash(googleIdHash);
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
    const avatarUrl = resolveGoogleProfileAvatar(profile);
    const nextGoogleIdHash = googleIdHash && !existing.google_id_hash ? googleIdHash : null;
    const nextAvatarUrl = avatarUrl && existing.avatar_url !== avatarUrl ? avatarUrl : null;

    if (nextGoogleIdHash || nextAvatarUrl) {
      await updateGoogleIdentityFields({
        userId: existing.id,
        googleIdHash: nextGoogleIdHash,
        avatarUrl: nextAvatarUrl,
      });

      return {
        ...existing,
        google_id_hash: nextGoogleIdHash || existing.google_id_hash,
        avatar_url: nextAvatarUrl || existing.avatar_url,
      };
    }

    return existing;
  }

  const name = resolveGoogleProfileName(profile);
  const username = await generateUniqueUsername(email);
  const avatarUrl = resolveGoogleProfileAvatar(profile);
  const user = await createUser({
    name,
    email,
    username,
    passwordHash: null,
    googleIdHash,
    avatarUrl,
  });

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

const ensureGoogleStrategy = (passport) => {
  if (googleStrategyReady) {
    console.log('[googleAuthService] Google Strategy already registered, reusing');
    return true;
  }
  const config = getGoogleConfig();
  if (!config) return false;

  console.log('[googleAuthService] Initializing Google Strategy');
  console.log('[googleAuthService] Client ID:', config.clientID?.substring(0, 10) + '...');
  console.log('[googleAuthService] Callback URL:', config.callbackURL);

  const strategy = new GoogleStrategy(
    {
      clientID: config.clientID,
      clientSecret: config.clientSecret,
      callbackURL: config.callbackURL,
      // Don't use passport's state management - we'll handle it ourselves
      state: false,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, params, profile, done) => {
      console.log('[googleAuthService] ========== PASSPORT STRATEGY CALLBACK INVOKED ==========');
      try {
        console.log('[googleAuthService] Passport callback invoked');
        const resolvedAccessToken = normalizeText(accessToken) || normalizeText(params?.access_token) || null;
        const resolvedRefreshToken = normalizeText(refreshToken) || normalizeText(params?.refresh_token) || null;
        console.log('[googleAuthService] Has accessToken:', !!resolvedAccessToken, 'Has refreshToken:', !!resolvedRefreshToken);
        console.log('[googleAuthService] State parameter:', req.query?.state);
        console.log('[googleAuthService] Profile ID:', profile?.id);

        // Read mode from state parameter — it survives the Google round-trip.
        // Passport puts the decoded state value in req.query.state.
        const { mode, calendarUserId, redirectUrl } = parseGoogleOauthState(req.query?.state);
        console.log('[googleAuthService] Parsed OAuth state - mode:', mode, 'userId:', calendarUserId, 'redirectUrl:', redirectUrl);

        if (mode === GOOGLE_OAUTH_MODE_CALENDAR) {
          console.log('[googleAuthService] Calendar mode - returning tokens');
          const payload = {
            oauthMode: GOOGLE_OAUTH_MODE_CALENDAR,
            accessToken: resolvedAccessToken,
            refreshToken: resolvedRefreshToken,
            calendarUserId,
            redirectUrl,
          };
          console.log('[googleAuthService] Calendar payload - accessToken:', !!payload.accessToken, 'refreshToken:', !!payload.refreshToken);
          return done(null, payload);
        }

        console.log('[googleAuthService] Login mode - finding/creating user');
        const user = await findOrCreateGoogleUser(profile);
        return done(null, {
          oauthMode: GOOGLE_OAUTH_MODE_LOGIN,
          user,
        });
      } catch (error) {
        console.error('[googleAuthService] Passport callback error:', error);
        return done(error);
      }
    },
  );

  const originalAuthorizationParams = strategy.authorizationParams.bind(strategy);
  strategy.authorizationParams = (options = {}) => {
    const params = originalAuthorizationParams(options);
    if (options.code_challenge) {
      params.code_challenge = options.code_challenge;
    }
    if (options.code_challenge_method) {
      params.code_challenge_method = options.code_challenge_method;
    }
    return params;
  };

  strategy.tokenParams = (options = {}) => {
    const params = {};
    if (options.codeVerifier) {
      params.code_verifier = options.codeVerifier;
    }
    return params;
  };

  // Add error handling to the strategy
  strategy.errorHandler = (error, req, res, next) => {
    console.error('[googleAuthService] Strategy error handler:', error);
    next(error);
  };

  passport.use(strategy);

  googleStrategyReady = true;
  console.log('[googleAuthService] Google Strategy registered successfully');
  return true;
};

const ensureGoogleConfigured = ({ passport, res }) => {
  if (ensureGoogleStrategy(passport)) return true;
  res.status(503).json({ message: 'Google auth is not configured.' });
  return false;
};

module.exports = {
  GOOGLE_LOGIN_SCOPES,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_MODE_LOGIN,
  GOOGLE_OAUTH_MODE_CALENDAR,
  ensureGoogleConfigured,
  buildGoogleOauthState,
  parseGoogleOauthState,
  estimateGoogleAccessTokenExpiry,
  setGoogleOauthSessionMode,
  consumeGoogleOauthSessionMode,
  getPkceForState,
  generatePKCE,
};
