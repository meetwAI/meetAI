// QA cache + speaker-cap constants shared by gateway and meetings.
// Previously duplicated as literals in gateway/app.js and meeting-service/index.js.

// How long a cached meeting QA response stays valid (seconds).
const MEETING_QA_CACHE_TTL_SECONDS = 300;

// Redis key prefix for cached meeting QA responses.
const MEETING_QA_CACHE_PREFIX = 'meeting:qa:';

// Max distinct speakers we surface per meeting in QA / speaker-map flows.
const MEETING_QA_MAX_SPEAKERS = 4;

module.exports = {
  MEETING_QA_CACHE_TTL_SECONDS,
  MEETING_QA_CACHE_PREFIX,
  MEETING_QA_MAX_SPEAKERS,
};
