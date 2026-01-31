import { useMemo, useState } from 'react';

const mockMeetings = [
  {
    id: 'm-001',
    title: 'Weekly Product Sync',
    date: 'Jan 27, 2026',
    summary:
      'Reviewed sprint progress, clarified scope for onboarding flow, and aligned on launch risks.',
    participants: ['Ava', 'Nia', 'Zane', 'Ishaan'],
    messages: [
      {
        id: 'msg-001',
        role: 'user',
        text: 'Can you summarize the key launch risks from today?',
        time: '10:04 AM',
      },
      {
        id: 'msg-002',
        role: 'assistant',
        text: 'Top risks: API latency under load, missing analytics events, and dependency on external auth provider.',
        time: '10:04 AM',
      },
      {
        id: 'msg-003',
        role: 'user',
        text: 'Add an action item for the auth provider contingency plan.',
        time: '10:05 AM',
      },
      {
        id: 'msg-004',
        role: 'assistant',
        text: 'Action item added: Draft fallback auth flow and update runbook by Friday.',
        time: '10:05 AM',
      },
    ],
  },
  {
    id: 'm-002',
    title: 'Design Review — Dashboard',
    date: 'Jan 24, 2026',
    summary:
      'Validated card hierarchy, agreed on data density guidelines, and flagged missing empty states.',
    participants: ['Maya', 'Ravi', 'Leah'],
    messages: [
      {
        id: 'msg-005',
        role: 'user',
        text: 'What were the top UX issues discussed?',
        time: '3:18 PM',
      },
      {
        id: 'msg-006',
        role: 'assistant',
        text: 'Primary issues: unclear filter affordance, inconsistent metric labeling, and no loading skeleton.',
        time: '3:18 PM',
      },
      {
        id: 'msg-007',
        role: 'assistant',
        text: 'Suggested fix: add a filter chip bar and reserve a right rail for insights.',
        time: '3:19 PM',
      },
    ],
  },
  {
    id: 'm-003',
    title: 'Customer Feedback Debrief',
    date: 'Jan 21, 2026',
    summary:
      'Top themes: faster search, export options, and clearer ownership of action items.',
    participants: ['Noah', 'Elena', 'Priya'],
    messages: [
      {
        id: 'msg-008',
        role: 'user',
        text: 'Any recurring requests worth prioritizing?',
        time: '1:41 PM',
      },
      {
        id: 'msg-009',
        role: 'assistant',
        text: 'Recurring: CSV export, filter by owner, and quick search with recent queries.',
        time: '1:41 PM',
      },
      {
        id: 'msg-010',
        role: 'assistant',
        text: 'Recommend adding export + search improvements to Q1 roadmap.',
        time: '1:42 PM',
      },
    ],
  },
];

export default function PreviousMeetings() {
  const [selectedId, setSelectedId] = useState(mockMeetings[0]?.id ?? null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);

  const selectedMeeting = useMemo(
    () => mockMeetings.find((meeting) => meeting.id === selectedId),
    [selectedId]
  );

  return (
    <div className="previous-meetings">
      <section className="meeting-list">
        <div className="meeting-list-header">
          <h2>Previous Meetings</h2>
          <p>Click a meeting to review the recap and conversation.</p>
        </div>

        <div className="meeting-cards">
          {mockMeetings.map((meeting) => (
            <button
              key={meeting.id}
              type="button"
              className={`meeting-card${meeting.id === selectedId ? ' active' : ''}`}
              onClick={() => {
                setSelectedId(meeting.id);
                setShowAttachMenu(false);
              }}
            >
              <div className="meeting-card-header">
                <h3>{meeting.title}</h3>
                <span className="meeting-date">{meeting.date}</span>
              </div>
              <p className="meeting-summary">{meeting.summary}</p>
              <div className="meeting-meta">
                <span>{meeting.participants.length} participants</span>
                <span>View conversation</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="meeting-detail">
        {selectedMeeting ? (
          <>
            <header className="meeting-detail-header">
              <div>
                <h2>{selectedMeeting.title}</h2>
                <p className="meeting-detail-date">{selectedMeeting.date}</p>
              </div>
              <div className="meeting-tags">
                {selectedMeeting.participants.map((name) => (
                  <span key={name} className="meeting-tag">
                    {name}
                  </span>
                ))}
              </div>
            </header>

            <div className="meeting-detail-summary">
              <h4>Summary</h4>
              <p>{selectedMeeting.summary}</p>
            </div>

            <div className="meeting-messages">
              {selectedMeeting.messages.map((message) => (
                <div
                  key={message.id}
                  className={`message-row ${message.role === 'assistant' ? 'assistant' : 'user'}`}
                >
                  <div className="message-bubble">
                    <p>{message.text}</p>
                    <span className="message-time">{message.time}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="meeting-input">
              <button
                type="button"
                className="attach-button"
                onClick={() => setShowAttachMenu((prev) => !prev)}
                aria-label="Open attachments"
              >
                +
              </button>
              {showAttachMenu && (
                <div className="attach-popup">
                  <button type="button">Upload file</button>
                  <button type="button">Add note</button>
                  <button type="button">Schedule follow-up</button>
                </div>
              )}
              <input
                type="text"
                placeholder="Ask a question about this meeting..."
              />
              <button type="button" className="send-button">
                Send
              </button>
            </div>
          </>
        ) : (
          <div className="meeting-empty">
            <h2>Select a meeting</h2>
            <p>Choose a meeting card to see the recap and messages.</p>
          </div>
        )}
      </section>
    </div>
  );
}