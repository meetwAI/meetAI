const API_BASE_URL = 'http://localhost:4010';

const setAccessToken = (token) => {
  if (token) {
    localStorage.setItem('meetai_token', token);
  }
};

const getAccessToken = () => localStorage.getItem('meetai_token');

const refreshAccessToken = async () => {
  const response = await fetch(`${API_BASE_URL}/refresh`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  const token = payload?.token || null;
  setAccessToken(token);
  return token;
};

export const fetchWithAuth = async (path, options = {}, attempt = 0) => {
  const token = getAccessToken();
  const headers = new Headers(options.headers || {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  const nextAccessToken = response.headers.get('x-access-token');
  if (nextAccessToken) {
    setAccessToken(nextAccessToken);
  }

  if (response.status === 401 && attempt === 0) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return fetchWithAuth(path, options, attempt + 1);
    }
  }

  if (!response.ok) {
    const error = new Error('Request failed');
    error.status = response.status;
    error.response = response;
    throw error;
  }

  return response;
};
