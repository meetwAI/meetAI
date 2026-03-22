const express = require('express');
const { query } = require('../../db/client');
const {
  issueTokens,
  verifyRefreshToken,
  verifyAccessToken,
  revokeToken,
  JWT_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
} = require('../services/tokenService');
const { hashPassword, verifyPassword, isPasswordHash } = require('../services/passwordService');

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
});

const normalizeText = (value) => String(value || '').trim();
const isDevelopment = process.env.NODE_ENV !== 'production';

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
    `SELECT id, name, username, password
     FROM users
     WHERE username = $1
     LIMIT 1`,
    [username],
  );
  return result.rows[0] || null;
};

const createUser = async ({ name, email, username, passwordHash }) => {
  const result = await query(
    `INSERT INTO users (name, email, username, password)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, username`,
    [name, email, username, passwordHash],
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

router.post('/refresh', (req, res) => {
  const refreshToken = req.cookies?.meetai_refresh;
  if (!refreshToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return verifyRefreshToken(refreshToken)
    .then((payload) =>
      issueTokens({ id: payload.sub, username: payload.username, name: payload.name }).then(
        ({ accessToken, refreshToken: newRefreshToken }) => ({
          payload,
          accessToken,
          newRefreshToken,
        }),
      ),
    )
    .then(({ payload, accessToken, newRefreshToken }) => {
      setAccessCookie(res, accessToken);
      setRefreshCookie(res, newRefreshToken);
      return res.json({
        user: buildUser({ id: payload.sub, username: payload.username, name: payload.name }),
      });
    })
    .catch(() => res.status(401).json({ message: 'Unauthorized' }));
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

  try {
    await Promise.all([
      revokeToken(accessToken, 'access'),
      revokeToken(refreshToken, 'refresh'),
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

module.exports = router;
