const { requireEnv } = require('../../config/env');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const normalizeText = (value) => String(value || '').trim();

class GoogleCalendarServiceError extends Error {
  constructor(message, { code, statusCode } = {}) {
    super(message);
    this.name = 'GoogleCalendarServiceError';
    this.code = code || 'google-calendar-service-error';
    this.statusCode = statusCode || 500;
  }
}

const getGoogleClientConfig = () => ({
  clientId: normalizeText(requireEnv('GOOGLE_CLIENT_ID')),
  clientSecret: normalizeText(requireEnv('GOOGLE_CLIENT_SECRET')),
});

const parseJsonSafely = async (response) => {
  try {
    return await response.json();
  } catch (_error) {
    return {};
  }
};

const refreshGoogleAccessToken = async (refreshToken) => {
  const normalizedRefreshToken = normalizeText(refreshToken);
  if (!normalizedRefreshToken) {
    throw new GoogleCalendarServiceError('Google Calendar is not connected.', {
      code: 'google-not-connected',
      statusCode: 401,
    });
  }

  const { clientId, clientSecret } = getGoogleClientConfig();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: normalizedRefreshToken,
    grant_type: 'refresh_token',
  });

  let tokenResponse;
  try {
    tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (_error) {
    throw new GoogleCalendarServiceError('Google token endpoint is unavailable.', {
      code: 'google-token-network-failure',
      statusCode: 502,
    });
  }

  const payload = await parseJsonSafely(tokenResponse);

  if (!tokenResponse.ok) {
    if (payload?.error === 'invalid_grant') {
      throw new GoogleCalendarServiceError('Google refresh token is no longer valid.', {
        code: 'google-refresh-invalid',
        statusCode: 401,
      });
    }

    throw new GoogleCalendarServiceError('Google token refresh failed.', {
      code: 'google-token-refresh-failed',
      statusCode: 502,
    });
  }

  const accessToken = normalizeText(payload?.access_token);
  if (!accessToken) {
    throw new GoogleCalendarServiceError('Google token refresh returned no access token.', {
      code: 'google-token-missing',
      statusCode: 502,
    });
  }

  const expiresInSeconds = Number(payload?.expires_in);
  const ttlSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  const accessTokenExpiry = new Date(Date.now() + Math.max(ttlSeconds - 60, 60) * 1000);

  return {
    accessToken,
    accessTokenExpiry,
  };
};

const normalizeEventDate = (value) => ({
  dateTime: normalizeText(value?.dateTime) || null,
  date: normalizeText(value?.date) || null,
  timeZone: normalizeText(value?.timeZone) || null,
});

const normalizeEvent = (event) => {
  const start = normalizeEventDate(event?.start);
  const end = normalizeEventDate(event?.end);

  return {
    id: normalizeText(event?.id) || null,
    status: normalizeText(event?.status) || null,
    summary: normalizeText(event?.summary) || null,
    description: normalizeText(event?.description) || null,
    location: normalizeText(event?.location) || null,
    htmlLink: normalizeText(event?.htmlLink) || null,
    start,
    end,
    isAllDay: Boolean(start.date && !start.dateTime),
    creatorEmail: normalizeText(event?.creator?.email) || null,
    organizerEmail: normalizeText(event?.organizer?.email) || null,
  };
};

const listGoogleCalendarEvents = async ({ accessToken, timeMin, timeMax, maxResults }) => {
  const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(maxResults || 25));

  if (timeMin) {
    url.searchParams.set('timeMin', timeMin);
  }
  if (timeMax) {
    url.searchParams.set('timeMax', timeMax);
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (_error) {
    throw new GoogleCalendarServiceError('Google Calendar API is unavailable.', {
      code: 'google-calendar-network-failure',
      statusCode: 502,
    });
  }

  const payload = await parseJsonSafely(response);

  if (!response.ok) {
    throw new GoogleCalendarServiceError('Google Calendar API request failed.', {
      code: 'google-calendar-fetch-failed',
      statusCode: 502,
    });
  }

  const events = Array.isArray(payload?.items) ? payload.items.map(normalizeEvent) : [];

  return {
    events,
    nextPageToken: normalizeText(payload?.nextPageToken) || null,
  };
};

const fetchCalendarEvents = async ({ refreshToken, timeMin, timeMax, maxResults }) => {
  const refreshed = await refreshGoogleAccessToken(refreshToken);
  const eventsResult = await listGoogleCalendarEvents({
    accessToken: refreshed.accessToken,
    timeMin,
    timeMax,
    maxResults,
  });

  return {
    ...eventsResult,
    accessTokenExpiry: refreshed.accessTokenExpiry,
  };
};

module.exports = {
  fetchCalendarEvents,
  GoogleCalendarServiceError,
};
