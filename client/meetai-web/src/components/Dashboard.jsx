const recentMeetings = [
  {
    id: 'rec-001',
    title: 'Weekly Product Sync',
    date: 'Jan 27, 2026',
    summary: 'Aligned on onboarding scope and confirmed launch risks.',
  },
  {
    id: 'rec-002',
    title: 'Design Review — Dashboard',
    date: 'Jan 24, 2026',
    summary: 'Validated hierarchy, defined data density guardrails.',
  },
  {
    id: 'rec-003',
    title: 'Customer Feedback Debrief',
    date: 'Jan 21, 2026',
    summary: 'Top themes: faster search, export options, ownership clarity.',
  },
];

const analytics = [
  {
    id: 'metric-001',
    label: 'Last meeting duration',
    value: '52 min',
    subtext: 'Jan 27, 2026 • Product Sync',
  },
  {
    id: 'metric-002',
    label: 'Total hours this week',
    value: '4.3 hrs',
    subtext: 'Across 6 meetings',
  },
  {
    id: 'metric-003',
    label: 'Average participants',
    value: '5.2',
    subtext: 'Last 7 days',
  },
];

export default function Dashboard() {
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
          {recentMeetings.map((meeting) => (
            <article key={meeting.id} className="recap-card">
              <div>
                <h3>{meeting.title}</h3>
                <p className="recap-date">{meeting.date}</p>
              </div>
              <p className="recap-summary">{meeting.summary}</p>
              <button type="button" className="text-button">
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