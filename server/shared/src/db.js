const { Pool } = require('pg');
const { requireEnv } = require('./env');

const connectionString = requireEnv('DATABASE_URL');

const pool = new Pool({
  connectionString,
});

pool.on('error', (error) => {
  console.error('[db] unexpected postgres error', error);
});

const query = (text, params = []) => pool.query(text, params);

module.exports = {
  pool,
  query,
};
