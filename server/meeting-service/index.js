const http = require('http');
const express = require('express');
const cors = require('cors');
const { setupSocket } = require('./socket');
const { getDummyMeeting } = require('./meetingData');

const PORT = process.env.PORT || 4001;

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/meetings/dummy', (_req, res) => {
  res.json(getDummyMeeting());
});

const server = http.createServer(app);
setupSocket(server);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Meeting service listening on ${PORT}`);
});
