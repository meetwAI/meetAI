const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const requireEnv = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) {
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