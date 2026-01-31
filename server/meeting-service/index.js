const http = require('http');
const express = require('express');
const cors = require('cors');
const { setupSocket } = require('./socket');
const { getDummyMeeting } = require('./meetingData');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 4001;
const JWT_SECRET = process.env.JWT_SECRET || 'meetai_dev_secret';

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
};

app.get('/meetings/dummy', requireAuth, (_req, res) => {
  res.json(getDummyMeeting());
});

const server = http.createServer(app);
setupSocket(server);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Meeting service listening on ${PORT}`);
});
