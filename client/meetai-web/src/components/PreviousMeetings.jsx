import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useSignals } from '@preact/signals-react/runtime';
import { fetchWithAuth } from '../api/fetchWithAuth';
import moment from 'moment';
import {
  closePreviousMeetingsSidebar,
  openPreviousMeetingsSidebar,
  sidebarState,
  togglePreviousMeetingsSidebar,
} from '../globals';

const normalizeTranscriptText = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const mergeTranscriptText = (baseText, nextText) => {
  const base = normalizeTranscriptText(baseText);
  const next = normalizeTranscriptText(nextText);

  if (!base) return next;
  if (!next) return base;
  if (base === next) return base;
  if (next.startsWith(base)) return next;
  if (base.startsWith(next)) return base;

  const baseWords = base.split(' ');
  const nextWords = next.split(' ');
  const maxOverlap = Math.min(baseWords.length, nextWords.length);
  let overlap = 0;

  for (let i = 1; i <= maxOverlap; i += 1) {
    const baseSlice = baseWords.slice(baseWords.length - i).join(' ');
    const nextSlice = nextWords.slice(0, i).join(' ');
    if (baseSlice === nextSlice) {
      overlap = i;
    }
  }

  if (overlap) {
    return baseWords.concat(nextWords.slice(overlap)).join(' ');
  }

  return `${base} ${next}`.trim();
};

const trimTranscriptContinuation = (previousText, nextText) => {
  const base = normalizeTranscriptText(previousText);
  const next = normalizeTranscriptText(nextText);

  if (!next) return '';
  if (!base) return next;
  if (next === base) return '';
  if (base.startsWith(next)) return '';
  if (next.startsWith(base)) {
    return next.slice(base.length).trimStart();
  }

  const baseWords = base.split(' ');
  const nextWords = next.split(' ');
  const maxOverlap = Math.min(baseWords.length, nextWords.length);
  let overlap = 0;

  for (let i = 1; i <= maxOverlap; i += 1) {
    const baseSlice = baseWords.slice(baseWords.length - i).join(' ');
    const nextSlice = nextWords.slice(0, i).join(' ');
    if (baseSlice === nextSlice) {
      overlap = i;
    }
  }

  if (overlap) {
    return nextWords.slice(overlap).join(' ').trim();
  }

  return next;
};


export default function PreviousMeetings() {
  useSignals();
  const API_URL = import.meta.env.VITE_AUTH_URL || import.meta.env.VITE_API_URL;
  const [selectedId, setSelectedId] = useState(null);
  const [meetingFilter, setMeetingFilter] = useState('previous');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarStatusLoading, setCalendarStatusLoading] = useState(true);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [isTranscriptPanelOpen, setIsTranscriptPanelOpen] = useState(true);
  const actionsMenuRef = useRef(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { meetingid } = useParams();
  const isSidebarOpen = sidebarState.value;

  const meetingsQueryKey = ['meetings', 'dummy', meetingFilter, fromDate || null, toDate || null];
  const meetingsQueryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('filter', meetingFilter);
    if (fromDate) {
      params.set('from', `${fromDate}T00:00:00.000Z`);
    }
    if (toDate) {
      params.set('to', `${toDate}T23:59:59.999Z`);
    }
    return params.toString();
  }, [meetingFilter, fromDate, toDate]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    window.closePreviousMeetingsSidebar = closePreviousMeetingsSidebar;
    window.openPreviousMeetingsSidebar = openPreviousMeetingsSidebar;
    window.togglePreviousMeetingsSidebar = togglePreviousMeetingsSidebar;

    return () => {
      if (window.closePreviousMeetingsSidebar === closePreviousMeetingsSidebar) {
        delete window.closePreviousMeetingsSidebar;
      }
      if (window.openPreviousMeetingsSidebar === openPreviousMeetingsSidebar) {
        delete window.openPreviousMeetingsSidebar;
      }
      if (window.togglePreviousMeetingsSidebar === togglePreviousMeetingsSidebar) {
        delete window.togglePreviousMeetingsSidebar;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;

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
  }, []);

  const {
    data: meetings = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: meetingsQueryKey,
    queryFn: async () => {
      try {
        const response = await fetchWithAuth(`/meetings/dummy?${meetingsQueryString}`);
        const data = await response.json();
        return Array.isArray(data) ? data : [data];
      } catch (fetchError) {
        if (fetchError?.status === 401) {
          const authError = new Error('Unauthorized');
          authError.status = 401;
          throw authError;
        }

        let errorMessage = 'Failed to load meetings';
        if (fetchError?.response) {
          const payload = await fetchError.response.json().catch(() => ({}));
          if (payload?.message) {
            errorMessage = payload.message;
          }
        }

        throw new Error(errorMessage);
      }
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

  useEffect(() => {
    setShowActionsMenu(false);
    setIsEditingTitle(false);
  }, [selectedId]);

  useEffect(() => {
    if (!showActionsMenu) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(event.target)) {
        setShowActionsMenu(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [showActionsMenu]);

  const normalizedMeetings = useMemo(() => {
    const baseMeetings = meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      date: meeting.date,
      summary: meeting.summary,
      participants: Array.isArray(meeting.participants) ? meeting.participants : [],
      messages: Array.isArray(meeting.messages) ? meeting.messages : [],
      actionItems: Array.isArray(meeting.actionItems) ? meeting.actionItems : [],
      lines: Array.isArray(meeting.lines) ? meeting.lines : [],
      bufferTranscription: String(meeting.bufferTranscription || ''),
      bufferDiarization: String(meeting.bufferDiarization || ''),
      asrStatus: String(meeting.asrStatus || 'idle'),
      updatedAt: String(meeting.updatedAt || ''),
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
      lines: Array.isArray(routeMeeting.lines) ? routeMeeting.lines : [],
      bufferTranscription: String(routeMeeting.bufferTranscription || ''),
      bufferDiarization: String(routeMeeting.bufferDiarization || ''),
      asrStatus: String(routeMeeting.asrStatus || 'idle'),
      updatedAt: String(routeMeeting.updatedAt || ''),
    };

    const hasRouteMeeting = baseMeetings.some((meeting) => String(meeting.id) === String(routeNormalized.id));
    return hasRouteMeeting ? baseMeetings : [routeNormalized, ...baseMeetings];
  }, [meetings, routeMeeting]);

  const selectedMeeting = useMemo(
    () => normalizedMeetings.find((meeting) => String(meeting.id) === String(selectedId)),
    [normalizedMeetings, selectedId]
  );

  const transcriptState = useMemo(() => {
    if (!selectedMeeting) {
      return {
        groups: [],
        bufferTranscription: '',
        bufferDiarization: '',
      };
    }

    let bufferTranscription = normalizeTranscriptText(selectedMeeting.bufferTranscription);
    let bufferDiarization = normalizeTranscriptText(selectedMeeting.bufferDiarization);
    const lines = Array.isArray(selectedMeeting.lines) ? selectedMeeting.lines : [];
    const groups = [];
    const lastTextBySpeaker = new Map();

    lines.forEach((line) => {
      const speakerValue = Number.isFinite(Number(line?.speaker))
        ? Number(line.speaker)
        : line?.speaker ?? null;
      const text = normalizeTranscriptText(line?.text);
      const previousText = lastTextBySpeaker.get(speakerValue) || '';
      const trimmedText = trimTranscriptContinuation(previousText, text);

      if (!trimmedText) {
        if (text) {
          lastTextBySpeaker.set(speakerValue, mergeTranscriptText(previousText, text));
        }
        return;
      }

      const lastGroup = groups[groups.length - 1];
      if (!lastGroup || lastGroup.speaker !== speakerValue) {
        groups.push({
          speaker: speakerValue,
          text: trimmedText,
          start: line?.start ?? null,
          end: line?.end ?? null,
        });
      } else {
        lastGroup.text = mergeTranscriptText(lastGroup.text, text);
        if (lastGroup.start == null && line?.start != null) {
          lastGroup.start = line.start;
        }
        if (line?.end != null) {
          lastGroup.end = line.end;
        }
      }

      if (text) {
        lastTextBySpeaker.set(speakerValue, mergeTranscriptText(previousText, text));
      }
    });

    if (!groups.length && (bufferTranscription || bufferDiarization)) {
      const bufferText = [bufferDiarization, bufferTranscription].filter(Boolean).join(' ');
      if (bufferText) {
        groups.push({
          speaker: -1,
          text: bufferText,
          start: null,
          end: null,
        });
        bufferTranscription = '';
        bufferDiarization = '';
      }
    }

    return { groups, bufferTranscription, bufferDiarization };
  }, [selectedMeeting]);

  useEffect(() => {
    if (!selectedMeeting) {
      setTitleDraft('');
      return;
    }
    setTitleDraft(String(selectedMeeting.title || ''));
  }, [selectedMeeting]);

  const appendMessageToCache = useCallback((meetingId, message) => {
    queryClient.setQueriesData({ queryKey: ['meetings', 'dummy'] }, (current) => {
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
    queryClient.setQueriesData({ queryKey: ['meetings', 'dummy'] }, (current) => {
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

    setShowActionsMenu(false);

    const meetingToDelete = selectedMeeting.id;
    const shouldDelete = window.confirm('Delete this meeting permanently?');
    if (!shouldDelete) {
      return;
    }

    setDeleteError('');
    setIsDeleting(true);

    try {
      await fetchWithAuth(`/meetings/${meetingToDelete}`, { method: 'DELETE' });

      queryClient.setQueriesData({ queryKey: ['meetings', 'dummy'] }, (current) => {
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
    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === currentTitle) {
      setIsEditingTitle(false);
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
      setTitleDraft(titleFromServer);
      setIsEditingTitle(false);
    } catch (error) {
      setRenameError(error?.message || 'Failed to rename meeting.');
    } finally {
      setIsRenaming(false);
    }
  }, [isRenaming, queryClient, renameMeetingInCache, selectedMeeting, titleDraft]);

  const handleConnectCalendar = () => {
    const connectBase = API_URL || 'localhost:5173';
    window.location.href = `${connectBase}/auth/google/calendar`;
  };

  return (
    <div className={`previous-meetings${isSidebarOpen ? '' : ' sidebar-collapsed'}${isTranscriptPanelOpen ? '' : ' transcript-collapsed'}`}>
      <section className="meeting-list">
        <div className="meeting-list-header">
          <div className="meeting-list-header-row">
            <h2>Meetings</h2>
            <button
              type="button"
              className={`sidebar-icon-button${isSidebarOpen ? '' : ' collapsed'}`}
              onClick={togglePreviousMeetingsSidebar}
              title="Toggle meetings sidebar"
              aria-label={isSidebarOpen ? 'Hide meetings sidebar' : 'Show meetings sidebar'}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
                <line x1="9" y1="5" x2="9" y2="19" stroke="currentColor" strokeWidth="1.8" />
                <path d="M14 9.5L11.5 12L14 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <p>Filter by upcoming, previous, or a custom date range.</p>

          {!calendarStatusLoading && !calendarConnected && (
            <div className="calendar-connect-banner">
              <div>
                <strong>Connect Google Calendar?</strong>
                <span>Enable scheduling and follow-ups.</span>
              </div>
              <button type="button" onClick={handleConnectCalendar}>
                Connect
              </button>
            </div>
          )}

          <div className="meeting-filter-row">
            {!calendarStatusLoading && calendarConnected && (
              <label className="meeting-filter-field">
                <span>Show</span>
                <select
                  value={meetingFilter}
                  onChange={(event) => setMeetingFilter(event.target.value)}
                  aria-label="Filter meetings"
                >
                  <option value="previous">Previous</option>

                  <option value="upcoming">Upcoming</option>

                  <option value="all">All</option>
                </select>
              </label>
            )}
            <label className="meeting-filter-field">
              <span>From</span>
              <input
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                aria-label="Meetings from date"
              />
            </label>

            <label className="meeting-filter-field">
              <span>To</span>
              <input
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                aria-label="Meetings to date"
              />
            </label>

            <button
              type="button"
              className="meeting-filter-clear"
              onClick={() => {
                setFromDate('');
                setToDate('');
              }}
              disabled={!fromDate && !toDate}
            >
              Clear range
            </button>
          </div>
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
                setShowActionsMenu(false);
              }}
            >
              <div className="meeting-card-header">
                <h3>{meeting.title}</h3>
                <span className="meeting-date">{moment(meeting.date).format('DD-MMM-YYYY')}</span>
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
        <div className="meeting-detail-topbar" />
        {selectedMeeting ? (
          <>
            <header className="meeting-detail-header">
              <div className="meeting-title-block">
                {isEditingTitle ? (
                  <form
                    className="meeting-title-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      handleRenameMeeting();
                    }}
                  >
                    <input
                      type="text"
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      aria-label="Edit meeting title"
                      disabled={isRenaming}
                      autoFocus
                    />
                    <button type="submit" disabled={isRenaming}>
                      {isRenaming ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingTitle(false);
                        setRenameError('');
                        setTitleDraft(String(selectedMeeting.title || ''));
                      }}
                      disabled={isRenaming}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <h2>{selectedMeeting.title}</h2>
                )}
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
                <div className="meeting-header-actions-row">
                  <button
                    type="button"
                    className={`meeting-transcript-toggle${isTranscriptPanelOpen ? ' is-open' : ''}`}
                    onClick={() => setIsTranscriptPanelOpen((prev) => !prev)}
                    aria-label={isTranscriptPanelOpen ? 'Hide transcript panel' : 'Open transcript panel'}
                    aria-pressed={isTranscriptPanelOpen}
                  >
                    {isTranscriptPanelOpen ? 'Hide transcript' : 'Transcript'}
                  </button>
                  <div className="meeting-actions-menu-wrapper" ref={actionsMenuRef}>
                    <button
                      type="button"
                      className="meeting-actions-trigger"
                      aria-label="Open meeting actions"
                      aria-expanded={showActionsMenu}
                      onClick={() => setShowActionsMenu((prev) => !prev)}
                    >
                      <span aria-hidden="true">⋮</span>
                    </button>
                    {showActionsMenu && (
                      <div className="meeting-actions-popup">
                        <button
                          type="button"
                          className="rename-meeting-button"
                          onClick={() => {
                            setShowActionsMenu(false);
                            setRenameError('');
                            setTitleDraft(String(selectedMeeting.title || ''));
                            setIsEditingTitle(true);
                          }}
                          disabled={isRenaming}
                        >
                          Rename meeting
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
                    )}
                  </div>
                </div>
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
                  {calendarConnected && <button type="button">Schedule follow-up</button>}
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

      {isTranscriptPanelOpen ? (
        <aside className="meeting-transcript-panel">
          <div className="meeting-transcript-header">
            <h3>Transcript</h3>
            <button
              type="button"
              className="meeting-transcript-close"
              onClick={() => setIsTranscriptPanelOpen(false)}
              aria-label="Close transcript panel"
            >
              Close
            </button>
          </div>
          {selectedMeeting ? (
            <>
              <div className="meeting-transcript-body">
                {transcriptState.groups.map((group, groupIndex) => {
                  const isLastGroup = groupIndex === transcriptState.groups.length - 1;
                  const timeLabel =
                    group?.start != null && group?.end != null ? `${group.start} - ${group.end}` : '';
                  const speakerLabel =
                    Number(group?.speaker) === -2
                      ? 'Silence'
                      : `Speaker ${Number.isFinite(Number(group?.speaker)) ? Number(group.speaker) : '-'}`;
                  const showMeta = !(Number(group?.speaker) === -1 && !timeLabel);
                  const bufferParts = [
                    transcriptState.bufferDiarization,
                    transcriptState.bufferTranscription,
                  ].filter(Boolean);

                  return (
                    <article className="meeting-transcript-line" key={`speaker-${group.speaker}-${groupIndex}`}>
                      {showMeta && (
                        <div className="meeting-transcript-meta">
                          <span>{speakerLabel}</span>
                          {timeLabel && <span>{timeLabel}</span>}
                        </div>
                      )}
                      <p>
                        {group.text}
                        {isLastGroup &&
                          bufferParts.map((part, idx) => (
                            <span className="meeting-transcript-buffer-inline" key={`buffer-${idx}`}>
                              {(group.text || idx > 0) ? ' ' : ''}{part}
                            </span>
                          ))}
                      </p>
                    </article>
                  );
                })}
                {!transcriptState.groups.length && (
                  <p className="meeting-transcript-empty">No transcript yet.</p>
                )}
              </div>
            </>
          ) : (
            <p className="meeting-transcript-empty">Select a meeting to view transcript.</p>
          )}
        </aside>
      ) : (
        !selectedMeeting && (
          <button
            type="button"
            className="meeting-transcript-open"
            onClick={() => setIsTranscriptPanelOpen(true)}
            aria-label="Open transcript panel"
          >
            Transcript
          </button>
        )
      )}
    </div>
  );
}


