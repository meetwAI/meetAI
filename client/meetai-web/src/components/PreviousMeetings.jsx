import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchWithAuth } from '../api/fetchWithAuth';
import moment from 'moment';
import '../styles/PreviousMeetings.css';

export default function PreviousMeetings() {
  const [selectedId, setSelectedId] = useState(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { meetingid } = useParams();

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

  const {
    data: routeMeeting,
  } = useQuery({
    queryKey: ['meeting', meetingid],
    enabled: Boolean(meetingid),
    initialData: () => {
      if (!meetingid) return undefined;
      const fromList = meetings.find((meeting) => String(meeting.id) === String(meetingid));
      return fromList || undefined;
    },
    queryFn: async () => {
      const response = await fetchWithAuth(`/meetings/${meetingid}`);
      if (!response.ok) {
        return null;
      }
      const payload = await response.json().catch(() => null);
      return payload;
    },
    staleTime: 10_000,
  });

  useEffect(() => {
    if (meetingid) {
      setSelectedId(meetingid);
      return;
    }
    if (meetings?.length) {
      setSelectedId((prev) => prev ?? meetings[0].id);
    }
  }, [meetings, meetingid]);

  useEffect(() => {
    if (!meetingid) return;
    queryClient.invalidateQueries({ queryKey: ['meeting', String(meetingid)] });
  }, [meetingid, queryClient]);

  const normalizedMeetings = useMemo(() => {
    const baseMeetings = meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      date: meeting.date,
      summary: meeting.summary,
      participants: Array.isArray(meeting.participants) ? meeting.participants : [],
      messages: Array.isArray(meeting.messages) ? meeting.messages : [],
      actionItems: Array.isArray(meeting.actionItems) ? meeting.actionItems : [],
    }));

    if (!routeMeeting) {
      return baseMeetings;
    }

    const routeNormalized = {
      id: routeMeeting.id,
      title: routeMeeting.title,
      date: routeMeeting.date,
      summary: routeMeeting.summary,
      participants: Array.isArray(routeMeeting.participants) ? routeMeeting.participants : [],
      messages: Array.isArray(routeMeeting.messages) ? routeMeeting.messages : [],
      actionItems: Array.isArray(routeMeeting.actionItems) ? routeMeeting.actionItems : [],
    };

    const hasRouteMeeting = baseMeetings.some((meeting) => String(meeting.id) === String(routeNormalized.id));
    return hasRouteMeeting ? baseMeetings : [routeNormalized, ...baseMeetings];
  }, [meetings, routeMeeting]);

  const selectedMeeting = useMemo(
    () => normalizedMeetings.find((meeting) => String(meeting.id) === String(selectedId)),
    [normalizedMeetings, selectedId]
  );

  const appendMessageToCache = useCallback((meetingId, message) => {
    queryClient.setQueryData(['meetings', 'dummy'], (current) => {
      const currentMeetings = Array.isArray(current) ? current : [];
      return currentMeetings.map((meeting) => {
        if (String(meeting.id) !== String(meetingId)) {
          return meeting;
        }
        const messages = Array.isArray(meeting.messages) ? meeting.messages : [];
        return { ...meeting, messages: [...messages, message] };
      });
    });

    if (meetingid && String(meetingid) === String(meetingId)) {
      queryClient.setQueryData(['meeting', meetingid], (current) => {
        if (!current || String(current.id) !== String(meetingId)) {
          return current;
        }
        const messages = Array.isArray(current.messages) ? current.messages : [];
        return { ...current, messages: [...messages, message] };
      });
    }
  }, [meetingid, queryClient]);

  const renameMeetingInCache = useCallback((meetingId, title) => {
    queryClient.setQueryData(['meetings', 'dummy'], (current) => {
      const currentMeetings = Array.isArray(current) ? current : [];
      return currentMeetings.map((meeting) => {
        if (String(meeting.id) !== String(meetingId)) {
          return meeting;
        }
        return { ...meeting, title };
      });
    });

    if (meetingid && String(meetingid) === String(meetingId)) {
      queryClient.setQueryData(['meeting', meetingid], (current) => {
        if (!current || String(current.id) !== String(meetingId)) {
          return current;
        }
        return { ...current, title };
      });
    }
  }, [meetingid, queryClient]);

  const handleSendMessage = async () => {
    if (!selectedMeeting || isSending) {
      return;
    }

    const content = draftMessage.trim();
    if (!content) {
      return;
    }

    setIsSending(true);
    try {
      const response = await fetchWithAuth(`/meetings/${selectedMeeting.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, role: 'user' }),
      });

      const payload = await response.json().catch(() => null);
      if (payload?.message) {
        appendMessageToCache(selectedMeeting.id, payload.message);
      }
      setDraftMessage('');
    } finally {
      setIsSending(false);
    }
  };

  const handleDeleteMeeting = useCallback(async () => {
    if (!selectedMeeting || isDeleting) {
      return;
    }

    const meetingToDelete = selectedMeeting.id;
    const shouldDelete = window.confirm('Delete this meeting permanently?');
    if (!shouldDelete) {
      return;
    }

    setDeleteError('');
    setIsDeleting(true);

    try {
      await fetchWithAuth(`/meetings/${meetingToDelete}`, { method: 'DELETE' });

      queryClient.setQueryData(['meetings', 'dummy'], (current) => {
        const currentMeetings = Array.isArray(current) ? current : [];
        return currentMeetings.filter((meeting) => String(meeting.id) !== String(meetingToDelete));
      });
      queryClient.removeQueries({ queryKey: ['meeting', String(meetingToDelete)], exact: true });
      queryClient.invalidateQueries({ queryKey: ['meetings', 'recent', 3] });

      const remaining = normalizedMeetings.filter((meeting) => String(meeting.id) !== String(meetingToDelete));
      if (remaining.length > 0) {
        const nextMeetingId = remaining[0].id;
        setSelectedId(nextMeetingId);
        navigate(`/meetings/${nextMeetingId}`);
      } else {
        setSelectedId(null);
        navigate('/meetings');
      }
    } catch (error) {
      setDeleteError(error?.message || 'Failed to delete meeting.');
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, navigate, normalizedMeetings, queryClient, selectedMeeting]);

  const handleRenameMeeting = useCallback(async () => {
    if (!selectedMeeting || isRenaming) {
      return;
    }

    const currentTitle = String(selectedMeeting.title || '').trim();
    const nextTitleRaw = window.prompt('Enter a new meeting title', currentTitle);
    if (nextTitleRaw === null) {
      return;
    }

    const nextTitle = nextTitleRaw.trim();
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }

    setRenameError('');
    setIsRenaming(true);

    try {
      const response = await fetchWithAuth(`/meetings/${selectedMeeting.id}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: nextTitle }),
      });

      const payload = await response.json().catch(() => null);
      const titleFromServer = String(payload?.title || nextTitle).trim() || nextTitle;

      renameMeetingInCache(selectedMeeting.id, titleFromServer);
      queryClient.invalidateQueries({ queryKey: ['meetings', 'recent', 3] });
    } catch (error) {
      setRenameError(error?.message || 'Failed to rename meeting.');
    } finally {
      setIsRenaming(false);
    }
  }, [isRenaming, queryClient, renameMeetingInCache, selectedMeeting]);

  return (
    <div className="previous-meetings">
      <section className="meeting-list">
        <div className="meeting-list-header">
          <h2>Previous Meetings</h2>
          <p>Click a meeting to review the recap and conversation.</p>
        </div>

        {isLoading && <p>Loading meetings...</p>}
        {error && <p>{error.message || 'Unable to load meetings'}</p>}
        <div className="meeting-cards">
          {normalizedMeetings.map((meeting, index) => (
            <button
              key={meeting.id}
              type="button"
              className={`meeting-card${String(meeting.id) === String(selectedId) ? ' active' : ''}`}
              style={{ animation: `fadeIn 0.5s ease-out ${index * 0.05}s both` }}
              onClick={() => {
                setSelectedId(meeting.id);
                queryClient.invalidateQueries({ queryKey: ['meeting', String(meeting.id)] });
                navigate(`/meetings/${meeting.id}`);
                setShowAttachMenu(false);
              }}
            >
              <div className="meeting-card-header">
                <h3>{meeting.title}</h3>
                <span className="meeting-date">{moment(meeting.date).format('DD-MMM-YYYY')}</span>
              </div>
              <p className="meeting-summary">{meeting.summary}</p>
              {/* <div className="meeting-meta">
                <span>{meeting.participants.length} participants</span>
                <span>View conversation</span>
              </div> */}
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
                <p className="meeting-detail-date">{moment(selectedMeeting.date).format('DD-MMM-YYYY')}</p>
              </div>
              <div className="meeting-header-actions">
                <div className="meeting-tags">
                  {selectedMeeting.participants.map((name) => (
                    <span key={name} className="meeting-tag">
                      {name}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="rename-meeting-button"
                  onClick={handleRenameMeeting}
                  disabled={isRenaming}
                >
                  {isRenaming ? 'Renaming...' : 'Rename meeting'}
                </button>
                <button
                  type="button"
                  className="delete-meeting-button"
                  onClick={handleDeleteMeeting}
                  disabled={isDeleting}
                >
                  {isDeleting ? 'Deleting...' : 'Delete meeting'}
                </button>
              </div>
            </header>
            {renameError && <p className="recap-summary">{renameError}</p>}
            {deleteError && <p className="recap-summary">{deleteError}</p>}

            <div className="meeting-detail-summary">
              <h4>Summary</h4>
              <p>{selectedMeeting.summary}</p>
            </div>

            {!!selectedMeeting.actionItems?.length && (
              <div className="meeting-detail-summary">
                <h4>Action Items</h4>
                <ul>
                  {selectedMeeting.actionItems.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="meeting-messages">
              {selectedMeeting.messages.map((message) => (
                <div
                  key={message.id}
                  className={`message-row ${message.role === 'assistant' ? 'assistant' : 'user'}`}
                >
                  <div className="message-bubble">
                    <p>{message.text}</p>
                    <span className="message-time">{message.time ? moment(message.time).format('DD-MMM-YYYY HH:mm') : ''}</span>
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
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSendMessage();
                  }
                }}
              />
              <button
                type="button"
                className="send-button"
                onClick={handleSendMessage}
                disabled={isSending}
              >
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


