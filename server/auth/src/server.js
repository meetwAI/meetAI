const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('passport');
const { requireEnv, requireNumberEnv } = require('@meetai/shared/env');
const { pool } = require('@meetai/shared/db');
const { installShutdown } = require('@meetai/shared/shutdown');
const authRoutes = require('./routes/auth');
const fs = require('fs');
const https = require('https');
const os = require('os');

const PORT = requireNumberEnv('AUTH_PORT');
const FRONTEND_ORIGIN = requireEnv('FRONTEND_ORIGIN');
const SESSION_SECRET = requireEnv('SESSION_SECRET')
const useHttps = process.env.AUTH_USE_HTTPS === 'true';
const app = express();
app.use(
  cors({
    origin: [FRONTEND_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST'],
  }),
);
app.use(cookieParser());
app.set('trust proxy', 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
    },
  }),
);
app.use(passport.initialize());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/', authRoutes);

let server;
if (useHttps) {
  server = https
    .createServer(
      {
        key: fs.readFileSync('localhost-key.pem'),
        cert: fs.readFileSync('localhost.pem'),
      },
      app
    )
    .listen(PORT, () => {
      console.log(`HTTPS Auth service on https://localhost:${PORT} (hosted on ${os.hostname()})`);
    });
} else {
  server = app.listen(PORT, () => {
    console.log(`HTTP Auth service on http://localhost:${PORT} (hosted on ${os.hostname()})`);
  });
}

installShutdown(server, { pool });