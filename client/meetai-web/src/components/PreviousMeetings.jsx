import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '../api/fetchWithAuth';


export default function PreviousMeetings() {
  const [selectedId, setSelectedId] = useState(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);

  const {
    data: meetings = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['meetings', 'dummy'],
    queryFn: async () => {
      const response = await fetchWithAuth('/meetings/dummy');

      if (!response.ok) {
        if (response.status === 401) {
          const authError = new Error('Unauthorized');
          authError.status = 401;
          throw authError;
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || 'Failed to load meetings');
      }

      const data = await response.json();
      return Array.isArray(data) ? data : [data];
    },
    staleTime: 10_000,
  });

  useEffect(() => {
    if (meetings?.length) {
      setSelectedId((prev) => prev ?? meetings[0].id);
    }
  }, [meetings]);

  const normalizedMeetings = useMemo(
    () =>
      meetings.map((meeting) => ({
        id: meeting.id,
        title: meeting.title,
        date: meeting.date,
        summary: meeting.summary,
        participants: Array.isArray(meeting.participants) ? meeting.participants : [],
        messages: Array.isArray(meeting.messages) ? meeting.messages : [],
      })),
    [meetings]
  );

  const selectedMeeting = useMemo(
    () => normalizedMeetings.find((meeting) => meeting.id === selectedId),
    [normalizedMeetings, selectedId]
  );

  return (
    <div className="previous-meetings">
      <section className="meeting-list">
        <div className="meeting-list-header">
          <h2>Previous Meetings</h2>
          <p>Click a meeting to review the recap and conversation.</p>
        </div>

        {isLoading && <p>Loading meetings…</p>}
        {error && <p>{error.message || 'Unable to load meetings'}</p>}
        <div className="meeting-cards">
          {normalizedMeetings.map((meeting) => (
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