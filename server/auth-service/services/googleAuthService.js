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
const GOOGLE_OAUTH_MODE_SESSION_KEY = 'google_oauth_mode';
const GOOGLE_OAUTH_CALENDAR_USER_ID_SESSION_KEY = 'google_oauth_calendar_user_id';
const GOOGLE_OAUTH_MODE_LOGIN = 'login';
const GOOGLE_OAUTH_MODE_CALENDAR = 'calendar-connect';

const estimateGoogleAccessTokenExpiry = () => new Date(Date.now() + 55 * 60 * 1000);

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
  if (googleStrategyReady) return true;
  const config = getGoogleConfig();
  if (!config) return false;

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.clientID,
        clientSecret: config.clientSecret,
        callbackURL: config.callbackURL,
        state: true,
        pkce: true,
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const mode =
            normalizeText(req.session?.[GOOGLE_OAUTH_MODE_SESSION_KEY]).toLowerCase() ||
            GOOGLE_OAUTH_MODE_LOGIN;

          if (mode === GOOGLE_OAUTH_MODE_CALENDAR) {
            return done(null, {
              oauthMode: GOOGLE_OAUTH_MODE_CALENDAR,
              accessToken: normalizeText(accessToken) || null,
              refreshToken: normalizeText(refreshToken) || null,
            });
          }

          const user = await findOrCreateGoogleUser(profile);
          return done(null, {
            oauthMode: GOOGLE_OAUTH_MODE_LOGIN,
            user,
          });
        } catch (error) {
          return done(error);
        }
      },
    ),
  );

  googleStrategyReady = true;
  return true;
};

const ensureGoogleConfigured = ({ passport, res }) => {
  if (ensureGoogleStrategy(passport)) return true;
  res.status(503).json({ message: 'Google auth is not configured.' });
  return false;
};

const setGoogleOauthSessionMode = (req, mode, calendarUserId = null) => {
  if (!req.session) {
    return;
  }

  req.session[GOOGLE_OAUTH_MODE_SESSION_KEY] = mode;
  if (calendarUserId) {
    req.session[GOOGLE_OAUTH_CALENDAR_USER_ID_SESSION_KEY] = String(calendarUserId);
  } else {
    delete req.session[GOOGLE_OAUTH_CALENDAR_USER_ID_SESSION_KEY];
  }
};

const consumeGoogleOauthSessionMode = (req) => {
  const mode =
    normalizeText(req.session?.[GOOGLE_OAUTH_MODE_SESSION_KEY]).toLowerCase() || GOOGLE_OAUTH_MODE_LOGIN;
  const rawCalendarUserId = req.session?.[GOOGLE_OAUTH_CALENDAR_USER_ID_SESSION_KEY];

  if (req.session) {
    delete req.session[GOOGLE_OAUTH_MODE_SESSION_KEY];
    delete req.session[GOOGLE_OAUTH_CALENDAR_USER_ID_SESSION_KEY];
  }

  const parsedCalendarUserId = Number(rawCalendarUserId);
  const calendarUserId =
    Number.isFinite(parsedCalendarUserId) && parsedCalendarUserId > 0 ? parsedCalendarUserId : null;

  return {
    mode,
    calendarUserId,
  };
};

module.exports = {
  GOOGLE_LOGIN_SCOPES,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_MODE_LOGIN,
  GOOGLE_OAUTH_MODE_CALENDAR,
  ensureGoogleConfigured,
  setGoogleOauthSessionMode,
  consumeGoogleOauthSessionMode,
  estimateGoogleAccessTokenExpiry,
};
