const express = require('express');
const path = require('path');
const fs = require('fs');
const {
  issueTokens,
  verifyRefreshToken,
  verifyAccessToken,
  REFRESH_TTL_SECONDS,
} = require('../services/tokenService');

const router = express.Router();
const USERS_PATH = path.join(__dirname, '..', '..', 'users.json');

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

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const raw = fs.readFileSync(USERS_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const user = data.users.find(
    (item) => item.username === username && item.password === password,
  );

  if (!user) {
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
