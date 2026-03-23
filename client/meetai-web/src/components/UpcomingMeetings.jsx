import React, { useState, useEffect } from 'react';
import '../styles/PreviousMeetings.css';

export default function UpcomingMeetings() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // The access token obtained from Google OAuth (usually after the user authenticates).
  // For demonstration, we assume it's stored in localStorage, but you should pass it via state/context.
  const token = localStorage.getItem('google_access_token');

  useEffect(() => {
    // If we don't have a token, we don't attempt to fetch
    if (!token) return;

    const fetchCalendarEvents = async () => {
      setLoading(true);
      setError('');
      try {
        const timeMin = new Date().toISOString();
        // Optional: fetch events for the next 7 days
        const timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        
        // Google Calendar API Endpoint (Requires 'https://www.googleapis.com/auth/calendar.readonly' scope)
        const response = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
            },
          }
        );

        if (!response.ok) {
          throw new Error('Failed to fetch calendar events from Google API');
        }

        const data = await response.json();
        
        // Filter out events that actually have a meeting link (Zoom, Meet, Teams, etc.)
        const meetingEvents = (data.items || []).filter(event => {
          const location = event.location || '';
          const description = event.description || '';
          const hangoutLink = event.hangoutLink || '';
          
          const hasMeetingLink = 
            hangoutLink.includes('meet.google.com') ||
            location.includes('zoom.us') || description.includes('zoom.us') ||
            location.includes('teams.microsoft.com') || description.includes('teams.microsoft.com');

          return hasMeetingLink;
        });

        setEvents(meetingEvents);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchCalendarEvents();
  }, [token]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Upcoming Meetings</h1>
          <p>Your scheduled meetings from Google Calendar</p>
        </div>
      </header>

      <section className="dashboard-section">
        {!token && (
          <div className="alert alert-warning">
            Please connect your Google Account to view your upcoming meetings.
          </div>
        )}

        {loading && <p>Loading calendar events...</p>}
        {error && <p className="text-danger">{error}</p>}
        
        {token && !loading && !error && events.length === 0 && (
          <p>No upcoming meetings found with a Zoom or Google Meet link in the next 7 days.</p>
        )}

        <div className="recap-cards mt-4">
          {events.map((event, index) => {
            const startTime = new Date(event.start.dateTime || event.start.date);
            const formattedDate = startTime.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            const formattedTime = startTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            
            // Try to gently extract the meeting link for the "Join" button
            let meetingLink = event.hangoutLink || event.location;
            if (!meetingLink?.startsWith('http')) {
              // Extraction from description if location is not a direct API link
              const urlRegex = /(https?:\/\/[^\s]+)/g;
              const matches = (event.description || '').match(urlRegex);
              meetingLink = matches ? matches[0] : null;
            }

            return (
              <article key={event.id} className="recap-card" style={{ animation: `fadeIn 0.5s ease-out ${index * 0.1}s both` }}>
                <div>
                  <h3 className="mb-1">{event.summary || 'Untitled Event'}</h3>
                  <p className="recap-date text-secondary">{formattedDate} • {formattedTime}</p>
                </div>
                {meetingLink ? (
                  <a
                    href={meetingLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-button text-primary fw-bold"
                    style={{ textDecoration: 'none' }}
                  >
                    Join Meeting
                  </a>
                ) : (
                  <span className="text-secondary small">No Link Found</span>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
