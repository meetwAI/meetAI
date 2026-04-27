import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { disconnectSocket } from '../api/socketClient';
import { fetchWithAuth } from '../api/fetchWithAuth';

export default function Profile() {
  const API_URL = import.meta.env.VITE_AUTH_URL || import.meta.env.VITE_API_URL;
  const navigate = useNavigate();

  const user = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('meetai_user') || 'null');
    } catch {
      return null;
    }
  }, []);

  const [name, setName] = useState(user?.name || '');
  const [age, setAge] = useState(user?.age != null ? String(user.age) : '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [location, setLocation] = useState(user?.location || '');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarStatusLoading, setCalendarStatusLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const params = new URLSearchParams(window.location.search);
    const calendarState = params.get('calendar');
    const reason = params.get('reason');

    if (calendarState === 'connected') {
      setStatus('Google Calendar connected successfully.');
      setError('');
    }

    if (calendarState === 'error') {
      const normalizedReason = reason ? ` (${String(reason).replace(/_/g, ' ')})` : '';
      setError(`Failed to connect Google Calendar.${normalizedReason}`);
      setStatus('');
    }

    if (calendarState) {
      navigate('/profile', { replace: true });
    }

    const loadCalendarStatus = async () => {
      setCalendarStatusLoading(true);
      try {
        const response = await fetchWithAuth('/calendar/status');
        const payload = await response.json().catch(() => ({}));
        if (active) {
          setCalendarConnected(Boolean(payload?.connected));
        }
      } catch {
        if (active) {
          setCalendarConnected(false);
        }
      } finally {
        if (active) {
          setCalendarStatusLoading(false);
        }
      }
    };

    loadCalendarStatus();

    return () => {
      active = false;
    };
  }, [navigate]);

  const handleLogout = async () => {
    try {
      await fetch(`${API_URL}/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Proceed with local logout even if backend is unavailable.
    }

    try {
      disconnectSocket();
    } catch {
      // ignore
    }
    localStorage.removeItem('meetai_user');
    navigate('/login', { replace: true });
  };

  const handleSaveProfile = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    const normalizedAge = age === '' ? null : Number(age);
    if (age !== '' && (!Number.isFinite(normalizedAge) || normalizedAge < 0 || normalizedAge > 150)) {
      setError('Age must be a number between 0 and 150.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetchWithAuth('/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          age: normalizedAge,
          phone: phone.trim(),
          location: location.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      const updated = payload?.user || {};
      const mergedUser = {
        ...(user || {}),
        ...updated,
      };

      localStorage.setItem('meetai_user', JSON.stringify(mergedUser));
      setName(mergedUser?.name || '');
      setAge(mergedUser?.age != null ? String(mergedUser.age) : '');
      setPhone(mergedUser?.phone || '');
      setLocation(mergedUser?.location || '');
      setStatus('Profile updated successfully.');
    } catch (saveError) {
      let message = 'Failed to update profile.';
      const response = saveError?.response;
      if (response) {
        try {
          const payload = await response.json();
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Keep fallback message.
        }
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleConnectGoogleCalendar = () => {
    window.location.href = `${API_URL}/auth/google/calendar`;
  };

  return (
    <div className="profile-page" style={{ animation: 'fadeIn 0.5s ease-out both' }}>
      <div className="profile-header">
        <div>
          <h1>Profile</h1>
          <p>Manage your personal details.</p>
        </div>
        <button type="button" className="primary-button" onClick={handleLogout}>
          Log out
        </button>
      </div>

      <form className="profile-card" onSubmit={handleSaveProfile}>
        <div className="profile-grid">
          <label className="profile-field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your full name"
            />
          </label>

          <label className="profile-field">
            <span>Username</span>
            <input type="text" value={user?.username || ''} disabled readOnly />
          </label>

          <label className="profile-field">
            <span>Email</span>
            <input type="email" value={user?.email || 'Not available yet'} disabled readOnly />
          </label>

          <label className="profile-field">
            <span>Age</span>
            <input
              type="number"
              value={age}
              onChange={(event) => setAge(event.target.value)}
              min="0"
              max="150"
              placeholder="e.g. 28"
            />
          </label>

          <label className="profile-field">
            <span>Phone Number</span>
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="e.g. +1 555 000 0000"
            />
          </label>

          <label className="profile-field">
            <span>Location</span>
            <input
              type="text"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="City, Country"
            />
          </label>
        </div>

        {error ? <p className="profile-error">{error}</p> : null}
        {status ? <p className="profile-success">{status}</p> : null}

        <div className="profile-actions">
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>

      <section className="profile-card profile-calendar-card" aria-live="polite">
        <div className="profile-calendar-copy">
          <h2>Google Calendar Access</h2>
          <p>
            {calendarStatusLoading
              ? 'Checking Google Calendar connection...'
              : calendarConnected
                ? 'Connected. You can use calendar and meetings access when needed.'
                : 'Not connected yet. Connect when you are ready.'}
          </p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={handleConnectGoogleCalendar}
          disabled={calendarStatusLoading}
        >
          {calendarConnected ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
        </button>
      </section>
    </div>
  );
}
