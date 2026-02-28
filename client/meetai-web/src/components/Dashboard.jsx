import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchWithAuth } from '../api/fetchWithAuth';
import moment from 'moment';

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

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p>Here’s a quick look at your latest meetings.</p>
        </div>
      </header>

      <section className="dashboard-section">
        <div className="section-title">
          <h2>Last 3 meetings</h2>
          <span>Quick recap</span>
        </div>
        <div className="recap-cards">
          {isLoading && <p>Loading meetings…</p>}
          {!isLoading && recentMeetings.map((meeting) => (
            <article key={meeting.id} className="recap-card">
              <div>
                <h3>{meeting.title}</h3>
                <p className="recap-date">{meeting.date}</p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => navigate(`/meetings/${meeting.id}`)}
              >
                Open recap
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-title">
          <h2>Analytics</h2>
          <span>This week</span>
        </div>
        <div className="analytics-grid">
          {analytics.map((item) => (
            <article key={item.id} className="analytics-card">
              <p className="analytics-label">{item.label}</p>
              <h3>{item.value}</h3>
              <p className="analytics-subtext">{item.subtext}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}