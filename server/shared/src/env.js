const path = require('path');
const dotenv = require('dotenv');

// shared/src/ → server/.env is two levels up (../../.env from this file).
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const requireEnv = (name) => {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') {
    throw new Error(`[env] Missing required environment variable: ${name}`);
  }
  return value;
};

const requireNumberEnv = (name) => {
  const rawValue = requireEnv(name);
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`[env] Environment variable ${name} must be a valid number.`);
  }
  return parsedValue;
};

module.exports = {
  requireEnv,
  requireNumberEnv,
};