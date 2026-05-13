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
import { parseSseStream } from '../api/sseStream'
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

const normalizeCalendarText = (value) => String(value || '').trim();

const stripCalendarHtml = (value) =>
  normalizeCalendarText(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

const parseCalendarDate = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

const resolveEventStartValue = (event) =>
  normalizeCalendarText(event?.start?.dateTime || event?.start?.date || event?.end?.dateTime || event?.end?.date);

const resolveEventEndValue = (event) =>
  normalizeCalendarText(event?.end?.dateTime || event?.end?.date || event?.start?.dateTime || event?.start?.date);

const extractMeetLink = (value) => {
  const match = normalizeCalendarText(value).match(/https?:\/\/meet\.google\.com\/[\w-]+/i);
  return match ? match[0] : '';
};

const resolveMeetLink = (event) => {
  const hangoutLink = normalizeCalendarText(event?.hangoutLink);
  if (hangoutLink) {
    return hangoutLink;
  }

  const entryPoints = Array.isArray(event?.conferenceData?.entryPoints)
    ? event.conferenceData.entryPoints
    : [];
  const videoEntry = entryPoints.find((entry) =>
    normalizeCalendarText(entry?.entryPointType).toLowerCase() === 'video' && normalizeCalendarText(entry?.uri),
  );
  if (videoEntry?.uri) {
    return normalizeCalendarText(videoEntry.uri);
  }

  return extractMeetLink(event?.location);
};

const buildCalendarMeeting = (event, index) => {
  const eventId = normalizeCalendarText(event?.id) || `event-${index}`;
  const startValue = resolveEventStartValue(event);
  const endValue = resolveEventEndValue(event);
  const startDate = startValue ? parseCalendarDate(startValue) : null;
  const endDate = endValue ? parseCalendarDate(endValue) : null;
  const title = normalizeCalendarText(event?.summary) || 'Untitled event';
  const description = stripCalendarHtml(event?.description);
  const location = normalizeCalendarText(event?.location);
  const meetLink = resolveMeetLink(event);
  const participants = Array.isArray(event?.attendees)
    ? event.attendees
        .map((attendee) => normalizeCalendarText(attendee?.displayName || attendee?.email))
        .filter(Boolean)
    : [];

  return {
    id: `calendar-${eventId}`,
    sourceId: eventId,
    title,
    date: startDate ? startDate.toISOString() : startValue || '',
    summary: description || location || 'Google Calendar event',
    participants,
    messages: [],
    actionItems: [],
    lines: [],
    bufferTranscription: '',
    bufferDiarization: '',
    asrStatus: 'idle',
    updatedAt: normalizeCalendarText(event?.updated) || '',
    startTime: startDate ? startDate.toISOString() : startValue || '',
    endTime: endDate ? endDate.toISOString() : endValue || '',
    isCalendarEvent: true,
    isAllDay: Boolean(event?.isAllDay),
    meetLink: meetLink || null,
    htmlLink: normalizeCalendarText(event?.htmlLink) || null,
    location,
  };
};

const getMeetingSortDate = (meeting) =>
  parseCalendarDate(meeting?.startTime || meeting?.date || meeting?.updatedAt || '');


export default function PreviousMeetings() {
  useSignals();
  const API_URL = import.meta.env.VITE_AUTH_URL || import.meta.env.VITE_API_URL;
  const [selectedId, setSelectedId] = useState(null);
  const [meetingFilter, setMeetingFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarStatusLoading, setCalendarStatusLoading] = useState(true);
  const [calendarVerified, setCalendarVerified] = useState(false);
  const [calendarUnavailable, setCalendarUnavailable] = useState(false);
  const [calendarStatusTick, setCalendarStatusTick] = useState(0);
  const [isGoogleAccount, setIsGoogleAccount] = useState(false);
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const [messageMode, setMessageMode] = useState('qa');
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

  const handleRetryCalendarStatus = () => {
    setCalendarStatusTick((tick) => tick + 1);
  };

  const apiMeetingFilter = meetingFilter === 'calendar' ? 'all' : meetingFilter;
  const showCalendarOnly = meetingFilter === 'calendar';
  const shouldLoadMeetings = !showCalendarOnly || Boolean(meetingid);

  const openMeetLink = (link) => {
    if (!link) {
      return;
    }
    window.open(link, '_blank', 'noopener,noreferrer');
  };

  const meetingsQueryKey = ['meetings', 'dummy', apiMeetingFilter, fromDate || null, toDate || null];

  const meetingsQueryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('filter', apiMeetingFilter);
    if (fromDate) {
      params.set('from', `${fromDate}T00:00:00.000Z`);
    }
    if (toDate) {
      params.set('to', `${toDate}T23:59:59.999Z`);
    }
    return params.toString();
  }, [apiMeetingFilter, fromDate, toDate]);
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
      // Check if user just returned from Google OAuth flow
      const params = new URLSearchParams(window.location.search);
      const calendarState = params.get('calendar');

      if (calendarState === 'connected') {
        console.log('[PreviousMeetings] User just connected calendar - forcing status refresh');
      }

      console.log('[PreviousMeetings] Loading calendar status - connected:', calendarConnected, 'verified:', calendarVerified);

      setCalendarStatusLoading(true);
      setCalendarUnavailable(false);
      try {
        const response = await fetchWithAuth('/calendar/status?validate=1');
        const payload = await response.json().catch(() => ({}));
        console.log('[PreviousMeetings] Calendar status response:', payload);
        if (active) {
          const connected = Boolean(payload?.connected);
          const verified = Boolean(payload?.verified);
          const unavailable = Boolean(payload?.unavailable);
          const googleAccount = Boolean(payload?.isGoogleAccount);
          setCalendarConnected(connected);
          setCalendarVerified(verified);
          setCalendarUnavailable(unavailable);
          setIsGoogleAccount(googleAccount);
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

  const {
    data: meetings = [],
    isLoading: meetingsLoading,
    error: meetingsError,
  } = useQuery({
    queryKey: meetingsQueryKey,
    enabled: shouldLoadMeetings,
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

  const calendarQueryString = useMemo(() => {
    const params = new URLSearchParams();
    if (fromDate) {
      params.set('timeMin', `${fromDate}T00:00:00.000Z`);
    }
    if (toDate) {
      params.set('timeMax', `${toDate}T23:59:59.999Z`);
    }
    params.set('maxResults', '250');
    return params.toString();
  }, [fromDate, toDate]);

  // Log when calendar events query should be enabled
  useEffect(() => {
    console.log('[PreviousMeetings] Calendar events query state - connected:', calendarConnected, 'verified:', calendarVerified, 'enabled:', calendarConnected && calendarVerified);
  }, [calendarConnected, calendarVerified]);

  const {
    data: calendarEvents = [],
    isLoading: calendarEventsLoading,
    error: calendarEventsError,
  } = useQuery({
    queryKey: ['calendar', 'events', fromDate || null, toDate || null, calendarStatusTick],
    enabled: calendarConnected,
    queryFn: async () => {
      console.log('[PreviousMeetings] Fetching calendar events - connected:', calendarConnected, 'verified:', calendarVerified);
      try {
        const response = await fetchWithAuth(`/calendar/events?${calendarQueryString}`);
        const payload = await response.json().catch(() => ({}));
        return Array.isArray(payload?.events) ? payload.events : [];
      } catch (fetchError) {
        // If the calendar token was revoked/expired, the server returns 401.
        // Reset connection state so the reconnect banner appears.
        if (fetchError?.status === 401) {
          setCalendarConnected(false);
          setCalendarVerified(false);
          return [];
        }
        let errorMessage = 'Failed to load Google Calendar events.';
        if (fetchError?.response) {
          const payload = await fetchError.response.json().catch(() => ({}));
          if (payload?.message) {
            errorMessage = payload.message;
          }
        } else if (fetchError?.message) {
          errorMessage = fetchError.message;
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
    placeholderData: () => {
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

  const normalizedAppMeetings = useMemo(() => {
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



  useEffect(() => {
    setShowActionsMenu(false);
    setIsEditingTitle(false);
  }, [selectedId]);

  const normalizedCalendarMeetings = useMemo(() => {
    if (!calendarEvents.length) {
      return [];
    }

    const now = new Date();
    return calendarEvents
      .map((event, index) => buildCalendarMeeting(event, index))
      .filter((meeting) => {
        if (meetingFilter === 'upcoming') {
          const meetingDate = getMeetingSortDate(meeting);
          return meetingDate ? meetingDate.getTime() >= now.getTime() : false;
        }

        if (meetingFilter === 'previous') {
          const meetingDate = getMeetingSortDate(meeting);
          return meetingDate ? meetingDate.getTime() < now.getTime() : false;
        }

        return true;
      });
  }, [calendarEvents, meetingFilter]);

  const normalizedMeetings = useMemo(() => {
    const baseMeetings = shouldLoadMeetings ? normalizedAppMeetings : [];
    const combined = baseMeetings.concat(normalizedCalendarMeetings);
    const direction = meetingFilter === 'upcoming' ? 1 : -1;

    return combined.slice().sort((first, second) => {
      const firstDate = getMeetingSortDate(first);
      const secondDate = getMeetingSortDate(second);
      if (!firstDate && !secondDate) {
        return 0;
      }
      if (!firstDate) {
        return 1;
      }
      if (!secondDate) {
        return -1;
      }
      return (firstDate.getTime() - secondDate.getTime()) * direction;
    });
  }, [normalizedAppMeetings, normalizedCalendarMeetings, meetingFilter, shouldLoadMeetings]);

  useEffect(() => {
    if (meetingid) {
      setSelectedId(meetingid);
      return;
    }
    if (normalizedMeetings?.length) {
      setSelectedId((prev) => prev ?? normalizedMeetings[0].id);
      return;
    }
    setSelectedId(null);
  }, [normalizedMeetings, meetingid]);

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

  const selectedMeeting = useMemo(
    () => normalizedMeetings.find((meeting) => String(meeting.id) === String(selectedId)),
    [normalizedMeetings, selectedId]
  );

  const isCalendarEventSelected = Boolean(selectedMeeting?.isCalendarEvent);

  const calendarTimeRange = useMemo(() => {
    if (!selectedMeeting || !selectedMeeting.isCalendarEvent) {
      return '';
    }

    const start = selectedMeeting.startTime ? moment(selectedMeeting.startTime) : null;
    const end = selectedMeeting.endTime ? moment(selectedMeeting.endTime) : null;

    if (selectedMeeting.isAllDay && start) {
      return `${start.format('DD-MMM-YYYY')} (all day)`;
    }

    if (start && end) {
      return `${start.format('DD-MMM-YYYY HH:mm')} - ${end.format('DD-MMM-YYYY HH:mm')}`;
    }

    if (start) {
      return start.format('DD-MMM-YYYY HH:mm');
    }

    return '';
  }, [selectedMeeting]);

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
    const rawLines = Array.isArray(selectedMeeting.lines) ? selectedMeeting.lines : [];

    // For realtime meetings (actively recording) sort by end time so partial
    // chunks stream in the right order. For completed meetings sort by start.
    const isRealtime = selectedMeeting.asrStatus !== 'idle' && selectedMeeting.asrStatus !== 'done';
    const lines = rawLines.slice().sort((a, b) => {
      const aVal = isRealtime ? (a?.end ?? a?.start) : (a?.start ?? a?.end);
      const bVal = isRealtime ? (b?.end ?? b?.start) : (b?.start ?? b?.end);
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      return Number(aVal) - Number(bVal);
    });

    const groups = [];
    const lastTextBySpeaker = new Map();
    // Maps "speaker:start" → group index so updated ASR chunks (same utterance,
    // updated text, arriving after another speaker's chunk due to sort order)
    // are merged back into their original group rather than creating a new box.
    const groupKeyMap = new Map();

    lines.forEach((line) => {
      const speakerValue = Number.isFinite(Number(line?.speaker))
        ? Number(line.speaker)
        : line?.speaker ?? null;
      const text = normalizeTranscriptText(line?.text);
      const lineStart = line?.start ?? null;
      const lineEnd = line?.end ?? null;
      const previousText = lastTextBySpeaker.get(speakerValue) || '';
      const trimmedText = trimTranscriptContinuation(previousText, text);

      if (!trimmedText) {
        if (text) {
          lastTextBySpeaker.set(speakerValue, mergeTranscriptText(previousText, text));
        }
        return;
      }

      // Key identifies a specific utterance segment by speaker + start time.
      // If two lines share the same speaker and start, the second is an updated
      // version of the same chunk — merge into the original group in-place.
      const segmentKey = lineStart != null ? `${speakerValue}:${lineStart}` : null;
      const existingIdx = segmentKey != null ? groupKeyMap.get(segmentKey) : undefined;

      if (existingIdx !== undefined) {
        // Updated chunk for an existing segment — patch the original group.
        const existing = groups[existingIdx];
        existing.text = mergeTranscriptText(existing.text, trimmedText);
        if (lineEnd != null) existing.end = lineEnd;
      } else {
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.speaker === speakerValue) {
          // Consecutive same-speaker line — extend the current group.
          lastGroup.text = mergeTranscriptText(lastGroup.text, trimmedText);
          if (lastGroup.start == null && lineStart != null) lastGroup.start = lineStart;
          if (lineEnd != null) lastGroup.end = lineEnd;
          if (segmentKey != null) groupKeyMap.set(segmentKey, groups.length - 1);
        } else {
          // New speaker turn — open a fresh group.
          const newIdx = groups.length;
          groups.push({
            speaker: speakerValue,
            text: trimmedText,
            start: lineStart,
            end: lineEnd,
          });
          if (segmentKey != null) groupKeyMap.set(segmentKey, newIdx);
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

  const mutateMessagesInCache = useCallback(
    (meetingId, transform) => {
      queryClient.setQueriesData({ queryKey: ['meetings', 'dummy'] }, (current) => {
        const currentMeetings = Array.isArray(current) ? current : [];

        return currentMeetings.map((meeting) => {
          if (String(meeting.id) !== String(meetingId)) {
            return meeting;
          }
          const messages = Array.isArray(meeting.messages) ? meeting.messages : [];
          return { ...meeting, messages: transform(messages) };
        });
      });

      if (meetingid && String(meetingid) === String(meetingId)) {
        queryClient.setQueryData(['meeting', meetingid], (current) => {
          if (!current || String(current.id) !== String(meetingId)) {
            return current;
          }
          const messages = Array.isArray(current.messages) ? current.messages : [];
          return { ...current, messages: transform(messages) };
        });
      }
    },
    [meetingid, queryClient],
  );
const appendMessageToCache = useCallback(
    (meetingId, message) => {
      mutateMessagesInCache(meetingId, (messages) => [...messages, message]);
    },
    [mutateMessagesInCache],
  );

  // Replace a message identified by predicate with next. If no
  // existing message matches, next is appended (covers the "first delta
  // arrives" case where we hadn't created a placeholder yet).
  const replaceMessageInCache = useCallback(
    (meetingId, predicate, next) => {
      mutateMessagesInCache(meetingId, (messages) => {
        let replaced = false;
        const out = messages.map((m) => {
          if (!replaced && predicate(m)) {
            replaced = true;
            return next;
          }
          return m;
        });
        return replaced ? out : [...out, next];
      });
    },
    [mutateMessagesInCache],
  );

  const removeMessageFromCache = useCallback(
    (meetingId, predicate) => {
      mutateMessagesInCache(meetingId, (messages) =>
        messages.filter((m) => !predicate(m)),
      );
    },
    [mutateMessagesInCache],
  );
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
    if (!selectedMeeting || isSending || selectedMeeting.isCalendarEvent) {
      return;
    }

    const content = draftMessage.trim();
    if (!content) {
      return;
    }

    const meetingId = selectedMeeting.id;
    const now = new Date().toISOString();

    const localUserId = `local-user-${Date.now()}`;
    const localAssistantId = `local-assistant-${Date.now()}`;

    const optimisticUser = {
      id: localUserId,
      role: 'user',
      text: content,
      time: now,
    };

    appendMessageToCache(meetingId, optimisticUser);

    // Only append a streaming assistant bubble if we are asking the QA bot
    if (messageMode === 'qa') {
      const streamingAssistant = {
        id: localAssistantId,
        role: 'assistant',
        text: '',
        time: now,
        streaming: true,
      };
      appendMessageToCache(meetingId, streamingAssistant);
    }

    setDraftMessage('');
    setIsSending(true);
    try {
      if (messageMode === 'note') {
        // --- NOTE MODE ---
        const response = await fetchWithAuth(`/meetings/${meetingId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content }),
        });

        if (response.ok) {
          const data = await response.json();
          replaceMessageInCache(
            meetingId,
            (m) => m.id === localUserId,
            data.message,
          );
        } else {
          const errorData = await response.json().catch(() => ({}));
          console.error('[note] save failed', errorData);
          removeMessageFromCache(meetingId, (m) => m.id === localUserId);
        }
      } else {
        // --- QA MODE (SSE Stream) ---
        const response = await fetchWithAuth(`/meetings/${meetingId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ content, mode: 'qa' }),
        });

        let streamedText = '';
        let finalAnswer = null;
        let sawError = null;
        let wasSaved = false;
        for await (const evt of parseSseStream(response.body)) {
          let parsed = null;
          if (evt.data) {
            try {
              parsed = JSON.parse(evt.data);
            } catch {
              parsed = null;
            }
          }

          if (evt.event === 'user-saved' && parsed?.message) {
            replaceMessageInCache(meetingId, (m) => m.id === localUserId, parsed.message);
            continue;
          }

          if (evt.event === 'delta' && typeof parsed?.text === 'string') {
            streamedText += parsed.text;
            replaceMessageInCache(meetingId, (m) => m.id === localAssistantId, {
              id: localAssistantId,
              role: 'assistant',
              text: streamedText,
              time: now,
              streaming: true,
            });
            continue;
          }

          if (evt.event === 'done' && typeof parsed?.answer === 'string') {
            finalAnswer = parsed.answer;
            continue;
          }

          if (evt.event === 'saved' && parsed?.message) {
            // Server confirmed the assistant message is persisted — replace the
            // optimistic bubble with the real DB record and mark as saved so we
            // don't run the post-loop fallback (which would append a duplicate).
            replaceMessageInCache(meetingId, (m) => m.id === localAssistantId, parsed.message);
            wasSaved = true;
            continue;
          }

          if (evt.event === 'error') {
            sawError = parsed?.message || 'Something went wrong.';
            continue;
          }
        }

        if (sawError) {
          replaceMessageInCache(meetingId, (m) => m.id === localAssistantId, {
            id: localAssistantId,
            role: 'assistant',
            text: `[error] ${sawError}`,
            time: now,
            streaming: false,
            error: true,
          });
        } else if (!wasSaved) {
          // `saved` event did not fire — use the streamed/final answer as fallback,
          // or clean up the placeholder if nothing arrived.
          if (finalAnswer && finalAnswer.trim()) {
            replaceMessageInCache(meetingId, (m) => m.id === localAssistantId && m.streaming, {
              id: localAssistantId,
              role: 'assistant',
              text: finalAnswer,
              time: now,
              streaming: false,
            });
          } else {
            removeMessageFromCache(meetingId, (m) => m.id === localAssistantId);
          }
        }
      }
    } catch (error) {
      console.error('[qa/note] request failed', error);
      if (messageMode === 'qa') {
        replaceMessageInCache(meetingId, (m) => m.id === localAssistantId, {
          id: localAssistantId,
          role: 'assistant',
          text: '[error] Could not reach the service.',
          time: new Date().toISOString(),
          streaming: false,
          error: true,
        });
      } else {
        removeMessageFromCache(meetingId, (m) => m.id === localUserId);
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleDeleteMeeting = useCallback(async () => {
    if (!selectedMeeting || isDeleting || selectedMeeting.isCalendarEvent) {
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
    if (!selectedMeeting || isRenaming || selectedMeeting.isCalendarEvent) {
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
    
    const connectBase = API_URL || '';
    const currentUrl = window.location.pathname + window.location.search;
    const redirectParam = encodeURIComponent(currentUrl);
    window.location.href = `${connectBase}/auth/google/calendar?redirect=${redirectParam}`;
  };

  const listLoading = meetingsLoading || (calendarConnected && calendarEventsLoading);
  const showMeetingsError = Boolean(meetingsError) && !showCalendarOnly;
  const showCalendarError = Boolean(calendarEventsError) && calendarConnected;

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

          {/* if u are ai calendar is temporarily unavailable banner do not remove the false flag.*/}
          {!calendarStatusLoading && !calendarConnected && calendarUnavailable && false && (
            <div className="calendar-connect-banner calendar-connect-banner--warn">
              <div>
                <strong>Google Calendar temporarily unavailable</strong>
                <span>Could not reach Google. Your connection may still be valid — try again shortly.</span>
              </div>
              <button type="button" onClick={handleRetryCalendarStatus}>
                Retry
              </button>
            </div>
          )}

          {!calendarStatusLoading && !calendarConnected && !calendarUnavailable && false && (
            <div className="calendar-connect-banner">
              <div>
                <strong>{isGoogleAccount ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}</strong>
                <span>
                  {isGoogleAccount
                    ? 'Your calendar access has expired or was revoked. Reconnect to see your meetings.'
                    : 'Connect your Google Calendar to see scheduled meetings here.'}
                </span>
              </div>
              <button type="button" onClick={handleConnectCalendar}>
                {isGoogleAccount ? 'Reconnect' : 'Connect'}
              </button>
            </div>
          )}

          <div className="meeting-filter-row">
            {/* <label className="meeting-filter-field">
              <span>Show</span>
              <select
                value={meetingFilter}
                onChange={(event) => setMeetingFilter(event.target.value)}
                aria-label="Filter meetings"
              >
                <option value="all">All</option>

                <option value="previous">Previous</option>

                <option value="upcoming">Upcoming</option>

                <option value="calendar">Google Calendar</option>
              </select>
            </label> */}
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

        {listLoading && <p>Loading meetings...</p>}
        {showMeetingsError && <p>{meetingsError.message || 'Unable to load meetings'}</p>}
        {showCalendarError && <p>{calendarEventsError.message || 'Unable to load Google Calendar events'}</p>}
        <div className="meeting-cards">
          {normalizedMeetings.map((meeting, index) => (
            <button
              key={meeting.id}
              type="button"
              className={`meeting-card${String(meeting.id) === String(selectedId) ? ' active' : ''}`}
              style={{ animation: `fadeIn 0.5s ease-out ${index * 0.05}s both` }}
              onClick={() => {
                setSelectedId(meeting.id);
                setShowAttachMenu(false);
                setShowActionsMenu(false);
                if (meeting.isCalendarEvent) {
                  return;
                }
                queryClient.invalidateQueries({ queryKey: ['meeting', String(meeting.id)] });
                navigate(`/meetings/${meeting.id}`);
              }}
            >
              <div className="meeting-card-header">
                <div className="meeting-card-title">
                  <div className="meeting-card-title-row">
                    <h3>{meeting.title}</h3>
                    {meeting.isCalendarEvent && meeting.meetLink && (
                      <button
                        type="button"
                        className="meeting-card-meet"
                        onClick={(event) => {
                          event.stopPropagation();
                          openMeetLink(meeting.meetLink);
                        }}
                        aria-label="Open Google Meet"
                        title="Open Google Meet"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M4 7.5C4 6.12 5.12 5 6.5 5h6c1.38 0 2.5 1.12 2.5 2.5v1.4l3.2-2.02c.96-.6 2.2.08 2.2 1.2v8.84c0 1.12-1.24 1.8-2.2 1.2L15 16.1v1.4c0 1.38-1.12 2.5-2.5 2.5h-6C5.12 20 4 18.88 4 17.5v-10Z"
                            fill="currentColor"
                          />
                        </svg>
                        <span>Meet</span>
                      </button>
                    )}
                  </div>
                </div>
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
                  {isCalendarEventSelected && selectedMeeting.meetLink && (
                    <button
                      type="button"
                      className="meeting-meet-button"
                      onClick={() => openMeetLink(selectedMeeting.meetLink)}
                    >
                      Open Meet
                    </button>
                  )}
                  {!isCalendarEventSelected && (
                    <button
                      type="button"
                      className={`meeting-transcript-toggle${isTranscriptPanelOpen ? ' is-open' : ''}`}
                      onClick={() => setIsTranscriptPanelOpen((prev) => !prev)}
                      aria-label={isTranscriptPanelOpen ? 'Hide transcript panel' : 'Open transcript panel'}
                      aria-pressed={isTranscriptPanelOpen}
                    >
                      {isTranscriptPanelOpen ? 'Hide transcript' : 'Transcript'}
                    </button>
                  )}
                  {!isCalendarEventSelected && (
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
                  )}
                </div>
              </div>
            </header>
            {renameError && <p className="recap-summary">{renameError}</p>}
            {deleteError && <p className="recap-summary">{deleteError}</p>}

            <div className="meeting-detail-summary">
              <h4>{isCalendarEventSelected ? 'Details' : 'Summary'}</h4>
              <p>{selectedMeeting.summary || (isCalendarEventSelected ? 'No details available.' : '')}</p>
              {isCalendarEventSelected && calendarTimeRange && (
                <p className="meeting-calendar-detail">{calendarTimeRange}</p>
              )}
              {isCalendarEventSelected && selectedMeeting.location && (
                <p className="meeting-calendar-detail">Location: {selectedMeeting.location}</p>
              )}
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

            {!isCalendarEventSelected ? (
              <>
                <div className="meeting-messages">
                  {selectedMeeting.messages.map((message) => (
                    <div
                      key={message.id}
                      className={`message-row ${message.role === 'assistant' ? 'assistant' : 'user'}`}
                    >
                     <div
                    className={`message-bubble${message.streaming ? ' streaming' : ''}${message.error ? ' error' : ''
                      }`}
                  >
                    <p>
                      {message.text}
                      {message.streaming ? <span className="cursor-blink">▍</span> : null}
                    </p>
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
                  )
                  
                  }
                  {/* --- NEW DROPDOWN TOGGLE --- */}
              <div className="message-mode-toggle">
                <select
                  value={messageMode}
                  onChange={(e) => setMessageMode(e.target.value)}
                  aria-label="Message Mode"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-secondary, #666)',
                    outline: 'none',
                    cursor: 'pointer',
                    padding: '4px',
                    marginRight: '8px',
                    fontSize: '0.9rem'
                  }}
                >
                <option value="qa">Ask QA</option>
                  <option value="note">Add Note</option>
                </select>
              </div>
                  <input
                    type="text"
                    placeholder={messageMode === 'qa' ? "Ask a question about this meeting..." : "Type a note to save..."}
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
              <p className="meeting-calendar-note">Google Calendar events do not have transcripts or messages yet.</p>
            )}
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
            selectedMeeting.isCalendarEvent ? (
              <p className="meeting-transcript-empty">No transcript available for Google Calendar events.</p>
            ) : (
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
            )
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


