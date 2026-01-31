const { verifyAccessToken, verifyRefreshToken, issueTokens, REFRESH_TTL_SECONDS } = require('../services/tokenService');

const setRefreshCookie = (res, refreshToken) => {
  res.cookie('meetai_refresh', refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
};

const verifyAccessOrRefresh = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return verifyAccessToken(token)
    .then((payload) => {
      req.user = payload;
      return next();
    })
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
            }),
          )
          .then(({ accessToken, refreshToken: newRefreshToken }) => {
            setRefreshCookie(res, newRefreshToken);
            res.set('x-access-token', accessToken);
            req.user = refreshPayload;
            return next();
          })
          .catch(() => res.status(401).json({ message: 'Unauthorized' }));
      }
      return res.status(401).json({ message: 'Unauthorized' });
    });
};

module.exports = { verifyAccessOrRefresh };
