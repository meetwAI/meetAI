const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('passport');
const { requireEnv, requireNumberEnv } = require('../config/env');
const authRoutes = require('./routes/auth');

const PORT = requireNumberEnv('AUTH_PORT');
const FRONTEND_ORIGIN = requireEnv('FRONTEND_ORIGIN');
const SESSION_SECRET = requireEnv('SESSION_SECRET');

const app = express();
app.use(
  cors({
    origin: [FRONTEND_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST'],
  }),
);
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  }),
);
app.use(passport.initialize());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/', authRoutes);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Auth service listening on ${PORT}`);
});
