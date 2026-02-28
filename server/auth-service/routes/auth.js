const express = require('express');
const { query } = require('../../db/client');
const {
  issueTokens,
  verifyRefreshToken,
  verifyAccessToken,
  REFRESH_TTL_SECONDS,
} = require('../services/tokenService');

const router = express.Router();

const setRefreshCookie = (res, refreshToken) => {
  res.cookie('meetai_refresh', refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
};

const buildUser = (user) => ({
  id: user.id,
  username: user.username,
  name: user.name,
});

const getUserByUsername = async (username) => {
  try {
    const result = await query(
      `SELECT id, name, user_name AS username, password
       FROM users
       WHERE user_name = $1
       LIMIT 1`,
      [username],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (!String(error.message || '').toLowerCase().includes('column "user_name" does not exist')) {
      throw error;
    }

    const fallback = await query(
      `SELECT id, name, username, password
       FROM users
       WHERE username = $1
       LIMIT 1`,
      [username],
    );
    return fallback.rows[0] || null;
  }
};

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const user = await getUserByUsername(username);

  if (!user || user.password !== password) {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  return issueTokens(user)
    .then(({ accessToken, refreshToken }) => {
      setRefreshCookie(res, refreshToken);
      return res.json({ token: accessToken, user: buildUser(user) });
    })
    .catch(() => res.status(500).json({ message: 'Login failed' }));
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
      setRefreshCookie(res, newRefreshToken);
      return res.json({
        token: accessToken,
        user: buildUser({ id: payload.sub, username: payload.username, name: payload.name }),
      });
    })
    .catch(() => res.status(401).json({ message: 'Unauthorized' }));
});

router.post('/verify', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return verifyAccessToken(token)
    .then((payload) => res.json({ user: buildUser(payload) }))
    .catch((error) => {
      if (error.name === 'TokenExpiredError') {
        const refreshToken = req.cookies?.meetai_refresh;
        if (!refreshToken) {
          return res.status(401).json({ message: 'Unauthorized' });
        }
        return verifyRefreshToken(refreshToken)
          .then((refreshPayload) =>
            issueTokens({
              id: refreshPayload.sub,
              username: refreshPayload.username,
              name: refreshPayload.name,
            }).then(({ accessToken, refreshToken: newRefreshToken }) => ({
              refreshPayload,
              accessToken,
              newRefreshToken,
            })),
          )
          .then(({ refreshPayload, accessToken, newRefreshToken }) => {
            setRefreshCookie(res, newRefreshToken);
            res.set('x-access-token', accessToken);
            return res.json({ user: buildUser(refreshPayload) });
          })
          .catch(() => res.status(401).json({ message: 'Unauthorized' }));
      }
      return res.status(401).json({ message: 'Unauthorized' });
    });
});

module.exports = router;
