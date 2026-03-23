const API_BASE_URL = 'http://localhost:4010';

const refreshAccessToken = async () => {
  const response = await fetch(`${API_BASE_URL}/refresh`, {
    method: 'POST',
    credentials: 'include',
  });

  return response.ok;
};

export const fetchWithAuth = async (path, options = {}, attempt = 0) => {
  const headers = new Headers(options.headers || {});

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

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
