import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { disconnectSocket } from '../api/socketClient';
import { fetchWithAuth } from '../api/fetchWithAuth';
import {
  User,
  Mail,
  Phone,
  MapPin,
  Calendar,
  LogOut,
  Save,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Hash,
} from 'lucide-react';
import './Profile.css';

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
  const [calendarVerified, setCalendarVerified] = useState(false);
  const [calendarUnavailable, setCalendarUnavailable] = useState(false);
  const [calendarStatusTick, setCalendarStatusTick] = useState(0);
  const [isGoogleAccount, setIsGoogleAccount] = useState(false);

  useEffect(() => {
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
  }, [navigate]);

  useEffect(() => {
    let active = true;

    const loadCalendarStatus = async () => {
      setCalendarStatusLoading(true);
      setCalendarUnavailable(false);
      try {
        const response = await fetchWithAuth('/calendar/status?validate=1');
        const payload = await response.json().catch(() => ({}));
        if (active) {
          setCalendarConnected(Boolean(payload?.connected));
          setCalendarVerified(Boolean(payload?.verified));
          setCalendarUnavailable(Boolean(payload?.unavailable));
          setIsGoogleAccount(Boolean(payload?.isGoogleAccount));
        }
      } catch {
        if (active) {
          setCalendarConnected(false);
          setCalendarVerified(false);
          setCalendarUnavailable(true);
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
  }, [calendarStatusTick]);

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
    // Stay on profile page after connection
    window.location.href = `${API_URL}/auth/google/calendar?redirect=${encodeURIComponent('/profile')}`;
  };

  const handleRetryCalendarStatus = () => {
    setCalendarStatusTick((tick) => tick + 1);
  };

  const calendarMessage = calendarStatusLoading
    ? 'Checking Google Calendar access...'
    : calendarUnavailable
      ? 'Google Calendar is temporarily unreachable. Your connection may still be valid — try again shortly.'
      : calendarConnected && calendarVerified
        ? 'Connected. Calendar access verified.'
        : !calendarConnected && isGoogleAccount
          ? 'Your Google Calendar access has expired or been revoked. Reconnect to restore it.'
          : !calendarConnected
            ? 'Not connected yet. Connect when you are ready.'
            : 'Connected. Verifying access...';

  const shouldConnectCalendar = !calendarConnected && !calendarUnavailable;
  const shouldRetryCalendar = !calendarConnected && calendarUnavailable;
  const calendarActionLabel = calendarStatusLoading
    ? 'Checking...'
    : calendarConnected && calendarVerified
      ? 'Google Calendar connected'
      : calendarConnected
        ? 'Verifying access...'
        : shouldRetryCalendar
          ? 'Retry'
          : isGoogleAccount
            ? 'Reconnect Google Calendar'
            : 'Connect Google Calendar';
  const calendarActionHandler = shouldConnectCalendar
    ? handleConnectGoogleCalendar
    : shouldRetryCalendar
      ? handleRetryCalendarStatus
      : undefined;
  const calendarActionDisabled = calendarStatusLoading || calendarConnected;

  return (
    <div className="profile-container">
      <header className="profile-header-v2">
        <div className="profile-title-group">
          <h1>Profile</h1>
          <p>Manage your personal information and connections.</p>
        </div>
        <button type="button" className="logout-btn" onClick={handleLogout}>
          <LogOut size={18} />
          Log out
        </button>
      </header>

      <section className="profile-card-v2">
        <h2>
          <User size={20} className="text-primary" />
          Personal Details
        </h2>
        <form className="profile-form" onSubmit={handleSaveProfile}>
          <div className="profile-form-grid">
            <div className="input-group-v2">
              <label htmlFor="profile-name">Full Name</label>
              <div className="input-wrapper-v2">
                <User size={18} className="input-icon-v2" />
                <input
                  id="profile-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your full name"
                />
              </div>
            </div>

            <div className="input-group-v2">
              <label>Username</label>
              <div className="input-wrapper-v2">
                <Hash size={18} className="input-icon-v2" />
                <input type="text" value={user?.username || ''} disabled readOnly />
              </div>
            </div>

            <div className="input-group-v2">
              <label>Email Address</label>
              <div className="input-wrapper-v2">
                <Mail size={18} className="input-icon-v2" />
                <input type="email" value={user?.email || 'Not available'} disabled readOnly />
              </div>
            </div>

            <div className="input-group-v2">
              <label htmlFor="profile-age">Age</label>
              <div className="input-wrapper-v2">
                <Hash size={18} className="input-icon-v2" />
                <input
                  id="profile-age"
                  type="number"
                  value={age}
                  onChange={(event) => setAge(event.target.value)}
                  min="0"
                  max="150"
                  placeholder="e.g. 28"
                />
              </div>
            </div>

            <div className="input-group-v2">
              <label htmlFor="profile-phone">Phone Number</label>
              <div className="input-wrapper-v2">
                <Phone size={18} className="input-icon-v2" />
                <input
                  id="profile-phone"
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="e.g. +1 555 000 0000"
                />
              </div>
            </div>

            <div className="input-group-v2">
              <label htmlFor="profile-location">Location</label>
              <div className="input-wrapper-v2">
                <MapPin size={18} className="input-icon-v2" />
                <input
                  id="profile-location"
                  type="text"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="City, Country"
                />
              </div>
            </div>
          </div>

          <div className="profile-status-messages">
            {error && (
              <div className="status-msg error">
                <AlertCircle size={18} />
                {error}
              </div>
            )}
            {status && (
              <div className="status-msg success">
                <CheckCircle2 size={18} />
                {status}
              </div>
            )}
          </div>

          <div className="save-actions">
            <button type="submit" className="save-btn" disabled={saving}>
              {saving ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </form>
      </section>

      <section className="calendar-card-v2" aria-live="polite">
        <div className="calendar-info">
          <h2>
            <Calendar size={20} style={{ color: '#38bdf8', marginRight: '8px', verticalAlign: 'middle' }} />
            Google Calendar Access
          </h2>
          <p>{calendarMessage}</p>
        </div>
        <button
          type="button"
          className={`calendar-btn ${calendarConnected && calendarVerified ? 'connected' : 'connect'}`}
          onClick={calendarActionHandler}
          disabled={calendarActionDisabled}
        >
          {calendarStatusLoading ? (
            <RefreshCw size={18} className="animate-spin" />
          ) : calendarConnected && calendarVerified ? (
            <CheckCircle2 size={18} />
          ) : (
            <Calendar size={18} />
          )}
          {calendarActionLabel}
        </button>
      </section>
    </div>
  );
}
