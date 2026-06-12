import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import './MainLayout.css';
import { getSocket, connectSocket } from '../lib/socket';
import { fetchWithAuth } from '../lib/http';
import { Menu, Mic, Plus } from 'lucide-react';
import { activeMeetingIdState, isSummaryLoadingState } from '../state';

const MainLayout = () => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [captureState, setCaptureState] = React.useState('idle');
    const [captureError, setCaptureError] = React.useState('');
    const [serverMessage, setServerMessage] = React.useState('');
    const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
    const displayStreamRef = React.useRef(null);
    const audioStreamRef = React.useRef(null);
    const audioContextRef = React.useRef(null);
    const sourceNodeRef = React.useRef(null);
    const processorNodeRef = React.useRef(null);
    const socketRef = React.useRef(null);
    const activeMeetingIdRef = React.useRef(null);
    const lastMeetingIdRef = React.useRef(null);
    const cumulativeLinesRef = React.useRef([]);
    const segmentLinesRef = React.useRef([]);


    const applySummaryToCache = React.useCallback((meetingId, summary) => {
        const meetingIdString = String(meetingId);
        queryClient.setQueryData(['meeting', String(meetingId)], (current) => {
            if (!current || String(current.id) !== String(meetingId)) {
                return current;
            }
            return { ...current, summary };
        });

        queryClient.setQueriesData({ queryKey: ['meetings', 'dummy'] }, (current) => {
            const meetings = Array.isArray(current) ? current : [];
            return meetings.map((meeting) => {
                if (String(meeting.id) !== meetingIdString) {
                    return meeting;
                }
                return { ...meeting, summary };
            });
        });
    }, [queryClient]);

    const applyTranscriptStateToCache = React.useCallback((meetingId, transcriptState) => {
        const meetingIdString = String(meetingId);
        queryClient.setQueryData(['meeting', String(meetingId)], (current) => {
            if (!current || String(current.id) !== String(meetingId)) {
                return current;
            }
            return { ...current, ...transcriptState };
        });

        queryClient.setQueriesData({ queryKey: ['meetings', 'dummy'] }, (current) => {
            const meetings = Array.isArray(current) ? current : [];
            return meetings.map((meeting) => {
                if (String(meeting.id) !== meetingIdString) {
                    return meeting;
                }
                return { ...meeting, ...transcriptState };
            });
        });
    }, [queryClient]);

    React.useEffect(() => {
        const socket = getSocket() || connectSocket();

        const handleSummaryLoading = (payload) => {
            if (Number(payload?.meetingId) === Number(lastMeetingIdRef.current)) {
                isSummaryLoadingState.value = true;
            }
        };

        const handleSummaryReady = (payload) => {
            const mid = Number(payload?.meetingId);
            if (mid > 0) {
                if (mid === Number(lastMeetingIdRef.current)) {
                    isSummaryLoadingState.value = false;
                }
                applySummaryToCache(mid, payload.summary);
            }
        };

        const handleSummaryError = (payload) => {
            if (Number(payload?.meetingId) === Number(lastMeetingIdRef.current)) {
                isSummaryLoadingState.value = false;
                console.error('[summary-error]', payload.message);
            }
        };

        socket.on('meeting-summary-loading', handleSummaryLoading);
        socket.on('meeting-summary-ready', handleSummaryReady);
        socket.on('meeting-summary-error', handleSummaryError);

        return () => {
            socket.off('meeting-summary-loading', handleSummaryLoading);
            socket.off('meeting-summary-ready', handleSummaryReady);
            socket.off('meeting-summary-error', handleSummaryError);
        };
    }, [applySummaryToCache]);


    // Removes the well-known Whisper hallucination "ترجمة نانسي" in all its forms.
    // Rules applied in order:
    //   1. "ترجمة" + optional whitespace + "نانسي" (spaced or fused together)
    //   2. "نانسي" fused (no space) to the word BEFORE it  e.g. "كلامنانسي"
    //   3. "نانسي" fused (no space) to the word AFTER it   e.g. "نانسيكلام"
    //   4. "ترجمة" fused (no space) to the word BEFORE it  e.g. "كلامترجمة"
    //   5. "ترجمة" fused (no space) to the word AFTER it   e.g. "ترجمةكلام"
    //   6. "قنقر" anywhere — always a hallucination in this context
    // "نانسي" and "ترجمة" standing alone (with spaces) are intentionally NOT filtered.
    const filterWhisperHallucinations = (text) =>
        text
            .replace(/ترجمة\s*نانسي/g, '')   // rule 1: core phrase (must run first)
            .replace(/(?<=\S)نانسي/g, '')        // rule 2: نانسي fused after a word
            .replace(/نانسي(?=\S)/g, '')        // rule 3: نانسي fused before a word
            .replace(/(?<=\S)ترجمة/g, '')        // rule 4: ترجمة fused after a word
            .replace(/ترجمة(?=\S)/g, '')        // rule 5: ترجمة fused before a word
            .replace(/قنقر/g, '')                  // rule 6: قنقر unconditionally
            .replace(/\s+/g, ' ')
            .trim();

    const normalizeLine = React.useCallback((line, aiSessionId = '') => ({
        speaker: Number.isFinite(Number(line?.speaker)) ? Number(line.speaker) : -1,
        text: filterWhisperHallucinations(String(line?.text || '').trim()),
        start: line?.start ?? null,
        end: line?.end ?? null,
        detected_language: line?.detected_language ?? null,
        aiSessionId: line?.aiSessionId || aiSessionId,
    }), []);

    const appendUniqueLines = React.useCallback((baseLines, incomingLines) => {
        if (!Array.isArray(incomingLines) || incomingLines.length === 0) {
            return Array.isArray(baseLines) ? baseLines : [];
        }

        const byKey = new Map();
        
        // Add existing lines
        const existing = Array.isArray(baseLines) ? baseLines : [];
        existing.forEach((line) => {
            if (line.start !== null) {
                const key = `${line.aiSessionId || ''}:${line.start}`;
                byKey.set(key, line);
            } else {
                // If no start time, just use a random key to append it
                byKey.set(Math.random().toString(), line);
            }
        });

        // Upsert incoming lines (updates text/end time/speaker for existing segments)
        incomingLines.forEach((line) => {
            if (line.start !== null) {
                const key = `${line.aiSessionId || ''}:${line.start}`;
                byKey.set(key, line);
            } else {
                byKey.set(Math.random().toString(), line);
            }
        });

        return [...byKey.values()];
    }, []);

    const lastCacheUpdateRef = React.useRef(0);
   

    const stopCapture = React.useCallback(async () => {
        const completedMeetingId = activeMeetingIdRef.current;

        // Force a cache update on stop to ensure last lines are saved
        if (completedMeetingId) {
            queryClient.setQueryData(['meeting', String(completedMeetingId)], (current) => {
                if (!current) return current;
                return { 
                    ...current, 
                    lines: cumulativeLinesRef.current,
                    updatedAt: new Date().toISOString()
                };
            });
        }

        if (processorNodeRef.current) {
            try {
                processorNodeRef.current.disconnect();
            } catch {
                // ignore
            }
            processorNodeRef.current.onaudioprocess = null;
            processorNodeRef.current = null;
        }
        if (sourceNodeRef.current) {
            try {
                sourceNodeRef.current.disconnect();
            } catch {
                // ignore
            }
            sourceNodeRef.current = null;
        }
        if (audioContextRef.current) {
            try {
                await audioContextRef.current.close();
            } catch {
                // ignore
            }
            audioContextRef.current = null;
        }
        if (socketRef.current) {
            try {
                socketRef.current.emit('meeting-session-stop');
                socketRef.current.off('connect');
                socketRef.current.off('connect_error');
                socketRef.current.off('meeting-transcript-update');
                socketRef.current.off('meeting-session-error');
            } catch {
                // ignore
            }
            socketRef.current = null;
        }
        if (displayStreamRef.current) {
            displayStreamRef.current.getTracks().forEach((track) => track.stop());
            displayStreamRef.current = null;
        }
        if (audioStreamRef.current) {
            audioStreamRef.current.getTracks().forEach((track) => track.stop());
            audioStreamRef.current = null;
        }
        if (completedMeetingId) {
            try {
                await fetchWithAuth(`/meetings/${completedMeetingId}/complete`, { method: 'POST' });
                queryClient.invalidateQueries({ queryKey: ['meetings', 'recent', 3] });
                queryClient.invalidateQueries({ queryKey: ['meetings', 'dummy'] });
                queryClient.invalidateQueries({ queryKey: ['meeting', String(completedMeetingId)] });
            } catch (error) {
                setCaptureError(error?.message || 'Failed to finalize meeting.');
            }
        }
        activeMeetingIdRef.current = null;
        activeMeetingIdState.value = null;
        cumulativeLinesRef.current = [];
        segmentLinesRef.current = [];
        setCaptureState('idle');
    }, [queryClient]);

    const startCapture = React.useCallback(async () => {
        setCaptureError('');
        setServerMessage('');
        setCaptureState('requesting');

        if (!window.isSecureContext) {
            setCaptureState('idle');
            setCaptureError('Screen capture requires HTTPS or 0.0.0.0.');
            return;
        }

        if (!navigator?.mediaDevices?.getDisplayMedia) {
            setCaptureState('idle');
            setCaptureError('Screen capture is not supported in this browser.');
            return;
        }

        try {
            const createResponse = await fetchWithAuth('/meetings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const createdMeeting = await createResponse.json();
            const meetingId = createdMeeting?.id;
            if (!meetingId) {
                throw new Error('Failed to create meeting.');
            }
            activeMeetingIdRef.current = meetingId;
            lastMeetingIdRef.current = meetingId;
            activeMeetingIdState.value = meetingId;
            isSummaryLoadingState.value = false;
            queryClient.setQueryData(['meeting', String(meetingId)], {
                id: meetingId,
                title: `Meeting ${meetingId}`,
                date: new Date().toISOString(),
                summary: '',
                participants: [],
                messages: [],
                actionItems: [],
                lines: [],
                bufferTranscription: '',
                bufferDiarization: '',
                asrStatus: 'active_transcription',
                updatedAt: new Date().toISOString(),
            });
            navigate(`/meetings/${meetingId}`);
            cumulativeLinesRef.current = [];
            segmentLinesRef.current = [];

            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true,
            });

            const [audioTrack] = displayStream.getAudioTracks();
            if (!audioTrack) {
                displayStream.getTracks().forEach((track) => track.stop());
                throw new Error('No audio track detected. Select a tab with audio sharing enabled.');
            }

            const audioStream = new MediaStream([audioTrack]);
            displayStreamRef.current = displayStream;
            audioStreamRef.current = audioStream;

            let socket = getSocket();
            if (!socket) {
                socket = connectSocket();
            }
            if (!socket) {
                setCaptureState('idle');
                setCaptureError('Unable to connect to meeting service.');
                return;
            }
            socketRef.current = socket;

            socket.on('connect', () => {
                console.log('[meeting-client] connected to gateway');
                setServerMessage('Connected to meeting service.');
            });
            socket.on('connect_error', (error) => {
                console.error('[meeting-client] gateway connection error', error);
                setCaptureError(error?.message || 'Unable to connect to meeting service.');
            });
            socket.on('meeting-transcript-update', (payload) => {
                const targetMeetingId = activeMeetingIdRef.current;
                if (!targetMeetingId) {
                    return;
                }
                if (!cumulativeLinesRef.current.length) {
                    const cachedMeeting = queryClient.getQueryData(['meeting', String(targetMeetingId)]);
                    const cachedLines = Array.isArray(cachedMeeting?.lines) ? cachedMeeting.lines : [];
                    if (cachedLines.length) {
                        cumulativeLinesRef.current = cachedLines;
                    }
                }

                const sessionId = String(payload?.session_id || payload?.aiSessionId || '');
                const incomingLines = (Array.isArray(payload?.lines) ? payload.lines : [])
                    .map((line) => normalizeLine(line, sessionId))
                    .filter((line) => line.text);
                const mergedLines = appendUniqueLines(cumulativeLinesRef.current, incomingLines);
                cumulativeLinesRef.current = mergedLines;
                segmentLinesRef.current = incomingLines;

                const transcriptState = {
                    aiSessionId: String(payload?.session_id || payload?.aiSessionId || ''),
                    asrStatus: String(payload?.status || payload?.asrStatus || 'active_transcription'),
                    lines: mergedLines,
                    bufferTranscription: String(payload?.buffer_transcription || ''),
                    bufferDiarization: String(payload?.buffer_diarization || ''),
                    updatedAt: new Date().toISOString(),
                };

                // const headline = mergedLines.slice(-3).map((line) => line.text).filter(Boolean).join(' ');
                // if (headline) {
                //    setServerMessage(headline);
                // }

                applyTranscriptStateToCache(targetMeetingId, transcriptState);
            });

            socket.on('meeting-session-error', (payload) => {
                const detail = typeof payload?.detail === 'string' && payload.detail
                    ? ` (${payload.detail})`
                    : '';
                setCaptureError((payload?.message || 'Meeting session error.') + detail);
            });

            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) {
                throw new Error('AudioContext is not supported in this browser.');
            }

            const audioContext = new AudioContextClass({ sampleRate: 16000 });
            await audioContext.resume();
            audioContextRef.current = audioContext;

            const sourceNode = audioContext.createMediaStreamSource(audioStream);
            sourceNodeRef.current = sourceNode;

            const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
            processorNodeRef.current = processorNode;
            processorNode.onaudioprocess = (event) => {
                const liveSocket = socketRef.current;
                if (!liveSocket || !liveSocket.connected || !activeMeetingIdRef.current) {
                    return;
                }

                const input = event.inputBuffer.getChannelData(0);
                if (!input || input.length === 0) {
                    return;
                }

                const pcm16 = new Int16Array(input.length);
                for (let i = 0; i < input.length; i += 1) {
                    const sample = Math.max(-1, Math.min(1, input[i]));
                    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                }
                liveSocket.emit('meeting-audio-pcm', pcm16);
            };

            sourceNode.connect(processorNode);
            processorNode.connect(audioContext.destination);
            socket.emit('meeting-session-start', { meetingId: Number(meetingId) });

            const [videoTrack] = displayStream.getVideoTracks();
            if (videoTrack) {
                videoTrack.addEventListener('ended', () => {
                    stopCapture();
                });
            }

            setCaptureState('capturing');
        } catch (error) {
            await stopCapture();
            setCaptureError(error?.message || 'Unable to capture tab audio.');
        }
    }, [appendUniqueLines, applyTranscriptStateToCache, navigate, normalizeLine, queryClient, stopCapture]);

    return (
        <div className="main-layout">
            <div className="topbar" role="banner">
                <div className="topbar-left">
                    <span className="brand-icon" aria-hidden="true">
                        <Mic size={18} />
                    </span>
                    <div className="project-name">meetAI</div>
                </div>
                <nav className="topbar-center topbar-nav" aria-label="Primary">
                    <NavLink
                        to="/"
                        end
                        className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                        aria-label="Home"
                    >
                        Home
                    </NavLink>
                    <NavLink
                        to="/meetings"
                        className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                        aria-label="Meetings"
                    >
                        Meetings
                    </NavLink>
                    <NavLink
                        to="/profile"
                        className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                        aria-label="Profile"
                    >
                        Profile
                    </NavLink>
                </nav>
                <div className="topbar-right">
                    {captureState === 'capturing' ? (
                        <button type="button" className="record-action-button stop" onClick={stopCapture}>
                            Stop recording
                        </button>
                    ) : (
                        <button type="button" className="record-action-button" onClick={startCapture} aria-label="Meet With AI">
                            <Plus size={16} />
                            <span className="record-action-label">Meet With AI</span>
                        </button>
                    )}
                    <button
                        type="button"
                        className="mobile-menu-toggle"
                        aria-label="Toggle navigation"
                        onClick={() => setMobileMenuOpen((open) => !open)}
                    >
                        <Menu size={20} />
                    </button>
                </div>
            </div>

            <nav className={`mobile-nav ${mobileMenuOpen ? 'open' : ''}`} aria-label="Mobile primary">
                <NavLink
                    to="/"
                    end
                    className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                    onClick={() => setMobileMenuOpen(false)}
                >
                    Home
                </NavLink>
                <NavLink
                    to="/meetings"
                    className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                    onClick={() => setMobileMenuOpen(false)}
                >
                    Meetings
                </NavLink>
                <NavLink
                    to="/profile"
                    className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                    onClick={() => setMobileMenuOpen(false)}
                >
                    Profile
                </NavLink>
            </nav>

            <main className="main-content">
                <Outlet />
            </main>
        </div>
    );
};

export default MainLayout;