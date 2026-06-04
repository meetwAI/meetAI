import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchWithAuth } from '../lib/http';
import moment from 'moment';
import './Dashboard.css';

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: recentMeetings = [], isLoading } = useQuery({
    queryKey: ['meetings', 'recent', 3],
    queryFn: async () => {
      const response = await fetchWithAuth('/meetings/recent?limit=3');
      const payload = await response.json();
      return Array.isArray(payload) ? payload : [];
    },
    staleTime: 10_000,
  });

  const analytics = useMemo(() => {
    const latest = recentMeetings[0];
    const totalMinutes = recentMeetings.reduce(
      (acc, meeting) => acc + (Number(meeting.durationMinutes) || 0),
      0,
    );
    const totalParticipants = recentMeetings.reduce(
      (acc, meeting) => acc + (Array.isArray(meeting.participants) ? meeting.participants.length : 0),
      0,
    );
    const avgParticipants = recentMeetings.length
      ? (totalParticipants / recentMeetings.length).toFixed(1)
      : '0.0';

    return [
      {
        id: 'metric-001',
        label: 'Last meeting duration',
        value: `${latest?.durationMinutes || 0} min`,
        subtext: latest ? `${moment(latest.date).format('DD-MMM-YYYY')} • ${latest.title}` : 'No meetings yet',
      },
      {
        id: 'metric-002',
        label: 'Total hours (latest 3)',
        value: `${(totalMinutes / 60).toFixed(1)} hrs`,
        subtext: `Across ${recentMeetings.length} meetings`,
      },
      {
        id: 'metric-003',
        label: 'Average participants',
        value: avgParticipants,
        subtext: 'Latest meetings',
      },
    ];
  }, [recentMeetings]);

  const formattedRecaps = useMemo(
    () => recentMeetings.map((meeting) => ({
      ...meeting,
      displayDate: meeting?.date ? moment(meeting.date).format('MMM DD, YYYY') : 'Unknown date',
    })),
    [recentMeetings],
  );

  return (
    <div className="dashboard-shell">
      <main className="dashboard-main">
        <section className="dashboard-intro">
          <h1 className="dashboard-title">Dashboard</h1>
          <p className="dashboard-subtitle">Here's a quick look at your latest meetings.</p>
        </section>

        <section className="dashboard-block">
          <div className="dashboard-block-header">
            <h2>Last 3 meetings</h2>
            <span>Quick recap</span>
          </div>
          <div className="meeting-grid">
            {isLoading && <p className="dashboard-muted">Loading meetings...</p>}
            {!isLoading && formattedRecaps.length === 0 && (
              <p className="dashboard-muted">No meetings yet. Start one from the top bar.</p>
            )}
            {!isLoading && formattedRecaps.map((meeting, index) => (
              <article
                key={meeting.id}
                className="meeting-card-v2"
                style={{ animationDelay: `${index * 0.08 + 0.1}s` }}
              >
                <div>
                  <h3 title={meeting.title}>{meeting.title || `Meeting ${meeting.id}`}</h3>
                  <p className="meeting-card-date">{meeting.displayDate}</p>
                </div>
                <button
                  type="button"
                  className="meeting-open-btn"
                  onClick={() => navigate(`/meetings/${meeting.id}`)}
                >
                  Open recap
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="dashboard-block">
          <div className="dashboard-block-header">
            <h2>Analytics</h2>
            <span>This week</span>
          </div>
          <div className="analytics-grid-v2">
            {analytics.map((item, index) => (
              <article
                key={item.id}
                className="analytics-card-v2"
                style={{ animationDelay: `${index * 0.08 + 0.1}s` }}
              >
                <p className="analytics-label-v2">{item.label}</p>
                <h3>{item.value}</h3>
                <p className="analytics-subtext-v2">{item.subtext}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="dashboard-footer">
        <div>© 2026 meetAI. All rights reserved.</div>
        <div className="dashboard-footer-links">
          <button type="button">Privacy Policy</button>
          <button type="button">Terms of Service</button>
        </div>
      </footer>
    </div>
  );
}