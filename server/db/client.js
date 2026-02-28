const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://meetai:meetai_pass@localhost:5432/meetai_dev';

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
